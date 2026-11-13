import "server-only";
import { readAuthConfig } from "../auth/config.ts";
import { getAuthRuntime } from "../auth/runtime.ts";
import { getRuntimeDatabase } from "../db/runtime.ts";
import { isMonitorId } from "../monitors/input.ts";
import { createStatusPageOwner } from "./owner.ts";
import { createStatusPageHandlers } from "./owner-http.ts";
import { invalidateStatusSlugs } from "./public-runtime.ts";

export const statusPageHandlers = createStatusPageHandlers({
	origin: () =>
		readAuthConfig(process.env, process.env.NODE_ENV === "production").baseURL,
	async authenticate(request) {
		if (!request.headers.has("cookie")) return null;
		const session = await getAuthRuntime().api.getSession({
			headers: request.headers,
			query: { disableRefresh: true },
		});
		if (!session || !isMonitorId(session.user.id)) return null;
		return createStatusPageOwner(getRuntimeDatabase(), session.user.id);
	},
	invalidate: invalidateStatusSlugs,
});
