import { monitorHandlers } from "../../../../monitors/runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  return monitorHandlers.update(request, (await params).id);
}

export async function DELETE(request: Request, { params }: Context) {
  return monitorHandlers.delete(request, (await params).id);
}
