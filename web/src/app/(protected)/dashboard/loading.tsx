export default function DashboardLoading() {
	return (
		<>
			<div className="page-heading">
				<h1>Dashboard</h1>
				<p role="status">Loading monitors…</p>
			</div>
			<section
				className="section-panel"
				aria-labelledby="loading-monitors-heading"
			>
				<div className="panel-heading">
					<h2 id="loading-monitors-heading">Monitors</h2>
				</div>
				<div className="insight-loading-panel" aria-hidden="true">
					<div className="skeleton-block" />
					<div className="skeleton-block" />
					<div className="skeleton-block" />
				</div>
			</section>
		</>
	);
}
