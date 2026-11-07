import { getAuthRuntime } from "../../../../auth/runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request) {
  try {
    return await getAuthRuntime().handler(request);
  } catch {
    return Response.json(
      {
        error: { code: "AUTH_UNAVAILABLE", message: "Authentication is temporarily unavailable." },
      },
      { status: 503, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
    );
  }
}
export { handle as GET, handle as POST };
