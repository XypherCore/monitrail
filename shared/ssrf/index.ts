import { createDohResolver } from "./dns.ts";
import { createSsrfGuard, type GuardDependencies } from "./guard.ts";

export { canonicalHostname } from "./address.ts";
export { type GuardCode, SsrfError } from "./guard.ts";

/** Server/Worker entry point. The caller supplies trusted fetch and host policy. */
export function createMonitoringGuard(dependencies: Omit<GuardDependencies, "resolve">) {
  return createSsrfGuard({ ...dependencies, resolve: createDohResolver(dependencies.fetch) });
}
