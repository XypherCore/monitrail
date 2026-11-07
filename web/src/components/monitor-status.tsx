import type { MonitorDto } from "../data/access";

const states = {
	up: { label: "Up", path: "m3 8 3 3 7-7" },
	down: { label: "Down", path: "M8 3v10m-4-4 4 4 4-4" },
	pending: {
		label: "Pending",
		path: "M8 4v4l3 2M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z",
	},
	confirming: {
		label: "Confirming",
		path: "M13 6A5.5 5.5 0 1 0 13 11M13 3v3h-3",
	},
	paused: { label: "Paused", path: "M6 4v8m4-8v8" },
	blocked: {
		label: "Blocked",
		path: "M8 2 3 4v4c0 2.5 2 4.5 5 6 3-1.5 5-3.5 5-6V4L8 2Z",
	},
	unknown: {
		label: "Unknown",
		path: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM6.4 6.2a1.6 1.6 0 1 1 2.7 1.2C8.3 8 8 8.1 8 9m0 2v.1",
	},
};

export function MonitorStatus({ status }: { status: MonitorDto["status"] }) {
	const { label, path } = states[status];
	return (
		<span className={`status status-${status}`}>
			<svg
				aria-hidden="true"
				className="monitor-status-icon"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d={path} />
			</svg>
			{label}
		</span>
	);
}
