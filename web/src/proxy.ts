import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig } from "./auth/config.ts";
import { sanitizeNextPath } from "./auth/redirect.ts";
import { getAuthRuntime } from "./auth/runtime.ts";

export async function proxy(request: NextRequest) {
  try {
    const config = readAuthConfig(process.env, process.env.NODE_ENV === "production");
    const current = await getAuthRuntime().api.getSession({ headers: request.headers, query: { disableRefresh: true } });
    if (!current) {
      const login = new URL("/login", config.baseURL);
      login.searchParams.set("next", sanitizeNextPath(request.nextUrl.pathname));
      return NextResponse.redirect(login);
    }
    return NextResponse.next();
  } catch {
    return new NextResponse("Authentication is temporarily unavailable.", { status: 503, headers: { "cache-control": "no-store" } });
  }
}
export const config = { matcher: ["/dashboard/:path*", "/monitors/:path*", "/channels/:path*", "/status-pages/:path*", "/settings/:path*"] };
