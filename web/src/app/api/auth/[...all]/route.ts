import { readAuthConfig } from "../../../../auth/config.ts";
import { createAuthRequestHandler } from "../../../../auth/http.ts";
import { getAuthRuntime } from "../../../../auth/runtime.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request) {
  try {
    const config = readAuthConfig(process.env, process.env.NODE_ENV === "production");
    return await createAuthRequestHandler(getAuthRuntime(), config.baseURL)(request);
  } catch {
    return Response.json({ error: { code: "AUTH_UNAVAILABLE", message: "Authentication is temporarily unavailable." } }, { status: 503, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
}
export { handle as GET, handle as POST };
