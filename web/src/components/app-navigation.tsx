"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const destinations = [
	{
		href: "/dashboard",
		label: "Dashboard",
		path: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
	},
	{
		href: "/channels",
		label: "Channels",
		path: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
	},
	{
		href: "/status-pages",
		label: "Status pages",
		path: "M3 5h18v14H3zM3 9h18M7 13h3M7 16h8",
	},
	{
		href: "/settings",
		label: "Settings",
		path: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
	},
];

export function AppNavigation() {
	const pathname = usePathname();
	return (
		<nav className="app-navigation" aria-label="Main navigation">
			{destinations.map((item) => {
				const active =
					pathname === item.href ||
					pathname.startsWith(`${item.href}/`) ||
					(item.href === "/dashboard" && pathname.startsWith("/monitors/"));
				return (
					<Link
						className="nav-link"
						href={item.href}
						key={item.href}
						aria-current={active ? "page" : undefined}
					>
						<svg
							className="nav-icon"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d={item.path} />
						</svg>
						<span>{item.label}</span>
					</Link>
				);
			})}
		</nav>
	);
}
