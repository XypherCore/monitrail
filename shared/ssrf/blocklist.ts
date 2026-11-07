import { canonicalPolicyHost } from "./address.ts";

export type BlockedHost = Readonly<{ host: string; includeSubdomains: boolean }>;

/** Compile one authenticated snapshot for use across a checker batch. */
export function prepareBlocklist(snapshot: unknown): (host: string) => boolean {
  const invalid = () => new Error("Invalid blocklist snapshot.");
  if (!Array.isArray(snapshot)) throw invalid();
  const exact = new Set<string>();
  const subdomains = new Set<string>();
  for (const item of snapshot) {
    if (typeof item?.host !== "string" || typeof item.includeSubdomains !== "boolean")
      throw invalid();
    const host = canonicalPolicyHost(item.host);
    if (!host) throw invalid();
    exact.add(host);
    if (item.includeSubdomains) subdomains.add(host);
  }

  return (input) => {
    const host = canonicalPolicyHost(input);
    if (!host || exact.has(host)) return true;
    if (host.startsWith("[") || /^\d+(?:\.\d+){3}$/.test(host)) return false;
    for (let dot = host.indexOf("."); dot !== -1; dot = host.indexOf(".", dot + 1)) {
      if (subdomains.has(host.slice(dot + 1))) return true;
    }
    return false;
  };
}

export function isBlockedHost(host: string, snapshot: unknown): boolean {
  try {
    return prepareBlocklist(snapshot)(host);
  } catch {
    return true;
  }
}
