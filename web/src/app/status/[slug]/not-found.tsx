import Link from "next/link";

export default function StatusNotFound() {
	return (
		<main className="empty-state">
			<h1>Page not found</h1>
			<Link className="button" href="/" prefetch={false}>
				Back to home
			</Link>
		</main>
	);
}
