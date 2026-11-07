import { getCurrentDataAccess, requireUser } from "../../../auth/session";
import { displayMonitorUrl } from "../../../data/display-url";

const statusLabels = {
	up: "Up",
	down: "Down",
	pending: "Pending",
	paused: "Paused",
	confirming: "Confirming",
	blocked: "Blocked",
	unknown: "Unknown",
};

export default async function DashboardPage() {
	await requireUser("/dashboard");
	const access = await getCurrentDataAccess();
	const monitors = await access.listMonitors();
	return (
		<>
			<div className="page-heading">
				<h1>Dashboard</h1>
				<p>Your sites at a glance.</p>
			</div>
			<section className="section-panel" aria-labelledby="monitors-heading">
				<div className="panel-heading">
					<h2 id="monitors-heading">Monitors</h2>
				</div>
				{monitors.length === 0 ? (
					<div className="empty-state">
						<span className="empty-symbol" aria-hidden="true">
							＋
						</span>
						<h2>No monitors yet</h2>
						<p>Your monitors and their current status will appear here.</p>
						<button
							className="button"
							type="button"
							disabled
							aria-describedby="monitor-availability"
						>
							Add monitor
						</button>
						<p className="availability-note" id="monitor-availability">
							Monitor setup is not available yet.
						</p>
					</div>
				) : (
					<ul className="monitor-list">
						{monitors.map((monitor) => (
							<li className="monitor-row" key={monitor.id}>
								<div className="monitor-description">
									<p className="monitor-name">{monitor.name}</p>
									<p className="monitor-url">{displayMonitorUrl(monitor.url)}</p>
								</div>
								<span className={`status status-${monitor.status}`}>
									<span className="status-dot" aria-hidden="true" />
									{statusLabels[monitor.status]}
								</span>
							</li>
						))}
					</ul>
				)}
			</section>
		</>
	);
}
