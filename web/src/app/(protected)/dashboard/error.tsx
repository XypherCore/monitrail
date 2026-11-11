"use client";

export default function DashboardError({ retry }: { retry: () => void }) {
	return (
		<div className="section-panel empty-state">
			<h1>Dashboard unavailable</h1>
			<p>Something went wrong. Try again in a moment.</p>
			<button className="button button-primary" type="button" onClick={retry}>
				Try again
			</button>
		</div>
	);
}
