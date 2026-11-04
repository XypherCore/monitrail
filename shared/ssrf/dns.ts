import { canonicalHostname } from "./address.ts";
import { awaitSignal, cancelBody, readBoundedJson, type Transport } from "./io.ts";

type Family = 1 | 28;
type ObjectData = Record<string, unknown>;
type ParsedAnswer = { aliases: Map<string, string>; addresses: Map<string, string[]> };

const endpoint = "https://cloudflare-dns.com/dns-query";
const failure = () => new Error("DNS validation failed.");
const object = (value: unknown): value is ObjectData =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function dnsName(value: unknown): string {
  if (typeof value !== "string") throw failure();
  const name = canonicalHostname(value);
  if (!name || name.startsWith("[") || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(name)) throw failure();
  return name;
}

function address(value: unknown, family: Family): string {
  if (typeof value !== "string") throw failure();
  if (family === 1) {
    if (
      !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) ||
      value.split(".").some((part) => Number(part) > 255)
    )
      throw failure();
    return value;
  }
  if (!value.includes(":") || value.includes("[") || value.includes("]") || /[%\s]/u.test(value))
    throw failure();
  const normalized = canonicalHostname(value);
  if (!normalized?.startsWith("[")) throw failure();
  return normalized.slice(1, -1);
}

function parsePacket(value: unknown, name: string, family: Family): ParsedAnswer {
  if (
    !object(value) ||
    value.Status !== 0 ||
    value.TC !== false ||
    value.CD !== false ||
    ["RD", "RA", "AD"].some((flag) => typeof value[flag] !== "boolean")
  )
    throw failure();
  if (!Array.isArray(value.Question) || value.Question.length !== 1) throw failure();
  const question: unknown = value.Question[0];
  if (!object(question) || question.type !== family || dnsName(question.name) !== name)
    throw failure();
  if (value.Answer !== undefined && !Array.isArray(value.Answer)) throw failure();
  const aliases = new Map<string, string>();
  const addresses = new Map<string, string[]>();
  for (const record of (value.Answer ?? []) as unknown[]) {
    if (
      !object(record) ||
      !Number.isSafeInteger(record.TTL) ||
      (record.TTL as number) < 0 ||
      (record.TTL as number) > 0xffff_ffff ||
      typeof record.data !== "string"
    )
      throw failure();
    const owner = dnsName(record.name);
    if (record.type === 5) {
      const target = dnsName(record.data);
      const previous = aliases.get(owner);
      if (previous !== undefined && previous !== target) throw failure();
      aliases.set(owner, target);
    } else {
      if (record.type !== family) throw failure();
      const found = addresses.get(owner) ?? [];
      found.push(address(record.data, family));
      addresses.set(owner, found);
    }
  }
  return { aliases, addresses };
}

/**
 * Fixed trusted DoH service, not an arbitrary fetch endpoint. See Cloudflare's
 * JSON schema: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
 * AD=false is valid for unsigned domains; disabling DNSSEC validation is not.
 * No DNS cache or private-address filtering: the guard must see every answer.
 */
export function createDohResolver(transport: Transport) {
  return async (host: string, options: { signal: AbortSignal }): Promise<readonly string[]> => {
    let parent: AbortSignal | undefined;
    let local: AbortController | undefined;
    const abort = () => local?.abort();
    try {
      parent = options.signal;
      const name = dnsName(host);
      if (!parent || parent.aborted) throw failure();
      local = new AbortController();
      parent.addEventListener("abort", abort, { once: true });
      const signal = local.signal;

      async function request(current: string, family: Family): Promise<ParsedAnswer> {
        if (signal.aborted) throw failure();
        const url = new URL(endpoint);
        url.searchParams.set("name", current);
        url.searchParams.set("type", family === 1 ? "A" : "AAAA");
        url.searchParams.set("cd", "false");
        const response = await awaitSignal(
          Promise.resolve().then(async () => {
            if (signal.aborted) throw failure();
            const result = await transport(url.href, {
              method: "GET",
              redirect: "manual",
              credentials: "omit",
              cache: "no-store",
              headers: { accept: "application/dns-json" },
              signal,
            });
            if (signal.aborted) cancelBody(result);
            return result;
          }),
          signal,
        );
        try {
          const contentType = response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            .trim()
            .toLowerCase();
          if (
            response.redirected ||
            response.status !== 200 ||
            !["application/dns-json", "application/json"].includes(contentType ?? "")
          )
            throw failure();
          return parsePacket(await readBoundedJson(response, signal, 65536), current, family);
        } finally {
          cancelBody(response);
        }
      }

      async function familyAnswers(family: Family): Promise<string[]> {
        let current = name;
        const visited = new Set([name]);
        let edges = 0;
        // Technical work bounds, not monitor quotas. At most eight resolver
        // requests per guard validation (four per family), including aliases.
        // A response may contain up to sixteen rooted CNAME edges in total.
        for (let queries = 0; queries < 4; queries++) {
          const answer = await request(current, family);
          const reachable = new Set([current]);
          let terminal = current;
          while (answer.aliases.has(terminal)) {
            if (answer.addresses.has(terminal) || ++edges > 16) throw failure();
            const next = answer.aliases.get(terminal);
            if (!next || visited.has(next)) throw failure();
            visited.add(next);
            reachable.add(next);
            terminal = next;
          }
          if (
            [...answer.aliases.keys()].some((owner) => !reachable.has(owner)) ||
            [...answer.addresses.keys()].some((owner) => owner !== terminal)
          )
            throw failure();
          const result = answer.addresses.get(terminal);
          if (result?.length) return result;
          if (terminal === current) return []; // Actual NOERROR/NODATA.
          current = terminal; // A CNAME-only packet has not answered this family.
        }
        throw failure();
      }

      const results = (await Promise.all([familyAnswers(1), familyAnswers(28)])).flat();
      if (!results.length) throw failure();
      return Object.freeze([...new Set(results)]);
    } catch {
      // Raw resolver, URL, stream and abort exceptions can contain internals.
      throw failure();
    } finally {
      try {
        parent?.removeEventListener("abort", abort);
      } catch {
        /* Cleanup cannot expose or replace the fixed validation error. */
      }
      local?.abort(); // Also cancels the sibling family on any failure.
    }
  };
}
