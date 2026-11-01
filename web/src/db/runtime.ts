import "server-only";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

let database: ReturnType<typeof drizzle> | undefined;

// Server-only connection plumbing, used solely by auth persistence and the DAL.
export function getRuntimeDatabase() {
  if (!database) {
    const value = process.env.DATABASE_URL;
    try {
      const parsed = new URL(value ?? "");
      if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname.endsWith(".neon.tech")) throw new Error();
    } catch { throw new Error("Database configuration is unavailable."); }
    const pool = new Pool({ connectionString: value, max: 3, connectionTimeoutMillis: 10000 });
    pool.on("error", () => { console.error("Database connection unavailable."); });
    database = drizzle(pool);
  }
  return database;
}
