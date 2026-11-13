import type { MonitorDto } from "../data/access.ts";
import type { AvailabilityDay } from "../monitors/insight-types.ts";

export type StatusPageSelection = { monitorId: string; showUrl: boolean };
export type StatusPageFields = {
	title: string;
	slug: string;
	monitors: StatusPageSelection[];
};

export type StatusPageMutation = {
	id: string;
	slug: string;
	affectedSlugs: string[];
};

export type PublicStatusSnapshot = {
	pageId: string;
	slug: string;
	title: string;
	monitors: {
		id: string;
		revision: string;
		name: string;
		status: MonitorDto["status"];
		url?: string;
	}[];
};

export type PublicStatusDetails = {
	daysByMonitor: Record<string, AvailabilityDay[]>;
	incidents: {
		monitorId: string;
		startedAt: string;
		resolvedAt: string | null;
		cause: string;
	}[];
};
