import { sql } from "drizzle-orm";
import type { DataExecutor } from "../data/access.ts";
import { createDogfoodEvidenceCapability } from "../services/dogfood-evidence.ts";
import { readDogfoodMonitorIds } from "./dogfood-http.ts";

/** Narrow service for the signed proof collector, with a server-owned window. */
export function createRollingDogfoodEvidenceCapability(db: DataExecutor) {
  return {
    async capture(monitorIds: string[]) {
      try {
        const ids = readDogfoodMonitorIds(monitorIds.join(","));
        // Reading the database clock before the export keeps its exclusive upper
        // bound no later than the export transaction, even when web clocks skew.
        const { rows } = await db.execute(sql`SELECT clock_timestamp()::text AS at`);
        const raw = (rows[0] as { at?: unknown } | undefined)?.at;
        if (typeof raw !== "string" && !(raw instanceof Date)) throw new Error();
        const to = new Date(raw);
        if (!Number.isFinite(to.getTime())) throw new Error();
        const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
        return await createDogfoodEvidenceCapability(db).exportDogfoodEvidence({ monitorIds: ids, from: from.toISOString(), to: to.toISOString() });
      } catch {
        throw new Error("Dogfood evidence could not be captured.");
      }
    },
  };
}
