import { requireUser } from "../../../auth/session";

export default async function StatusPagesPage() {
	await requireUser("/status-pages");
	return (
		<>
			<div className="page-heading">
				<h1>Status pages</h1>
				<p>A public view of the monitors you choose to share.</p>
			</div>
			<section className="section-panel" aria-labelledby="pages-heading">
				<div className="panel-heading">
					<h2 id="pages-heading">Public status pages</h2>
				</div>
				<p className="section-description">
					Status page setup is not available yet.
				</p>
			</section>
		</>
	);
}
