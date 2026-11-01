import { requireUser } from "../../../auth/session";

export default async function ChannelsPage() {
	await requireUser("/channels");
	return (
		<>
			<div className="page-heading">
				<h1>Channels</h1>
				<p>Where your incident notifications are delivered.</p>
			</div>
			<section className="section-panel" aria-labelledby="channels-heading">
				<div className="panel-heading">
					<h2 id="channels-heading">Alert channels</h2>
				</div>
				<p className="section-description">
					Channel setup is not available yet.
				</p>
			</section>
		</>
	);
}
