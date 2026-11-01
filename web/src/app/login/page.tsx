import Link from "next/link";
import { sanitizeNextPath } from "../../auth/redirect";
import { LoginButtons } from "../../components/login-buttons";

export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ next?: string; error?: string }>;
}) {
	const params = await searchParams;
	return (
		<div className="public-page">
			<a className="skip-link" href="#main-content">
				Skip to content
			</a>
			<header className="public-header">
				<Link className="wordmark" href="/" aria-label="Monitrail home">
					<span className="brand-mark" aria-hidden="true">
						m
					</span>
					Monitrail
				</Link>
			</header>
			<main className="login-main" id="main-content">
				<div className="login-card">
					<h1>Sign in to Monitrail</h1>
					<p className="login-description">Open your monitoring workspace.</p>
					<LoginButtons
						nextPath={sanitizeNextPath(params.next)}
						initialError={Boolean(params.error)}
					/>
					<p className="login-note">
						Use your GitHub or Google account to continue.
					</p>
				</div>
			</main>
		</div>
	);
}
