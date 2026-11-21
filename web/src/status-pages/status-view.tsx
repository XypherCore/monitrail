import { identity } from "../../../shared/identity.ts";
import { MonitorStatus } from "../components/monitor-status.tsx";
import {
	formatAvailability,
	formatCoverage,
} from "../monitors/insight-format.ts";
import type { AvailabilityDay } from "../monitors/insight-types.ts";
import type { PublicStatusDetails, PublicStatusSnapshot } from "./contracts.ts";
import { overallStatus } from "./public-data.ts";
import styles from "./status-view.module.css";

const dayFormat = new Intl.DateTimeFormat("en", {
	dateStyle: "medium",
	timeZone: "UTC",
});
const dateTimeFormat = new Intl.DateTimeFormat("en", {
	dateStyle: "medium",
	timeStyle: "short",
	timeZone: "UTC",
});

function dayState(percent: number | null) {
	if (percent === null)
		return { className: styles.unobserved, text: "No data" };
	if (percent === 100)
		return { className: styles.available, text: "Available" };
	if (percent >= 99) return { className: styles.partial, text: "Partial" };
	return { className: styles.unavailable, text: "Below 99%" };
}

function dayDescription(day: AvailabilityDay) {
	const incidents = `${day.incidentCount} ${day.incidentCount === 1 ? "incident" : "incidents"}`;
	return `${dayFormat.format(day.start)} UTC · ${dayState(day.percent).text} · ${formatAvailability(day.percent)} · Coverage ${formatCoverage(day.coverage)} · ${incidents}`;
}

function DailyAvailability({
	days,
	monitor,
}: {
	days: AvailabilityDay[];
	monitor: string;
}) {
	return (
		<figure className={styles.availability}>
			<figcaption>30-day availability</figcaption>
			<div className={styles.days} aria-hidden="true">
				{days.map((day) => (
					<span
						key={day.start}
						className={dayState(day.percent).className}
						title={dayDescription(day)}
					/>
				))}
			</div>
			<details className={styles.history}>
				<summary>Daily availability details</summary>
				<table>
					<caption className={styles.srOnly}>
						Daily availability for {monitor} (UTC)
					</caption>
					<thead>
						<tr>
							<th scope="col">Day (UTC)</th>
							<th scope="col">Availability</th>
							<th scope="col">Coverage</th>
							<th scope="col">Incidents</th>
						</tr>
					</thead>
					<tbody>
						{days.toReversed().map((day) => (
							<tr key={day.start}>
								<th scope="row">
									<time
										dateTime={new Date(day.start).toISOString().slice(0, 10)}
									>
										{dayFormat.format(day.start)}
									</time>
								</th>
								<td>
									{formatAvailability(day.percent)}
									{dayState(day.percent).text === "Partial" && <span className={styles.dayStatus}>Partial</span>}
								</td>
								<td>{formatCoverage(day.coverage)}</td>
								<td>{day.incidentCount}</td>
							</tr>
						))}
					</tbody>
				</table>
			</details>
		</figure>
	);
}

function readableDuration(
	startedAt: string,
	resolvedAt: string | null,
	now: number,
) {
	const minutes = Math.max(
		0,
		Math.floor(
			((resolvedAt === null ? now : Date.parse(resolvedAt)) -
				Date.parse(startedAt)) /
				60_000,
		),
	);
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
	const remainder = minutes % 60;
	if (hours) return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
	return remainder ? `${remainder}m` : "Under 1 min";
}

function IncidentTime({ value }: { value: string }) {
	return (
		<time dateTime={value}>{dateTimeFormat.format(Date.parse(value))} UTC</time>
	);
}

export function StatusView({
	snapshot,
	details,
}: {
	snapshot: PublicStatusSnapshot;
	details: PublicStatusDetails;
}) {
	const status = overallStatus(snapshot.monitors);
	const inactive = snapshot.monitors.every(
		({ status }) => status === "paused" || status === "blocked",
	);
	const names = new Map(snapshot.monitors.map(({ id, name }) => [id, name]));
	// Render keys are public positions. React Flight can expose keys.
	const monitors = snapshot.monitors.map(
		({ id, name, status, url }, position) => ({
			key: position,
			name,
			status,
			url,
			days: details.daysByMonitor[id],
		}),
	);
	const incidents = details.incidents.map(
		({ monitorId, startedAt, resolvedAt, cause }, position) => ({
			key: position,
			name: names.get(monitorId),
			startedAt,
			resolvedAt,
			cause,
		}),
	);
	const now = Date.now();
	return (
		<div className="public-page">
			<a className="skip-link" href="#main-content">
				Skip to content
			</a>
			<header className="public-header">
				<a
					className="wordmark"
					href="/"
				>
					<span className="brand-mark" aria-hidden="true">
						{identity.monogram}
					</span>
					{identity.brandName}
				</a>
			</header>
			<main className={styles.main} id="main-content">
				<h1>{snapshot.title}</h1>
				<section className={styles.overview} aria-labelledby="overall-status">
					<h2 id="overall-status">Overall status</h2>
					<MonitorStatus status={status} />
					{inactive && <p className={styles.note}>No active monitors.</p>}
				</section>
				<section className={styles.section} aria-labelledby="monitors">
					<h2 id="monitors">Monitors</h2>
					<ul className={styles.list}>
						{monitors.map((monitor) => {
							return (
								<li
									key={monitor.key}
									className={styles.monitor}
									data-inactive={
										monitor.status === "paused" ||
										monitor.status === "blocked" ||
										undefined
									}
								>
									<div className={styles.monitorHeader}>
										<h3>{monitor.name}</h3>
										<MonitorStatus status={monitor.status} />
									</div>
									{monitor.url && (
										<a
											className={styles.url}
											href={monitor.url}
											rel="noreferrer"
											referrerPolicy="no-referrer"
										>
											{monitor.url}
										</a>
									)}
									{monitor.days && (
										<DailyAvailability
											days={monitor.days}
											monitor={monitor.name}
										/>
									)}
								</li>
							);
						})}
					</ul>
				</section>
				<section className={styles.section} aria-labelledby="recent-incidents">
					<h2 id="recent-incidents">Recent incidents</h2>
					{incidents.length === 0 ? (
						<p className={styles.note}>No recent incidents.</p>
					) : (
						<ul className={styles.list}>
							{incidents.map(({ key, name, startedAt, resolvedAt, cause }) => (
								<li className={styles.incident} key={key}>
									<h3>{name}</h3>
									<p>{cause}</p>
									<dl>
										<div>
											<dt>Started</dt>
											<dd>
												<IncidentTime value={startedAt} />
											</dd>
										</div>
										<div>
											<dt>Resolved</dt>
											<dd>
												{resolvedAt === null ? (
													"Ongoing"
												) : (
													<IncidentTime value={resolvedAt} />
												)}
											</dd>
										</div>
										<div>
											<dt>Duration</dt>
											<dd>{readableDuration(startedAt, resolvedAt, now)}</dd>
										</div>
									</dl>
								</li>
							))}
						</ul>
					)}
				</section>
			</main>
			<footer className="public-footer">
				<a href="/">{identity.poweredByText}</a>
			</footer>
		</div>
	);
}
