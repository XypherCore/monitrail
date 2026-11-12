import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { DataExecutor } from "../data/access.ts";

export const CHANNEL_LIMIT = 3;
type AlertAccessCode =
	| "invalid"
	| "unavailable"
	| "channel_limit"
	| "rate_limit"
	| "telegram_unavailable";
export class AlertAccessError extends Error {
	readonly code: AlertAccessCode;
	readonly retryAfterSeconds?: number;

	constructor(code: AlertAccessCode, retryAfterSeconds?: number) {
		super("Alert channel operation could not be completed.");
		this.code = code;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export function hashTelegramCode(code: string): string {
	return createHash("sha256").update(code).digest("hex");
}

export async function alertRows<Row>(
	db: DataExecutor,
	statement: SQL,
): Promise<Row[]> {
	return (await db.execute(statement)).rows as Row[];
}

export async function withAlertOwner<T>(
	db: DataExecutor,
	userId: string,
	run: (tx: DataExecutor) => Promise<T>,
): Promise<T> {
	if (!db.transaction) throw new AlertAccessError("unavailable");
	try {
		return await db.transaction(
			async (tx) => {
				await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
				await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
				await tx.execute(
					sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`,
				);
				return run(tx);
			},
			{ isolationLevel: "read committed" },
		);
	} catch (error) {
		if (error instanceof AlertAccessError) throw error;
		throw new AlertAccessError("unavailable");
	}
}

export async function hasChannelSpace(db: DataExecutor, ownerId: string) {
	const [row] = await alertRows<{ count: number }>(
		db,
		sql`
    SELECT count(*)::int AS count FROM alert_channels WHERE user_id=${ownerId}
  `,
	);
	return row.count < CHANNEL_LIMIT;
}
