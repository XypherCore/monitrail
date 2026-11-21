import { sql } from "drizzle-orm";
import type { DataExecutor } from "../data/access.ts";
import { reserveRollingLimits } from "../data/rolling-rate.ts";
import { isMonitorId } from "../monitors/input.ts";

export const MANAGEMENT_WRITE_LIMIT = 60;
export const ACCOUNT_DELETION_LIMIT = 3;
const WINDOW_SECONDS = 3600;

export class ManagementRateError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("The hourly request limit was reached.");
    this.name = "ManagementRateError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function reserve(db: DataExecutor, userId: string, keyPrefix: string, limit: number): Promise<void> {
  if (!isMonitorId(userId) || !db.transaction) throw new Error("Request budget is temporarily unavailable.");
  const owner = userId.toLowerCase();
  let retry: number | null;
  try {
    retry = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${owner}::text,0))`);
      const account = await tx.execute(sql`SELECT id FROM users WHERE id=${owner} FOR KEY SHARE`);
      if (account.rows.length !== 1) throw new Error();
      return reserveRollingLimits(tx, [{ key: `${keyPrefix}:${owner}`, limit }], WINDOW_SECONDS);
    }, { isolationLevel: "read committed" });
  } catch {
    throw new Error("Request budget is temporarily unavailable.");
  }
  if (retry !== null) throw new ManagementRateError(retry);
}

/** Call after session and Origin validation, before the mutation's transaction. */
export function reserveManagementWrite(db: DataExecutor, userId: string): Promise<void> {
  return reserve(db, userId, "management-write", MANAGEMENT_WRITE_LIMIT);
}

/** Account deletion has its own budget and does not consume management writes. */
export function reserveAccountDeletion(db: DataExecutor, userId: string): Promise<void> {
  return reserve(db, userId, "account-delete", ACCOUNT_DELETION_LIMIT);
}
