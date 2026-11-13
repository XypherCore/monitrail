import { describe, expect, it, vi } from "vitest";
import {
	readStatusWithCachedDetails,
	statusDetailsKey,
	statusTag,
} from "./cache.ts";
import type { PublicStatusDetails, PublicStatusSnapshot } from "./contracts.ts";

const now = new Date("2026-11-12T10:18:00.000Z");
const snapshot = (revision = "1"): PublicStatusSnapshot => ({
	pageId: "page-id",
	slug: "service-status",
	title: "Service status",
	monitors: [
		{
			id: "monitor-id",
			revision,
			name: "Service",
			status: "up",
			url: "https://example.test/",
		},
	],
});
const details = (cause: string): PublicStatusDetails => ({
	daysByMonitor: {},
	incidents: [
		{
			monitorId: "monitor-id",
			startedAt: now.toISOString(),
			resolvedAt: null,
			cause,
		},
	],
});

function fixture() {
	let live: PublicStatusSnapshot | null = snapshot();
	const cache = new Map<string, PublicStatusDetails>();
	const readSnapshot = vi.fn(async () => live);
	const readDetails = vi.fn(async () => details("timeout"));
	const cacheDetails = vi.fn(
		async (
			key: string[],
			_tag: string,
			load: () => Promise<PublicStatusDetails>,
		) => {
			const encoded = JSON.stringify(key);
			const existing = cache.get(encoded);
			if (existing) return existing;
			const next = await load();
			cache.set(encoded, next);
			return next;
		},
	);
	return {
		setLive(next: PublicStatusSnapshot | null) {
			live = next;
		},
		readSnapshot,
		readDetails,
		cacheDetails,
		read(time = now) {
			return readStatusWithCachedDetails("service-status", time, {
				readSnapshot,
				readDetails,
				cacheDetails,
			});
		},
	};
}

describe("public status history cache", () => {
	it("uses the slug tag and a hard minute boundary in the history key", () => {
		const first = snapshot();
		expect(statusTag(first.slug)).toBe("status:service-status");
		expect(statusDetailsKey(first, now)).toEqual(
			statusDetailsKey(first, new Date(+now + 59_999)),
		);
		expect(statusDetailsKey(first, now)).not.toEqual(
			statusDetailsKey(first, new Date(+now + 60_000)),
		);
		expect(statusDetailsKey(first, now)).not.toEqual(
			statusDetailsKey({ ...first, pageId: "new-page-id" }, now),
		);
		expect(statusDetailsKey(first, now)).not.toEqual(
			statusDetailsKey(snapshot("2"), now),
		);
		const reordered = {
			...first,
			monitors: [...first.monitors, { ...first.monitors[0], id: "second-id" }],
		};
		expect(statusDetailsKey(reordered, now)).not.toEqual(
			statusDetailsKey(
				{ ...reordered, monitors: reordered.monitors.toReversed() },
				now,
			),
		);
	});

	it("uses current publication, status and URL visibility even with a warm history cache", async () => {
		const f = fixture();
		expect((await f.read())?.snapshot.monitors[0].url).toBe(
			"https://example.test/",
		);
		const updated = snapshot();
		updated.title = "Renamed status";
		updated.monitors[0].status = "paused";
		delete updated.monitors[0].url;
		f.setLive(updated);
		expect(await f.read()).toEqual({
			snapshot: updated,
			details: details("timeout"),
		});
		expect(f.readSnapshot).toHaveBeenCalledTimes(2);
		expect(f.readDetails).toHaveBeenCalledOnce();
		f.setLive({ ...updated, monitors: [] });
		expect(await f.read()).toBeNull();
		f.setLive(null);
		expect(await f.read()).toBeNull();
		expect(f.cacheDetails).toHaveBeenCalledTimes(2);
	});

	it("starts fresh after the time boundary even if the old cache entry is still present", async () => {
		const f = fixture();
		expect((await f.read())?.details).toEqual(details("timeout"));
		f.readDetails.mockResolvedValue(details("tls"));
		expect((await f.read(new Date(+now + 59_999)))?.details).toEqual(
			details("timeout"),
		);
		expect((await f.read(new Date(+now + 60_000)))?.details).toEqual(
			details("tls"),
		);
	});

	it("keeps a late cache fill unreachable after a monitor revision changes", async () => {
		const f = fixture();
		const oldHistory = Promise.withResolvers<PublicStatusDetails>();
		const oldStarted = Promise.withResolvers<void>();
		f.readDetails.mockImplementationOnce(async () => {
			oldStarted.resolve();
			return oldHistory.promise;
		});
		const earlier = f.read();
		await oldStarted.promise;

		f.setLive(snapshot("2"));
		f.readDetails.mockResolvedValue(details("tls"));
		expect((await f.read())?.details).toEqual(details("tls"));
		oldHistory.resolve(details("timeout"));
		expect((await earlier)?.details).toEqual(details("timeout"));
		expect((await f.read())?.details).toEqual(details("tls"));
		expect(f.readDetails).toHaveBeenCalledTimes(2);
	});
});
