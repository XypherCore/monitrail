import {
	alertPrivateHeaders as privateHeaders,
	AlertRequestError as RequestError,
	readAlertJson as readJson,
	requireEmptyAlertBody as requireEmptyBody,
} from "../alerts/request-json.ts";
import { isMonitorId } from "../monitors/input.ts";
import { MANAGEMENT_WRITE_LIMIT, ManagementRateError } from "../security/management-rate.ts";
import type { StatusPageMutation } from "./contracts.ts";
import {
	MAX_STATUS_PAGES,
	parseStatusPageFields,
	parseStatusPagePatch,
} from "./input.ts";
import { type StatusPageOwner, StatusPageOwnerError } from "./owner.ts";

type Dependencies = {
	origin(): string;
	authenticate(
		request: Request,
		origin: string,
	): Promise<StatusPageOwner | null>;
	invalidate(slugs: readonly string[]): void | Promise<void>;
};

const headers = { ...privateHeaders, vary: "Cookie" };
const invalid = () => failure(400, "Enter valid status page settings.");
const missing = () => failure(404, "Status page or monitor not found.");
const unavailable = () =>
	failure(503, "Status pages are temporarily unavailable. Try again.");

function failure(status: number, message: string) {
	return Response.json({ error: { message } }, { status, headers });
}

export function createStatusPageHandlers(deps: Dependencies) {
	async function run(
		request: Request,
		method: "POST" | "PATCH" | "DELETE",
		action: (owner: StatusPageOwner) => Promise<StatusPageMutation | null>,
	) {
		if (request.method !== method) {
			const response = failure(405, "Unsupported request method.");
			response.headers.set("allow", method);
			return response;
		}
		try {
			const origin = deps.origin();
			if (request.headers.get("origin") !== origin)
				return failure(403, "This request must come from the app.");
			const owner = await deps.authenticate(request, origin);
			if (!owner) return failure(401, "Sign in to manage status pages.");
			const changed = await action(owner);
			if (!changed) return missing();
			try {
				await deps.invalidate(changed.affectedSlugs);
			} catch {
				// The write has committed. The public route reads visibility from the database.
			}
			return Response.json(
				{ id: changed.id, slug: changed.slug },
				{ status: method === "POST" ? 201 : 200, headers },
			);
		} catch (error) {
			if (error instanceof ManagementRateError) {
				const response = failure(429, `You can make up to ${MANAGEMENT_WRITE_LIMIT} management changes per hour. Try again in ${error.retryAfterSeconds} seconds.`);
				response.headers.set("retry-after", String(error.retryAfterSeconds));
				return response;
			}
			if (error instanceof RequestError)
				return failure(error.status, "Invalid status page request.");
			if (!(error instanceof StatusPageOwnerError)) return unavailable();
			switch (error.code) {
				case "invalid":
					return invalid();
				case "page_limit":
					return failure(
						409,
						`You can have up to ${MAX_STATUS_PAGES} status pages.`,
					);
				case "slug_unavailable":
					return failure(409, "This status page slug is unavailable.");
				case "empty_page":
					return failure(409, "Add a monitor before publishing.");
				default:
					return unavailable();
			}
		}
	}

	return {
		create: (request: Request) =>
			run(request, "POST", async (owner) => {
				const fields = parseStatusPageFields(await readJson(request));
				if (!fields) throw new StatusPageOwnerError("invalid");
				return owner.create(fields);
			}),
		update: (request: Request, id: string) =>
			run(request, "PATCH", async (owner) => {
				if (!isMonitorId(id)) return null;
				const patch = parseStatusPagePatch(await readJson(request));
				if (!patch) throw new StatusPageOwnerError("invalid");
				return "fields" in patch
					? owner.update(id, patch.fields)
					: owner.setPublished(id, patch.isPublished);
			}),
		remove: (request: Request, id: string) =>
			run(request, "DELETE", async (owner) => {
				if (!isMonitorId(id)) return null;
				await requireEmptyBody(request);
				return owner.remove(id);
			}),
	};
}
