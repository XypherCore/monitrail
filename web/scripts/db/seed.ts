import { drizzle } from "drizzle-orm/neon-serverless";
import { openNeonPool, reportDatabaseFailure } from "./connection.ts";
import { seedFixtures } from "./fixtures.ts";

if (!process.argv.includes("--confirm-test-data") || process.env.NODE_ENV === "production") {
  console.error("Seed is development-only. Use --confirm-test-data on a disposable branch.");
  process.exitCode = 1;
} else {
  let pool: ReturnType<typeof openNeonPool> | undefined;
  try {
    pool = openNeonPool();
    await drizzle(pool).transaction(tx => seedFixtures(tx));
    console.log("Fake development data seeded; existing records were preserved.");
  } catch {
    reportDatabaseFailure("Development seed");
  } finally {
    await pool?.end();
  }
}
