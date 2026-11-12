import { alertChannelHandlers } from "../../../../../alerts/runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return alertChannelHandlers.test(request, (await params).id);
}
