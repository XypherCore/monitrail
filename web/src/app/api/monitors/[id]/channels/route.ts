import { monitorHandlers } from "../../../../../monitors/runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Context) {
  return monitorHandlers.subscriptions(request, (await params).id);
}
