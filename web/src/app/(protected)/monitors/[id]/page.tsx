import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getCurrentDataAccess, requireUser } from "../../../../auth/session";
import { MonitorEditor } from "../../../../components/monitor-editor";
import { MonitorHistory } from "../../../../components/monitor-history";
import { MonitorRefresh } from "../../../../components/monitor-refresh";
import { MonitorStatus } from "../../../../components/monitor-status";
import { MonitorSubscriptions } from "../../../../components/monitor-subscriptions";
import type { IncidentDto, MonitorDto } from "../../../../data/access";
import {
	MONITOR_RANGES,
	type MonitorRange,
} from "../../../../monitors/insight-types";
import { isMonitorId } from "../../../../monitors/input";

const incidentsPerPage = 20;
const dateTime = new Intl.DateTimeFormat("en", {
	dateStyle: "medium",
	timeStyle: "short",
	timeZone: "UTC",
});
const incidentCauses = {
	dns: "DNS lookup failed",
	timeout: "Connection timed out",
	tls: "TLS connection failed",
	connect: "Connection failed",
	bad_status: "Unexpected HTTP status",
	blocked: "Address blocked",
	other: "Check failed",
} satisfies Record<IncidentDto["cause"], string>;
const closureReasons = {
	recovered: "Recovered",
	paused: "Paused",
	config_changed: "Configuration changed",
	blocked: "Blocked",
} satisfies Record<NonNullable<IncidentDto["resolvedReason"]>, string>;
const statusNotes: Partial<Record<MonitorDto["status"], string>> = {
	pending: "Waiting for first check",
	confirming: "A recheck runs in about 60 seconds.",
	paused: "Monitoring is paused.",
	blocked:
		"This address is blocked. Save an address that passes validation before resuming.",
	unknown: "No recent checks.",
};

function IncidentTime({ value }: { value: Date }) {
	return (
		<time dateTime={value.toISOString()}>{dateTime.format(value)} UTC</time>
	);
}

function duration(start: Date, end: number): string {
	const minutes = Math.max(0, Math.floor((end - start.getTime()) / 60_000));
	if (minutes === 0) return "Under a minute";
	const days = Math.floor(minutes / 1_440);
	const hours = Math.floor((minutes % 1_440) / 60);
	return [
		days && `${days} d`,
		hours && `${hours} h`,
		minutes % 60 && `${minutes % 60} min`,
	]
		.filter(Boolean)
		.join(" ");
}

function readIncidentPage(raw: string | string[] | undefined) {
	if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return 1;
	const page = Number(raw);
	return Number.isSafeInteger((page - 1) * incidentsPerPage) ? page : 1;
}

async function IncidentLog({
	access,
	monitorId,
	now,
	page,
	range,
}: {
	access: Awaited<ReturnType<typeof getCurrentDataAccess>>;
	monitorId: string;
	now: number;
	page: number;
	range: MonitorRange;
}) {
	const incidents = await access.listIncidents(monitorId, {
		limit: incidentsPerPage + 1,
		offset: (page - 1) * incidentsPerPage,
	});
	const visible = incidents.slice(0, incidentsPerPage);
	const hasOlder = incidents.length > incidentsPerPage;
	const newerPage = visible.length === 0 ? 1 : page - 1;
	function linkTo(targetPage: number) {
		return {
			pathname: `/monitors/${monitorId}`,
			query: { range, ...(targetPage > 1 && { incidents: targetPage }) },
			hash: "incident-log",
		};
	}

	return (
		<section
			className="section-panel incident-log"
			id="incident-log"
			aria-labelledby="incident-log-heading"
		>
			<div className="panel-heading">
				<h2 id="incident-log-heading">Incident log</h2>
			</div>
			{visible.length ? (
				<ul className="incident-list">
					{visible.map((incident) => (
						<li className="incident-entry" key={incident.id}>
							<h3>{incidentCauses[incident.cause]}</h3>
							<dl className="incident-fields">
								<div>
									<dt>Observed start</dt>
									<dd>
										<IncidentTime value={incident.startedAt} />
									</dd>
								</div>
								<div>
									<dt>Confirmed</dt>
									<dd>
										<IncidentTime value={incident.confirmedAt} />
									</dd>
								</div>
								<div>
									<dt>Resolved</dt>
									<dd>
										{incident.resolvedAt ? (
											<IncidentTime value={incident.resolvedAt} />
										) : (
											"Ongoing"
										)}
									</dd>
								</div>
								<div>
									<dt>Duration</dt>
									<dd>
										{duration(
											incident.startedAt,
											incident.resolvedAt?.getTime() ?? now,
										)}
									</dd>
								</div>
								{incident.resolvedReason && (
									<div>
										<dt>Closure reason</dt>
										<dd>{closureReasons[incident.resolvedReason]}</dd>
									</div>
								)}
								{incident.resolvedConfirmedAt && (
									<div>
										<dt>Recovery confirmed</dt>
										<dd>
											<IncidentTime value={incident.resolvedConfirmedAt} />
										</dd>
									</div>
								)}
							</dl>
						</li>
					))}
				</ul>
			) : (
				<p className="section-description">
					{page > 1 ? "No incidents on this page." : "No incidents recorded."}
				</p>
			)}
			{(page > 1 || hasOlder) && (
				<nav className="incident-pagination" aria-label="Incident pages">
					{page > 1 && (
						<Link
							className="button button-small"
							href={linkTo(newerPage)}
							prefetch={false}
						>
							{visible.length ? "Newer incidents" : "Latest incidents"}
						</Link>
					)}
					{hasOlder && (
						<Link
							className="button button-small"
							href={linkTo(page + 1)}
							prefetch={false}
						>
							Older incidents
						</Link>
					)}
				</nav>
			)}
		</section>
	);
}

function IncidentLogLoading() {
	return (
		<section
			className="section-panel incident-log"
			aria-labelledby="incident-loading-heading"
		>
			<div className="panel-heading">
				<h2 id="incident-loading-heading">Incident log</h2>
			</div>
			<div className="insight-loading-panel">
				<p className="sr-only" role="status">
					Loading incidents…
				</p>
				<div className="skeleton-block" aria-hidden="true" />
			</div>
		</section>
	);
}

export default async function MonitorPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{
		range?: string | string[];
		incidents?: string | string[];
	}>;
}) {
	const { id } = await params;
	await requireUser(`/monitors/${id}`);
	if (!isMonitorId(id)) notFound();

	const query = await searchParams;
	const range =
		typeof query.range === "string" &&
		Object.hasOwn(MONITOR_RANGES, query.range)
			? (query.range as MonitorRange)
			: "24h";
	const incidentPage = readIncidentPage(query.incidents);
	const access = await getCurrentDataAccess();
	const result = await access.getMonitorInsights(id, range);
	if (!result) notFound();
	const { monitor, insights, openIncidentStartedAt } = result;
	const statusNote = statusNotes[monitor.status];
	const [ownedChannels, subscriptions] = await Promise.all([
		access.listChannels(),
		access.listMonitorChannels(id),
	]);
	const channels = ownedChannels
		.filter((channel) => channel.isVerified)
		.map(({ id: channelId, label, type }) => ({ id: channelId, label, type }));

	return (
		<>
			<MonitorRefresh />
			<Link className="monitor-back-link" href="/dashboard">
				<span aria-hidden="true">←</span> Dashboard
			</Link>
			<div className="page-heading">
				<h1 className="monitor-detail-title">{monitor.name}</h1>
				<p className="monitor-detail-url">{monitor.url}</p>
				<div
					className="monitor-detail-state"
					aria-live="polite"
					aria-atomic="true"
				>
					<MonitorStatus status={monitor.status} />
					{statusNote && (
						<span className="monitor-state-note">{statusNote}</span>
					)}
					{monitor.status === "down" && openIncidentStartedAt && (
						<span className="monitor-state-note">
							Since <IncidentTime value={openIncidentStartedAt} />
						</span>
					)}
				</div>
				{monitor.status === "unknown" && (
					<a
						className="monitor-back-link monitor-status-anchor"
						href="#check-history"
					>
						View status
					</a>
				)}
			</div>
			<MonitorHistory
				insights={insights}
				range={range}
				monitorId={id}
				incidentPage={incidentPage}
			/>
			<Suspense fallback={<IncidentLogLoading />}>
				<IncidentLog
					access={access}
					monitorId={id}
					now={insights.window.end}
					page={incidentPage}
					range={range}
				/>
			</Suspense>
			<MonitorSubscriptions
				monitorId={id}
				channels={channels}
				selected={subscriptions.map((channel) => channel.id)}
			/>
			<MonitorEditor key={monitor.id} monitor={monitor} />
		</>
	);
}
