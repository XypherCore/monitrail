import { isMonitorId } from "../monitors/input.ts";
import type { StatusPageFields, StatusPageSelection } from "./contracts.ts";

export const MAX_STATUS_PAGES = 3;
export const MAX_STATUS_MONITORS = 10;

const reservedSlugs = new Set([
	"admin",
	"api",
	"auth",
	"bot",
	"channels",
	"dashboard",
	"health",
	"login",
	"logout",
	"monitors",
	"new",
	"settings",
	"status",
	"status-pages",
	"support",
	"www",
]);

export function isStatusSlug(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[a-z0-9-]{3,40}$/.test(value) &&
		!reservedSlugs.has(value)
	);
}

function object(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function parseStatusPageFields(value: unknown): StatusPageFields | null {
	const input = object(value);
	if (!input || Object.keys(input).length !== 3) return null;
	const { title, slug, monitors } = input;
	if (
		typeof title !== "string" ||
		!title.trim() ||
		/\p{Cc}/u.test(title) ||
		!isStatusSlug(slug) ||
		!Array.isArray(monitors) ||
		monitors.length > MAX_STATUS_MONITORS
	)
		return null;

	const selection: StatusPageSelection[] = [];
	const ids = new Set<string>();
	for (const entry of monitors) {
		const row = object(entry);
		if (
			!row ||
			Object.keys(row).length !== 2 ||
			!isMonitorId(row.monitorId) ||
			typeof row.showUrl !== "boolean"
		)
			return null;
		const id = row.monitorId.toLowerCase();
		if (ids.has(id)) return null;
		ids.add(id);
		selection.push({ monitorId: id, showUrl: row.showUrl });
	}
	return { title: title.trim(), slug, monitors: selection };
}

export function parseStatusPagePatch(
	value: unknown,
): { isPublished: boolean } | { fields: StatusPageFields } | null {
	const input = object(value);
	if (
		input &&
		Object.keys(input).length === 1 &&
		typeof input.isPublished === "boolean"
	)
		return { isPublished: input.isPublished };
	const fields = parseStatusPageFields(value);
	return fields ? { fields } : null;
}
