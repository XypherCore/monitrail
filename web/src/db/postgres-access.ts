import type { SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import type { DataExecutor } from "../data/access.ts";

/** Normalize the driver's row-list result to the DAL's existing capability. */
export function postgresAccess(database: PostgresJsDatabase) {
  const executor = (connection: {
    execute(statement: SQL): PromiseLike<unknown[]>;
  }): DataExecutor => ({
    async execute(statement) {
      return { rows: Array.from(await connection.execute(statement)) };
    },
  });
  return {
    ...executor(database),
    transaction<T>(
      run: (transaction: DataExecutor) => Promise<T>,
      config?: PgTransactionConfig,
    ): Promise<T> {
      return database.transaction((transaction) => run(executor(transaction)), config);
    },
  };
}
