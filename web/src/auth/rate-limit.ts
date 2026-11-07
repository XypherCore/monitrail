import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { canonicalPolicyHost } from "../../../shared/ssrf/address.ts";
import type { AuthDatabase } from "./persistence.ts";

const unavailable = () => new Error("Authentication rate limit unavailable.");
const oauthStateSeconds = 900; // Auth.js state and PKCE cookie lifetime.

export function oauthSignInRateKey(
  headers: Headers,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  // Vercel's ingress supplies this header. Vercel CLI development and other
  // hosts may forward caller-supplied headers, so use the anonymous bucket there.
  // https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for
  const onVercel =
    env.NODE_ENV === "production" &&
    env.VERCEL === "1" &&
    !!env.VERCEL_REGION &&
    (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview");
  const value = onVercel ? headers.get("x-vercel-forwarded-for") : null;
  const ip = value && isIP(value) ? canonicalPolicyHost(value) : null;
  return `${ip ?? "anonymous"}|/sign-in/social`;
}

export function createAuthRateLimitStorage(db: AuthDatabase, secret: string) {
  if (typeof secret !== "string" || secret.length < 32) throw unavailable();

  function identity(key: string) {
    return `auth-rate:${createHmac("sha256", secret)
      .update("monitrail:auth-rate:v1\0")
      .update(key)
      .digest("hex")}`;
  }

  return {
    async consume(key: string, rule: { window: number; max: number }) {
      if (
        !key ||
        !Number.isSafeInteger(rule.window) ||
        rule.window <= 0 ||
        !Number.isSafeInteger(rule.max) ||
        rule.max <= 0
      )
        throw unavailable();
      const bucket = identity(key);
      try {
        return await db.transaction(async (transaction) => {
          await transaction.execute(sql`SET LOCAL lock_timeout = '2s'`);
          await transaction.execute(sql`SET LOCAL statement_timeout = '5s'`);
          await transaction.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${bucket},0))`,
          );
          const result = await transaction.execute(sql`SELECT count,
            greatest(1,ceil(extract(epoch FROM window_start +
              ${rule.window}::double precision * interval '1 second' - clock_timestamp())))::integer AS remaining,
            window_start + ${rule.window}::double precision * interval '1 second' > clock_timestamp() AS active
            FROM rate_limits WHERE key=${bucket} FOR UPDATE`);
          const current = result.rows[0] as
            | { count: number; remaining: number; active: boolean }
            | undefined;
          if (current?.active && current.count >= rule.max) {
            return { allowed: false, retryAfter: current.remaining };
          }
          const count = current?.active ? current.count + 1 : 1;
          await transaction.execute(sql`DELETE FROM rate_limits WHERE key=${bucket}`);
          await transaction.execute(sql`INSERT INTO rate_limits(key,window_start,count)
            VALUES(${bucket},clock_timestamp(),${count})`);
          return { allowed: true, retryAfter: null };
        });
      } catch {
        throw unavailable();
      }
    },

    async reserveOAuthState(hash: string) {
      if (!/^[0-9a-f]{64}$/.test(hash)) throw unavailable();
      try {
        await db.execute(sql`INSERT INTO rate_limits(key,window_start,count)
          VALUES(${`oauth-state:${hash}`},clock_timestamp(),0)`);
      } catch {
        throw unavailable();
      }
    },

    async consumeOAuthState(hash: string): Promise<boolean> {
      if (!/^[0-9a-f]{64}$/.test(hash)) throw unavailable();
      try {
        const result = await db.execute(sql`UPDATE rate_limits SET count=1
          WHERE key=${`oauth-state:${hash}`} AND count=0
            AND window_start > clock_timestamp() - ${oauthStateSeconds} * interval '1 second'
          RETURNING key`);
        return result.rows.length === 1;
      } catch {
        throw unavailable();
      }
    },
  };
}
