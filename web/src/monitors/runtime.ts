import "server-only";
import { readAuthConfig } from "../auth/config.ts";
import { getAuthRuntime } from "../auth/runtime.ts";
import { createMonitorAccess } from "../data/monitor-access.ts";
import { getRuntimeDatabase } from "../db/runtime.ts";
import { reserveManagementWrite } from "../security/management-rate.ts";
import { invalidateStatusSlugs } from "../status-pages/public-runtime.ts";
import { mapMonitorError } from "./errors.ts";
import { createMonitorHandlers } from "./http.ts";
import { isMonitorId } from "./input.ts";

export const monitorHandlers = createMonitorHandlers({
  origin: () => readAuthConfig(process.env, process.env.NODE_ENV === "production").baseURL,
  mapError: mapMonitorError,
  async authenticate(request, origin) {
    if (!request.headers.has("cookie")) return null;
    const session = await getAuthRuntime().api.getSession({
      headers: request.headers,
      query: { disableRefresh: true },
    });
    if (!session || !isMonitorId(session.user.id)) return null;
    const db = getRuntimeDatabase();
    await reserveManagementWrite(db, session.user.id);
    return createMonitorAccess(db, session.user.id, origin, undefined, invalidateStatusSlugs);
  },
});
