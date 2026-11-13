import { notFound } from "next/navigation";
import { connection } from "next/server";
import { readPublicStatus } from "../../../status-pages/public-runtime.ts";
import { StatusView } from "../../../status-pages/status-view.tsx";

export const runtime = "nodejs";

export default async function PublicStatusPage({
	params,
}: {
	params: Promise<{ slug: string }>;
}) {
	await connection();
	const { slug } = await params;
	const status = await readPublicStatus(slug);
	if (!status) notFound();
	// Render the server-only view without serializing its lookup IDs as props.
	return StatusView(status);
}
