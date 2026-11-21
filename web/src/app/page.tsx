import Link from "next/link";
import { identity } from "../../../shared/identity";

export default async function Home({
	searchParams,
}: {
	searchParams: Promise<{ account?: string | string[] }>;
}) {
	const deleted = (await searchParams).account === "deleted";
	return (
		<div className="public-page">
			<a className="skip-link" href="#main-content">
				Skip to content
			</a>
			<header className="public-header">
				<Link className="wordmark" href="/">
					<span className="brand-mark" aria-hidden="true">
						{identity.monogram}
					</span>
					{identity.brandName}
				</Link>
			</header>
			<main className="landing-main" id="main-content">
				<div className="landing-copy">
					{deleted && <p role="status">Your account and its data have been deleted.</p>}
					<p className="eyebrow">A home for your site status</p>
					<h1>Website uptime and performance monitoring.</h1>
					<p className="lede">
						Keep your monitors, incident history and public status pages in one
						workspace.
					</p>
					<Link className="button button-primary" href="/login">
						Sign in <span aria-hidden="true">→</span>
					</Link>
				</div>
				<section className="preview-card" aria-labelledby="preview-heading">
					<div className="preview-topline">
						<h2 id="preview-heading">Status preview</h2>
						<span className="quiet-label">Example</span>
					</div>
					<div className="preview-monitor">
						<div>
							<p className="monitor-name">Your website</p>
							<p className="monitor-url">example.com</p>
						</div>
						<span className="status status-up">
							<span className="status-dot" aria-hidden="true" />
							Up
						</span>
					</div>
					<p className="preview-note">
						A clear place to see how your sites are doing.
					</p>
				</section>
			</main>
			<footer className="public-footer">
				{identity.footerText} · <Link href="/bot">Checker and abuse contact</Link>
			</footer>
		</div>
	);
}
