import { statusPageHandlers } from "../../../../status-pages/owner-runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
	return statusPageHandlers.update(request, (await params).id);
}

export async function DELETE(request: Request, { params }: Context) {
	return statusPageHandlers.remove(request, (await params).id);
}
