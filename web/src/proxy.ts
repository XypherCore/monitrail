import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig } from "./auth/config.ts";
import { sanitizeNextPath } from "./auth/redirect.ts";
import { getAuthRuntime } from "./auth/runtime.ts";
import { baselineSecurityHeaders, createPageSecurity } from "./security/headers.ts";
import { hasPublicStatusPage } from "./status-pages/public-runtime.ts";

const statusUnavailable = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found</title></head>
<body><main><h1>Page not found</h1><a href="/">Back to home</a></main></body></html>`;

async function publicStatusResponse(encodedSlug: string, requestHeaders: Headers) {
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex" };
  let slug: string;
  try { slug = decodeURIComponent(encodedSlug); }
  catch { slug = ""; }

  try {
    if (await hasPublicStatusPage(slug)) return NextResponse.next({ request: { headers: requestHeaders } });
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

async function authenticatedResponse(request: NextRequest, requestHeaders: Headers) {
  try {
    const config = readAuthConfig(process.env, process.env.NODE_ENV === "production");
    const current = await getAuthRuntime().api.getSession({ headers: request.headers, query: { disableRefresh: true } });
    if (!current) {
      const login = new URL("/login", config.baseURL);
      login.searchParams.set("next", sanitizeNextPath(request.nextUrl.pathname));
      return NextResponse.redirect(login);
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  } catch {
    return new NextResponse("Authentication is temporarily unavailable.", { status: 503, headers: { "cache-control": "no-store" } });
  }
}

export async function proxy(request: NextRequest) {
  const security = createPageSecurity(request.headers, process.env.NODE_ENV === "development");
  const path = request.nextUrl.pathname;
  const publicStatus = /^\/status\/([^/]+)$/.exec(path);
  const protectedPath = /^\/(?:dashboard|monitors|channels|status-pages|settings)(?:\/|$)/.test(path);
  const response = publicStatus
    ? await publicStatusResponse(publicStatus[1], security.requestHeaders)
    : protectedPath
      ? await authenticatedResponse(request, security.requestHeaders)
      : NextResponse.next({ request: { headers: security.requestHeaders } });

  for (const [key, value] of Object.entries(baselineSecurityHeaders(process.env.NODE_ENV === "production"))) {
    response.headers.set(key, value);
  }
  response.headers.set("content-security-policy", security.policy);
  response.headers.set("cache-control", "no-store");
  return response;
}

// Prefetch requests retain the same authentication and CSP boundaries.
export const config = { matcher: ["/((?!api/|_next/static/|_next/image|icon.svg|favicon.ico).*)"] };
