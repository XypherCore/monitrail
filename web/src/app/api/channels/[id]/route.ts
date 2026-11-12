import { alertChannelHandlers } from "../../../../alerts/runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  return alertChannelHandlers.rename(request, (await params).id);
}

export async function DELETE(request: Request, { params }: Context) {
  return alertChannelHandlers.remove(request, (await params).id);
}
