import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentDataAccess, requireUser } from "../../../../auth/session";
import { MonitorEditor } from "../../../../components/monitor-editor";
import { MonitorStatus } from "../../../../components/monitor-status";
import { isMonitorId } from "../../../../monitors/input";

export default async function MonitorPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	await requireUser(`/monitors/${id}`);
	if (!isMonitorId(id)) notFound();

	const access = await getCurrentDataAccess();
	const monitor = await access.getMonitor(id);
	if (!monitor) notFound();

	return (
		<>
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
					{monitor.status === "pending" && (
						<span className="monitor-state-note">Waiting for first check</span>
					)}
					{monitor.status === "paused" && (
						<span className="monitor-state-note">Monitoring is paused.</span>
					)}
					{monitor.status === "blocked" && (
						<span className="monitor-state-note">This address is blocked.</span>
					)}
					{monitor.status === "unknown" && (
						<span className="monitor-state-note">No recent checks.</span>
					)}
				</div>
			</div>
			<MonitorEditor key={monitor.id} monitor={monitor} />
		</>
	);
}
