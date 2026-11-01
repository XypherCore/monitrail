import { createHmac } from "node:crypto";
import type { BetterAuthOptions } from "better-auth/minimal";
import { sql } from "drizzle-orm";
import type { DataExecutor } from "../data/access.ts";

type AuthRateLimitStorage = NonNullable<NonNullable<BetterAuthOptions["rateLimit"]>["customStorage"]>;

function unavailable(): Error { return new Error("Authentication rate limit unavailable."); }

function bucketIdentity(secret: string, key: string): { id: string; identifier: string } {
  const digest = createHmac("sha256", secret).update("monitrail:auth-rate:v1\0").update(key).digest();
  const identifier = `auth-rate:${digest.toString("hex")}`;
  // UUIDv8 carries application-defined opaque bits; the full HMAC remains in
  // identifier and must match on conflict, so even a UUID collision fails closed.
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return { id: `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`, identifier };
}

/**
 * Privileged pre-auth persistence: no authenticated user exists yet. Only
 * anonymous, exactly namespaced rate records may be touched. Better Auth
 * supplies its default per-path windows/maxima; no product quotas are changed.
 *
 * The consume contract in Better Auth 1.7.15 is atomic. A single PostgreSQL
 * UPSERT locks the bucket while checking/incrementing; get/set would permit
 * concurrent cold starts to bypass the limit. Expiry uses the database clock.
 * The framework's normalized IP/path is HMACed before storage. Reverse-proxy
 * header trust still belongs to the HTTP/runtime integration, not this store.
 */
export function createAuthRateLimitStorage(db: DataExecutor, secret: string): AuthRateLimitStorage {
  if (typeof secret !== "string" || secret.length < 32) throw unavailable();
  return {
    async consume(key, rule) {
      if (typeof key !== "string" || !key || !Number.isFinite(rule.window) || rule.window <= 0 ||
        rule.window > Number.MAX_SAFE_INTEGER / 1000 || !Number.isSafeInteger(rule.max) || rule.max <= 0) {
        throw unavailable();
      }
      const { id, identifier } = bucketIdentity(secret, key);
      try {
        // Small cleanup batches bound maintenance work. Repeat the expiry
        // predicate outside the subquery so a concurrently refreshed bucket
        // cannot be deleted after waiting for its row lock.
        await db.execute(sql`DELETE FROM verification
          WHERE user_id IS NULL AND identifier ~ '^auth-rate:[0-9a-f]{64}$'
            AND expires_at <= clock_timestamp()
            AND id IN (SELECT id FROM verification
              WHERE user_id IS NULL AND identifier ~ '^auth-rate:[0-9a-f]{64}$'
                AND expires_at <= clock_timestamp()
              ORDER BY expires_at,id LIMIT 100)`);
        const result = await db.execute(sql`INSERT INTO verification(id,identifier,value,expires_at,created_at,updated_at)
          SELECT ${id}::uuid,${identifier},
            jsonb_build_object('count',1,'lastRequest',floor(extract(epoch FROM stamp.now)*1000)::bigint,'allowed',true)::text,
            stamp.now + ${rule.window}::double precision * interval '1 second',stamp.now,stamp.now
          FROM (SELECT clock_timestamp() AS now) stamp
          ON CONFLICT(id) DO UPDATE SET (value,expires_at,updated_at) = (
            SELECT
              CASE
                WHEN verification.expires_at <= step.now THEN jsonb_build_object('count',1,'lastRequest',floor(extract(epoch FROM step.now)*1000)::bigint,'allowed',true)
                WHEN (verification.value::jsonb->>'count')::bigint < ${rule.max} THEN jsonb_build_object('count',(verification.value::jsonb->>'count')::bigint+1,'lastRequest',floor(extract(epoch FROM step.now)*1000)::bigint,'allowed',true)
                ELSE jsonb_set(verification.value::jsonb,'{allowed}','false'::jsonb)
              END::text,
              CASE WHEN verification.expires_at <= step.now OR (verification.value::jsonb->>'count')::bigint < ${rule.max}
                THEN step.now + ${rule.window}::double precision * interval '1 second' ELSE verification.expires_at END,
              CASE WHEN verification.expires_at <= step.now OR (verification.value::jsonb->>'count')::bigint < ${rule.max}
                THEN step.now ELSE verification.updated_at END
            FROM (SELECT clock_timestamp() AS now) step
          )
          WHERE verification.identifier=excluded.identifier AND verification.user_id IS NULL
          RETURNING (value::jsonb->>'allowed')::boolean AS allowed,
            CASE WHEN (value::jsonb->>'allowed')::boolean THEN NULL
              ELSE greatest(1,ceil(extract(epoch FROM expires_at-clock_timestamp())))::integer END AS "retryAfter"`);
        if (result.rows.length !== 1) throw unavailable();
        const row = result.rows[0];
        if (!row || typeof row !== "object" || !("allowed" in row) || !("retryAfter" in row)) throw unavailable();
        if (row.allowed === true && row.retryAfter === null) return { allowed: true, retryAfter: null };
        if (row.allowed === false && typeof row.retryAfter === "number" && Number.isSafeInteger(row.retryAfter) && row.retryAfter > 0) {
          return { allowed: false, retryAfter: row.retryAfter };
        }
        throw unavailable();
      } catch {
        // No driver exceptions, connection strings or limiter keys escape.
        throw unavailable();
      }
    },
  };
}
