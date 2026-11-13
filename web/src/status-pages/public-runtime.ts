import "server-only";
import { revalidateTag, unstable_cache } from "next/cache";
import { getRuntimeDatabase } from "../db/runtime.ts";
import {
	readStatusWithCachedDetails,
	STATUS_CACHE_SECONDS,
	statusTag,
} from "./cache.ts";
import { isStatusSlug } from "./input.ts";
import {
	isPublishedStatusPage,
	loadPublicStatusDetails,
	loadPublicStatusSnapshot,
} from "./public-data.ts";

export function hasPublicStatusPage(slug: string): Promise<boolean> {
	if (!isStatusSlug(slug)) return Promise.resolve(false);
	return isPublishedStatusPage(getRuntimeDatabase(), slug);
}

export async function readPublicStatus(slug: string) {
	if (!isStatusSlug(slug)) return null;

	try {
		const db = getRuntimeDatabase();
		return await readStatusWithCachedDetails(slug, new Date(), {
			readSnapshot: (slug, now) => loadPublicStatusSnapshot(db, slug, now),
			readDetails: (snapshot, now) =>
				loadPublicStatusDetails(db, snapshot, now),
			cacheDetails: (key, tag, load) =>
				unstable_cache(load, key, {
					tags: [tag],
					revalidate: STATUS_CACHE_SECONDS,
				})(),
		});
	} catch {
		throw new Error("Unable to load status page.");
	}
}

export function invalidateStatusSlugs(slugs: readonly string[]): void {
	for (const slug of new Set(slugs)) {
		if (isStatusSlug(slug)) revalidateTag(statusTag(slug), { expire: 0 });
	}
}
