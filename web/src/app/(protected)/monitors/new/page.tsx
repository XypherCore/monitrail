import Link from "next/link";
import { getCurrentDataAccess, requireUser } from "../../../../auth/session";
import { MonitorEditor } from "../../../../components/monitor-editor";

export default async function NewMonitorPage() {
	await requireUser("/monitors/new");
	const access = await getCurrentDataAccess();
	const channels = (await access.listChannels())
		.filter((channel) => channel.isVerified)
		.map(({ id, label, type }) => ({ id, label, type }));
	return (
		<>
			<Link className="monitor-back-link" href="/dashboard">
				<span aria-hidden="true">←</span> Dashboard
			</Link>
			<div className="page-heading">
				<h1>Add monitor</h1>
				<p>Enter the public website you want to monitor.</p>
			</div>
			<MonitorEditor channels={channels} />
		</>
	);
}
