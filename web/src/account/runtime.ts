import "server-only";
import { readAuthConfig } from "../auth/config.ts";
import { getAuthRuntime } from "../auth/runtime.ts";
import { createDataAccess } from "../data/access.ts";
import { getRuntimeDatabase } from "../db/runtime.ts";
import { isMonitorId } from "../monitors/input.ts";
import { invalidateStatusSlugs } from "../status-pages/public-runtime.ts";
import { createAccountDeletionHandler } from "./http.ts";

export const deleteAccountHandler = createAccountDeletionHandler({
  origin: () => readAuthConfig(process.env, process.env.NODE_ENV === "production").baseURL,
  async authenticate(request) {
    if (!request.headers.has("cookie")) return null;
    const session = await getAuthRuntime().api.getSession({
      headers: request.headers,
      query: { disableRefresh: true },
    });
    if (!session || !isMonitorId(session.user.id)) return null;
    return createDataAccess(getRuntimeDatabase(), session.user.id, undefined, invalidateStatusSlugs);
  },
});
