import Link from "next/link";
import { requireUser } from "../../../../auth/session";
import { MonitorEditor } from "../../../../components/monitor-editor";

export default async function NewMonitorPage() {
	await requireUser("/monitors/new");
	return (
		<>
			<Link className="monitor-back-link" href="/dashboard">
				<span aria-hidden="true">←</span> Dashboard
			</Link>
			<div className="page-heading">
				<h1>Add monitor</h1>
				<p>Enter the public website you want to monitor.</p>
			</div>
			<MonitorEditor />
		</>
	);
}
