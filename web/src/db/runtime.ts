import "server-only";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { postgresOptions, readRuntimePostgresUrl } from "./postgres-config.ts";
import { postgresAccess } from "./postgres-access.ts";

let database: ReturnType<typeof postgresAccess> | undefined;

// Server-only connection plumbing, used solely by auth persistence and the DAL.
export function getRuntimeDatabase() {
  if (!database) {
    const client = postgres(readRuntimePostgresUrl(process.env.DATABASE_URL), postgresOptions());
    database = postgresAccess(drizzle(client));
  }
  return database;
}
