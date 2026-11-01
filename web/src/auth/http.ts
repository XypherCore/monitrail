import { sanitizeNextPath } from "./redirect.ts";

type BoundarySession = {
  user: { id: string; name: string; email: string };
  session: { expiresAt: Date | string };
} | null;
type AuthBoundary = { handler(request: Request): Promise<Response> };
const inputLimit = 8192; // Auth payload bound, not a monitor or product quota.

function privateResponse(response: Response): Response {
  response.headers.set("cache-control", "no-store, max-age=0");
  response.headers.set("pragma", "no-cache");
  response.headers.set("vary", "Cookie");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
function failure(status: number): Response {
  return privateResponse(Response.json({ error: { code: "AUTH_REQUEST_FAILED", message: "Authentication request failed. Try again." } }, { status }));
}

export function createAuthRequestHandler(auth: AuthBoundary, baseURL: string) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const callback = /^\/api\/auth\/callback\/(github|google)$/.test(path);
    const signIn = path === "/api/auth/sign-in/social";
    const signOut = path === "/api/auth/sign-out";
    const session = path === "/api/auth/get-session";
    if (!callback && !signIn && !signOut && !session) return failure(404);
    if ((callback || session) ? request.method !== "GET" : request.method !== "POST") return failure(405);
    if ((signIn || signOut) && request.headers.get("origin") !== baseURL) return failure(403);
    try {
      if (session) {
        const response = await auth.handler(request);
        if (!response.ok) return failure(response.status >= 500 ? 503 : response.status);
        const current = await response.json() as BoundarySession;
        // The public API never serializes persisted session tokens or metadata.
        return privateResponse(Response.json(current ? {
          user: { id: current.user.id, name: current.user.name, email: current.user.email },
          session: { expiresAt: current.session.expiresAt },
        } : null, { headers: new Headers(response.headers) }));
      }
      if (signIn) {
        if (!request.headers.get("content-type")?.startsWith("application/json")) return failure(400);
        const reader = request.body?.getReader();
        if (!reader) return failure(400);
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > inputLimit) { await reader.cancel(); return failure(413); }
          chunks.push(chunk.value);
        }
        let body: Record<string, unknown>;
        try {
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
          if (!value || typeof value !== "object" || Array.isArray(value)) return failure(400);
          body = value as Record<string, unknown>;
        } catch { return failure(400); }
        const allowed = ["provider", "callbackURL", "newUserCallbackURL", "errorCallbackURL", "disableRedirect"];
        if (Object.keys(body).some(key => !allowed.includes(key)) || !["github", "google"].includes(String(body.provider))) return failure(400);
        const destination = sanitizeNextPath(body.callbackURL);
        if (body.callbackURL !== undefined && destination !== body.callbackURL) return failure(400);
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        request = new Request(request.url, { method: "POST", headers, body: JSON.stringify({
          provider: body.provider, callbackURL: destination, newUserCallbackURL: destination,
          errorCallbackURL: `${baseURL}/login?error=oauth&next=${encodeURIComponent(destination)}`,
          disableRedirect: body.disableRedirect === true,
        }) });
      }
      const response = await auth.handler(request);
      if (callback) {
        const headers = new Headers(response.headers);
        const location = headers.get("location");
        const target = location ? new URL(location, baseURL) : null;
        if (!target || target.origin !== baseURL || target.search || target.hash || sanitizeNextPath(target.pathname) !== target.pathname) {
          headers.set("location", `${baseURL}/login?error=oauth`);
        } else headers.set("location", target.href);
        return privateResponse(new Response(null, { status: 302, headers }));
      }
      // Dependency error payloads can contain provider/driver details.
      if (!response.ok) {
        const rejected = failure(response.status >= 500 ? 503 : response.status);
        const retryAfter = response.headers.get("retry-after") ?? response.headers.get("x-retry-after");
        if (response.status === 429 && retryAfter && /^\d+$/.test(retryAfter)) {
          rejected.headers.set("retry-after", retryAfter);
          rejected.headers.set("x-retry-after", retryAfter);
        }
        return rejected;
      }
      return privateResponse(response);
    } catch { return failure(503); }
  };
}
