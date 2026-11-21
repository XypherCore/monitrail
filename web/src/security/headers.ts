const noncePattern = /^[A-Za-z0-9+/]{22}==$/;

export function contentSecurityPolicy(nonce: string, development: boolean): string {
  if (!noncePattern.test(nonce)) throw new Error("Invalid page security configuration.");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    development ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    development ? "style-src-elem 'self' 'unsafe-inline'" : `style-src-elem 'self' 'nonce-${nonce}'`,
    // Recharts sets numeric layout and tooltip style attributes.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function baselineSecurityHeaders(production: boolean): Record<string, string> {
  return {
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    ...(production ? { "strict-transport-security": "max-age=31536000" } : {}),
  };
}

export function createPageSecurity(originalHeaders: Headers, development: boolean) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const policy = contentSecurityPolicy(nonce, development);
  const requestHeaders = new Headers(originalHeaders);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", policy);
  return { nonce, policy, requestHeaders };
}
