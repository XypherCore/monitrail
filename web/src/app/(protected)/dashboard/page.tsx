import Link from "next/link";
import { getCurrentDataAccess, requireUser } from "../../../auth/session";
import { MonitorRefresh } from "../../../components/monitor-refresh";
import { MonitorStatus } from "../../../components/monitor-status";
import type { MonitorDto } from "../../../data/access";
import {
	formatAvailability,
	formatCoverage,
	formatResponseTime,
} from "../../../monitors/insight-format";

const relativeTime = new Intl.RelativeTimeFormat("en");
const dateTime = new Intl.DateTimeFormat("en", {
	dateStyle: "medium",
	timeStyle: "short",
	timeZone: "UTC",
});
const statusNotes: Partial<Record<MonitorDto["status"], string>> = {
	pending: "Waiting for first check",
	confirming: "A recheck runs in about 60 seconds.",
	blocked: "This address is blocked.",
	unknown: "No recent checks.",
};

function formatLastCheck(checkedAt: Date, now: number) {
	const minutes = Math.max(0, Math.floor((now - checkedAt.getTime()) / 60_000));
	if (minutes < 1) return "Just now";
	if (minutes < 60) return relativeTime.format(-minutes, "minute");
	if (minutes < 1_440)
		return relativeTime.format(-Math.floor(minutes / 60), "hour");
	return relativeTime.format(-Math.floor(minutes / 1_440), "day");
}

export default async function DashboardPage() {
	await requireUser("/dashboard");
	const access = await getCurrentDataAccess();
	const monitors = await access.listMonitorSummaries();
	const now = Date.now();
	return (
		<>
			<MonitorRefresh />
			<div className="page-heading">
				<h1>Dashboard</h1>
				<p>Your sites at a glance.</p>
			</div>
			<section className="section-panel" aria-labelledby="monitors-heading">
				<div className="panel-heading">
					<h2 id="monitors-heading">Monitors</h2>
					{monitors.length > 0 && (
						<Link className="button button-primary" href="/monitors/new">
							Add monitor
						</Link>
					)}
				</div>
				{monitors.length === 0 ? (
					<div className="empty-state">
						<span className="empty-symbol" aria-hidden="true">
							＋
						</span>
						<h3>No monitors yet</h3>
						<p>Your monitors and their current status will appear here.</p>
						<Link className="button button-primary" href="/monitors/new">
							Add monitor
						</Link>
					</div>
				) : (
					<ul className="monitor-list">
						{monitors.map((monitor) => (
							<li className="monitor-row" key={monitor.id}>
								<Link
									className="monitor-row-link"
									href={`/monitors/${monitor.id}${monitor.status === "unknown" ? "#check-history" : ""}`}
									prefetch={false}
								>
									<div className="monitor-description">
										<p className="monitor-name">{monitor.name}</p>
										<p className="monitor-url">{monitor.url}</p>
									</div>
									<div className="monitor-row-state">
										<MonitorStatus status={monitor.status} />
										{statusNotes[monitor.status] && (
											<span className="monitor-state-note">
												{statusNotes[monitor.status]}
											</span>
										)}
										{monitor.status === "down" &&
											monitor.openIncidentStartedAt && (
												<span className="monitor-state-note">
													Since{" "}
													<time
														dateTime={monitor.openIncidentStartedAt.toISOString()}
													>
														{dateTime.format(monitor.openIncidentStartedAt)} UTC
													</time>
												</span>
											)}
										{monitor.status === "unknown" && (
											<span className="monitor-row-status-link">
												View status
											</span>
										)}
									</div>
									<dl className="monitor-row-metrics">
										<div>
											<dt>Availability (24 h)</dt>
											<dd>
												{formatAvailability(monitor.availability.percent)}
												<span className="monitor-row-coverage">
													{formatCoverage(monitor.availability.coverage)}{" "}
													coverage
												</span>
											</dd>
										</div>
										<div>
											<dt>Avg response (24 h)</dt>
											<dd>{formatResponseTime(monitor.averageMs)}</dd>
										</div>
										<div>
											<dt>Last checked</dt>
											<dd>
												{monitor.lastCheckedAt ? (
													<time
														dateTime={monitor.lastCheckedAt.toISOString()}
														title={`${dateTime.format(monitor.lastCheckedAt)} UTC`}
													>
														{formatLastCheck(monitor.lastCheckedAt, now)}
													</time>
												) : (
													"No checks yet"
												)}
											</dd>
										</div>
									</dl>
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>
		</>
	);
}
