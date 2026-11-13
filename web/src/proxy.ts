import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig } from "./auth/config.ts";
import { sanitizeNextPath } from "./auth/redirect.ts";
import { getAuthRuntime } from "./auth/runtime.ts";
import { hasPublicStatusPage } from "./status-pages/public-runtime.ts";

const statusUnavailable = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found</title></head>
<body><main><h1>Page not found</h1><a href="/">Back to home</a></main></body></html>`;

async function publicStatusResponse(encodedSlug: string) {
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex" };
  let slug: string;
  try { slug = decodeURIComponent(encodedSlug); }
  catch { slug = ""; }

  try {
    if (await hasPublicStatusPage(slug)) return NextResponse.next();
  } catch {
    return new NextResponse("Status pages are temporarily unavailable.", { status: 503, headers });
  }
  // The pinned App Router renders its dynamic 404 shell only after hydration.
  // Send the generic document here so visitors can read it without JavaScript.
  return new NextResponse(statusUnavailable, {
    status: 404,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
}

export async function proxy(request: NextRequest) {
  const publicStatus = /^\/status\/([^/]+)$/.exec(request.nextUrl.pathname);
  if (publicStatus) return publicStatusResponse(publicStatus[1]);

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
export const config = { matcher: ["/dashboard/:path*", "/monitors/:path*", "/channels/:path*", "/status-pages/:path*", "/settings/:path*", "/status/:slug"] };
