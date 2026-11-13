import type { PublicStatusDetails, PublicStatusSnapshot } from "./contracts.ts";

export const STATUS_CACHE_SECONDS = 60;

export function statusTag(slug: string): string {
	return `status:${slug}`;
}

export function statusDetailsKey(
	snapshot: PublicStatusSnapshot,
	now: Date,
): string[] {
	const minute = Math.floor(now.getTime() / (STATUS_CACHE_SECONDS * 1_000));
	const monitorVersions = snapshot.monitors.map(({ id, revision }) => [
		id,
		revision,
	]);
	return [
		"public-status-details",
		snapshot.slug,
		snapshot.pageId,
		JSON.stringify(monitorVersions),
		String(minute),
	];
}

type StatusReader = {
	readSnapshot(slug: string, now: Date): Promise<PublicStatusSnapshot | null>;
	readDetails(
		snapshot: PublicStatusSnapshot,
		now: Date,
	): Promise<PublicStatusDetails>;
	cacheDetails(
		key: string[],
		tag: string,
		load: () => Promise<PublicStatusDetails>,
	): Promise<PublicStatusDetails>;
};

export async function readStatusWithCachedDetails(
	slug: string,
	now: Date,
	reader: StatusReader,
) {
	// Publication, membership, state and URL visibility come from the current read.
	const snapshot = await reader.readSnapshot(slug, now);
	if (!snapshot?.monitors.length) return null;
	// Time and row versions fence off expired data and late fills after a mutation.
	const details = await reader.cacheDetails(
		statusDetailsKey(snapshot, now),
		statusTag(slug),
		() => reader.readDetails(snapshot, now),
	);
	return { snapshot, details };
}
