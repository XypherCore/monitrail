import Link from "next/link";
import { checkerUserAgent, identity } from "../../../../shared/identity";
import styles from "./page.module.css";

export const metadata = { title: `Checker information · ${identity.brandName}` };

export default function BotPage() {
	const contact = identity.abuseContactEmail({ ABUSE_CONTACT_EMAIL: process.env.ABUSE_CONTACT_EMAIL });
	if (process.env.NODE_ENV === "production" && !contact) {
		throw new Error("Configure the public abuse contact before serving the checker page.");
	}
	const userAgent = checkerUserAgent(process.env.APP_URL ?? "http://localhost:3000");
	return (
		<div className="public-page">
			<a className="skip-link" href="#main-content">Skip to content</a>
			<header className="public-header">
				<Link className="wordmark" href="/" aria-label={`${identity.brandName} home`}>
					<span className="brand-mark" aria-hidden="true">{identity.monogram}</span>
					{identity.brandName}
				</Link>
			</header>
			<main className={styles.main} id="main-content">
				<h1>About the checker</h1>
				<section aria-labelledby="identification">
					<h2 id="identification">How requests are identified</h2>
					<p>The checker sends GET requests to monitored websites using this User-Agent.</p>
					<code className={styles.userAgent}>{userAgent}</code>
					<p>Checks record HTTP status, response time and an error category. Response bodies and headers are discarded.</p>
				</section>
				<section aria-labelledby="abuse">
					<h2 id="abuse">Abuse reports and block requests</h2>
					{contact && <p>Email <a href={`mailto:${contact}`}>{contact}</a> with the hostname you control and your request.</p>}
					<p>The maintainer verifies control through a reply from an address at that domain or a token file at <code>/.well-known/monitrail-block.txt</code>.</p>
					<p>Once verified, the hostname is added to the blocklist. Entries include subdomains by default, and affected monitors are paused on the next claim or maintenance run.</p>
				</section>
			</main>
			<footer className="public-footer">{identity.footerText}</footer>
		</div>
	);
}
