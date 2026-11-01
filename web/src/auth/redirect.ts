// Only documented private application destinations can be a login return path.
// Reject encodings, queries and fragments rather than decoding attacker input.
export function sanitizeNextPath(value: unknown): string {
  if (typeof value !== "string") return "/dashboard";
  if (["/dashboard", "/channels", "/status-pages", "/settings", "/monitors/new"].includes(value)) return value;
  if (/^\/monitors\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
  return "/dashboard";
}
