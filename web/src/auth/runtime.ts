import "server-only";
import { getRuntimeDatabase } from "../db/runtime.ts";
import { readAuthConfig } from "./config.ts";
import { createAuthCore } from "./core.ts";

let runtime: ReturnType<typeof createAuthCore> | undefined;
export function getAuthRuntime() {
  if (!runtime) {
    const config = readAuthConfig(process.env, process.env.NODE_ENV === "production");
    runtime = createAuthCore(getRuntimeDatabase(), config);
  }
  return runtime;
}
