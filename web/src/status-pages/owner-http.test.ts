import { describe, expect, it, vi } from "vitest";
import { isStatusSlug, parseStatusPageFields } from "./input.ts";
import { StatusPageOwnerError } from "./owner.ts";
import { createStatusPageHandlers } from "./owner-http.ts";

const origin = "https://app.example.invalid";
const id = "10000000-0000-4000-8000-000000000001";
const slug = "our-services";
const fields = {
	title: "Our services",
	slug,
	monitors: [{ monitorId: id, showUrl: false }],
};

function setup() {
	const mutation = { id, slug, affectedSlugs: ["old-services", slug] };
	const access = {
		create: vi.fn(async () => mutation),
		update: vi.fn(async () => mutation),
		setPublished: vi.fn(async () => mutation),
		remove: vi.fn(async () => mutation),
	};
	const authenticate = vi.fn(async () => access);
	const invalidate = vi.fn(async () => {});
	const handlers = createStatusPageHandlers({
		origin: () => origin,
		authenticate,
		invalidate,
	});
	return { handlers, access, authenticate, invalidate };
}

function request(method: string, payload?: unknown, from = origin) {
	return new Request(`${origin}/api/status-pages`, {
		method,
		headers: { origin: from, "content-type": "application/json" },
		body: payload === undefined ? undefined : JSON.stringify(payload),
	});
}

describe("status page input", () => {
	it("enforces the exact slug syntax and reserved names", () => {
		for (const invalid of [
			"ab",
			"a".repeat(41),
			"Upper",
			"space here",
			"a_b",
			"../path",
		]) {
			expect(isStatusSlug(invalid)).toBe(false);
		}
		for (const reserved of [
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
		]) {
			expect(isStatusSlug(reserved)).toBe(false);
		}
		expect(isStatusSlug("one-2")).toBe(true);
		expect(isStatusSlug("a".repeat(40))).toBe(true);
	});

	it("rejects unknown keys, duplicates and an oversized monitor selection", () => {
		expect(
			parseStatusPageFields({ ...fields, title: "  Our services  " }),
		).toEqual(fields);
		expect(parseStatusPageFields({ ...fields, title: "\u0000" })).toBeNull();
		expect(parseStatusPageFields({ ...fields, userId: id })).toBeNull();
		expect(
			parseStatusPageFields({
				...fields,
				monitors: [fields.monitors[0], fields.monitors[0]],
			}),
		).toBeNull();
		expect(
			parseStatusPageFields({
				...fields,
				monitors: Array.from({ length: 11 }, (_, i) => ({
					monitorId: id.slice(0, -2) + (10 + i),
					showUrl: false,
				})),
			}),
		).toBeNull();
		expect(
			parseStatusPageFields({ ...fields, monitors: [{ monitorId: id }] }),
		).toBeNull();
	});
});

describe("status page owner HTTP", () => {
	it("rejects invalid origin, unauthenticated sessions and unsupported methods", async () => {
		const { handlers, authenticate, access } = setup();
		expect(
			(
				await handlers.create(
					request("POST", fields, "https://other.example.invalid"),
				)
			).status,
		).toBe(403);
		expect(authenticate).not.toHaveBeenCalled();
		const unauthenticated = createStatusPageHandlers({
			origin: () => origin,
			authenticate: async () => null,
			invalidate: () => {},
		});
		expect((await unauthenticated.create(request("POST", fields))).status).toBe(
			401,
		);
		const response = await handlers.create(request("GET"));
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
		expect(access.create).not.toHaveBeenCalled();
	});

	it("invalidates only successful mutations and returns only the public slug and owner page ID", async () => {
		const { handlers, invalidate, access } = setup();
		const created = await handlers.create(request("POST", fields));
		expect(created.status).toBe(201);
		expect(created.headers.get("cache-control")).toContain("no-store");
		expect(await created.json()).toEqual({ id, slug });
		expect(access.create).toHaveBeenCalledWith(fields);
		expect(invalidate).toHaveBeenCalledWith(["old-services", slug]);
		expect(
			(await handlers.update(request("PATCH", { isPublished: true }), id))
				.status,
		).toBe(200);
		expect(access.setPublished).toHaveBeenCalledWith(id, true);
		expect((await handlers.update(request("PATCH", fields), id)).status).toBe(
			200,
		);
		expect(access.update).toHaveBeenCalledWith(id, fields);
		expect((await handlers.remove(request("DELETE"), id)).status).toBe(200);
		expect(access.remove).toHaveBeenCalledWith(id);
		expect(invalidate).toHaveBeenCalledTimes(4);
	});

	it("bounds request bodies and keeps errors generic", async () => {
		const { handlers, invalidate, access } = setup();
		expect(
			(
				await handlers.create(
					request("POST", { ...fields, title: "a".repeat(9000) }),
				)
			).status,
		).toBe(413);
		expect(
			(await handlers.update(request("PATCH", { isPublished: "true" }), id))
				.status,
		).toBe(400);
		expect((await handlers.remove(request("DELETE", {}), id)).status).toBe(400);
		expect(
			(await handlers.update(request("PATCH", fields), "not-an-id")).status,
		).toBe(404);
		access.create.mockRejectedValueOnce(
			new StatusPageOwnerError("slug_unavailable"),
		);
		expect((await handlers.create(request("POST", fields))).status).toBe(409);
		access.update.mockRejectedValueOnce(
			new Error("sensitive database diagnostic"),
		);
		const failed = await handlers.update(request("PATCH", fields), id);
		expect(failed.status).toBe(503);
		expect(await failed.text()).not.toContain("sensitive");
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("reports the committed mutation if cache signaling fails", async () => {
		const { handlers, invalidate, access } = setup();
		invalidate.mockRejectedValueOnce(new Error("cache unavailable"));
		const response = await handlers.update(
			request("PATCH", { isPublished: false }),
			id,
		);
		expect(access.setPublished).toHaveBeenCalledWith(id, false);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ id, slug });
	});
});
