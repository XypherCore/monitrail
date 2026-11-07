"use client";

import Link from "next/link";

export default function MonitorError({ retry }: { retry: () => void }) {
	return (
		<div className="section-panel empty-state">
			<h1>Monitor page unavailable</h1>
			<p>Something went wrong. Try again in a moment.</p>
			<button className="button button-primary" type="button" onClick={retry}>
				Try again
			</button>
			<Link className="monitor-back-link" href="/dashboard">
				Back to dashboard
			</Link>
		</div>
	);
}
