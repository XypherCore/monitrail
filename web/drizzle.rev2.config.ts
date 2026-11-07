import { defineConfig } from "drizzle-kit";

// This independent migration track targets a fresh rev 2 database.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/rev2-schema.ts",
  out: "./drizzle-rev2",
  strict: true,
  verbose: false,
});
