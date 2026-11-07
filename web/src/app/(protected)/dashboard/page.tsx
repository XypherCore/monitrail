import Link from "next/link";
import { getCurrentDataAccess, requireUser } from "../../../auth/session";
import { MonitorStatus } from "../../../components/monitor-status";

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
									href={`/monitors/${monitor.id}`}
								>
									<div className="monitor-description">
										<p className="monitor-name">{monitor.name}</p>
										<p className="monitor-url">{monitor.url}</p>
									</div>
									<MonitorStatus status={monitor.status} />
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>
		</>
	);
}
