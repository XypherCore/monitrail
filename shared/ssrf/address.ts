export function hasForbiddenUrlCharacters(input: string): boolean {
  if (/[\s\\]/u.test(input)) return true;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
const forbiddenNames = ["localhost", "local", "internal"] as const;

/** Hostname-only normalization. IP literals still require publicness checks. */
export function canonicalHostname(input: string): string | null {
  if (
    typeof input !== "string" ||
    !input ||
    hasForbiddenUrlCharacters(input) ||
    /[/@?#%]/.test(input)
  )
    return null;
  let source = input;
  if (input.includes(":")) {
    if (!(input.startsWith("[") && input.endsWith("]"))) source = `[${input}]`;
  } else if (input.includes("[") || input.includes("]")) return null;
  let url: URL;
  try {
    url = new URL(`http://${source}/`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash)
    return null;
  let host = url.hostname;
  if (host.startsWith("[")) return host;
  if (host.endsWith("..")) return null;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return host;
  if (
    !host ||
    host.length > 253 ||
    forbiddenNames.some((name) => host === name || host.endsWith(`.${name}`))
  )
    return null;
  const labels = host.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  )
    return null;
  return host;
}

type Address = { version: 4 | 6; value: bigint };
type Prefix = readonly [network: bigint, shift: bigint];

function parseAddress(input: string): Address | null {
  const host = canonicalHostname(input);
  if (!host) return null;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    const octets = host.split(".").map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    return {
      version: 4,
      value: octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n),
    };
  }
  if (!host.startsWith("[") || !host.endsWith("]")) return null;
  // WHATWG URL has already validated and serialized IPv6, including dotted
  // IPv4 tails. Expand only its canonical hex groups, not a permissive parser.
  const halves = host.slice(1, -1).split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups =
    halves.length === 1 ? left : [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return {
    version: 6,
    value: groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n),
  };
}

function prefix(address: string, bits: number, version: 4 | 6): Prefix {
  const parsed = parseAddress(address);
  if (!parsed || parsed.version !== version) throw new Error("Address policy is invalid.");
  const shift = BigInt((version === 4 ? 32 : 128) - bits);
  return Object.freeze([parsed.value >> shift, shift] as const);
}
function contains(value: bigint, range: Prefix): boolean {
  return value >> range[1] === range[0];
}

// Reviewed 2026-11-02 against IANA special-purpose registries (2025-10-09):
// https://www.iana.org/assignments/iana-ipv4-special-registry
// https://www.iana.org/assignments/iana-ipv6-special-registry
// Protocol-service and other special-purpose ranges are conservatively denied,
// including globally reachable exceptions; eligibility is not a routing promise.
const denied4: readonly Prefix[] = Object.freeze([
  prefix("0.0.0.0", 8, 4),
  prefix("10.0.0.0", 8, 4),
  prefix("100.64.0.0", 10, 4),
  prefix("127.0.0.0", 8, 4),
  prefix("169.254.0.0", 16, 4),
  prefix("172.16.0.0", 12, 4),
  prefix("192.0.0.0", 24, 4),
  prefix("192.0.2.0", 24, 4),
  prefix("192.31.196.0", 24, 4),
  prefix("192.52.193.0", 24, 4),
  prefix("192.88.99.0", 24, 4),
  prefix("192.168.0.0", 16, 4),
  prefix("192.175.48.0", 24, 4),
  prefix("198.18.0.0", 15, 4),
  prefix("198.51.100.0", 24, 4),
  prefix("203.0.113.0", 24, 4),
  prefix("224.0.0.0", 3, 4),
  // Azure's public-looking virtual host address is internal platform access.
  // https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16
  prefix("168.63.129.16", 32, 4),
]);

// IANA Global Unicast assignments reviewed 2026-11-02, registry 2025-10-10:
// https://www.iana.org/assignments/ipv6-unicast-address-assignments
// Unlisted space inside 2000::/3 is reserved, so do not allow that /3 broadly.
// Future allocations require reviewing this list and its boundary tests.
const allocated6: readonly Prefix[] = Object.freeze([
  prefix("2001:200::", 23, 6),
  prefix("2001:400::", 23, 6),
  prefix("2001:600::", 23, 6),
  prefix("2001:800::", 22, 6),
  prefix("2001:c00::", 23, 6),
  prefix("2001:e00::", 23, 6),
  prefix("2001:1200::", 23, 6),
  prefix("2001:1400::", 22, 6),
  prefix("2001:1800::", 23, 6),
  prefix("2001:1a00::", 23, 6),
  prefix("2001:1c00::", 22, 6),
  prefix("2001:2000::", 19, 6),
  prefix("2001:4000::", 23, 6),
  prefix("2001:4200::", 23, 6),
  prefix("2001:4400::", 23, 6),
  prefix("2001:4600::", 23, 6),
  prefix("2001:4800::", 23, 6),
  prefix("2001:4a00::", 23, 6),
  prefix("2001:4c00::", 23, 6),
  prefix("2001:5000::", 20, 6),
  prefix("2001:8000::", 19, 6),
  prefix("2001:a000::", 20, 6),
  prefix("2001:b000::", 20, 6),
  prefix("2003::", 18, 6),
  prefix("2400::", 12, 6),
  prefix("2410::", 12, 6),
  prefix("2600::", 12, 6),
  prefix("2610::", 23, 6),
  prefix("2620::", 23, 6),
  prefix("2630::", 12, 6),
  prefix("2800::", 12, 6),
  prefix("2a00::", 12, 6),
  prefix("2a10::", 12, 6),
  prefix("2c00::", 12, 6),
]);
const denied6: readonly Prefix[] = Object.freeze([
  prefix("2001:db8::", 32, 6),
  prefix("2620:4f:8000::", 48, 6),
]);

/** Eligible public unicast only; invalid and special-use addresses fail closed. */
export function isPublicAddress(input: string): boolean {
  const parsed = parseAddress(input);
  if (!parsed) return false;
  if (parsed.version === 4) return !denied4.some((range) => contains(parsed.value, range));
  // Normalize mapped IPv4 before classification; checking only the outer IPv6
  // form would permit metadata/private IPv4 hidden in ::ffff:0:0/96.
  if (parsed.value >> 32n === 0xffffn) {
    const embedded = parsed.value & 0xffff_ffffn;
    return !denied4.some((range) => contains(embedded, range));
  }
  // This also excludes compatible IPv4, NAT64, Teredo, 6to4, ULA, link-local,
  // multicast and unallocated future space without relying on runtime routing.
  return (
    allocated6.some((range) => contains(parsed.value, range)) &&
    !denied6.some((range) => contains(parsed.value, range))
  );
}

/** Canonical target URL or a fixed error without the supplied URL or secrets. */
export function parseTarget(input: string): URL {
  const denied = () => new Error("Target URL is not allowed.");
  if (typeof input !== "string" || !input || hasForbiddenUrlCharacters(input)) throw denied();
  const authority = /^https?:\/\/([^/?#]*)/i.exec(input)?.[1];
  if (!authority || authority.includes("@")) throw denied();
  let target: URL;
  try {
    target = new URL(input);
  } catch {
    throw denied();
  }
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    (target.port && !["80", "443", "8080", "8443"].includes(target.port))
  )
    throw denied();
  const host = canonicalHostname(target.hostname);
  if (!host) throw denied();
  if ((host.startsWith("[") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) && !isPublicAddress(host))
    throw denied();
  target.hostname = host;
  target.hash = "";
  return target;
}
