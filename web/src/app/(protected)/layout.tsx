import Link from "next/link";
import type { ReactNode } from "react";
import { identity } from "../../../../shared/identity";
import { requireUser } from "../../auth/session";
import { AppNavigation } from "../../components/app-navigation";
import { SessionRefresh } from "../../components/session-refresh";
import { SignOutButton } from "../../components/sign-out-button";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({
	children,
}: {
	children: ReactNode;
}) {
	const user = await requireUser("/dashboard");
	return (
		<div className="app-shell">
			<SessionRefresh />
			<a className="skip-link" href="#main-content">
				Skip to content
			</a>
			<aside className="app-sidebar">
				<Link className="wordmark" href="/dashboard">
					<span className="brand-mark" aria-hidden="true">
						{identity.monogram}
					</span>
					{identity.brandName}
				</Link>
				<AppNavigation />
			</aside>
			<div className="app-workspace">
				<header className="app-header">
					<span className="header-label">Workspace</span>
					<Link className="wordmark mobile-wordmark" href="/dashboard">
						<span className="brand-mark" aria-hidden="true">
							{identity.monogram}
						</span>
						{identity.brandName}
					</Link>
					<div className="header-actions">
						<span className="account-name">{user.name}</span>
						<SignOutButton />
					</div>
				</header>
				<main className="app-main" id="main-content">
					{children}
				</main>
			</div>
		</div>
	);
}
