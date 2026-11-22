import { sql } from "drizzle-orm";
import { canonicalPolicyHost } from "../../../shared/ssrf/address.ts";
import type { DataExecutor } from "../data/access.ts";
import type { BlocklistCapability } from "./capabilities.ts";

export const BLOCKLIST_REASON = "verified_owner_request";
type Command = Parameters<BlocklistCapability["manageBlocklist"]>[0];
type Verification = Readonly<{ domainControlVerified: true }>;

function refused(): Error {
  return new Error("Blocklist command was refused.");
}

function exactKeys(value: object, names: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === names.length && keys.every((key) => names.includes(key));
}

function command(input: unknown): Command {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw refused();
  const value = input as Record<string, unknown>;
  if (typeof value.host !== "string" || value.host.length > 1024) throw refused();
  const host = canonicalPolicyHost(value.host);
  if (!host) throw refused();
  if (value.action === "remove" && exactKeys(value, ["action", "host"])) {
    return { action: "remove", host };
  }
  if (
    value.action !== "add" ||
    !exactKeys(value, ["action", "host", "includeSubdomains", "reason"]) ||
    typeof value.includeSubdomains !== "boolean" ||
    value.reason !== BLOCKLIST_REASON
  ) throw refused();
  return { action: "add", host, includeSubdomains: value.includeSubdomains, reason: BLOCKLIST_REASON };
}

/** Narrow capability constructed only by the authenticated administrator CLI. */
export function createBlocklistCapability(db: DataExecutor, verification: Verification): BlocklistCapability {
  if (
    !verification || typeof verification !== "object" ||
    !exactKeys(verification, ["domainControlVerified"]) ||
    verification.domainControlVerified !== true || !db.transaction
  ) throw refused();
  const transaction = db.transaction.bind(db);
  return {
    async manageBlocklist(input) {
      const selected = command(input);
      try {
        await transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
          await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`blocklist:${selected.host}`}::text,0))`);
          if (selected.action === "add") {
            await tx.execute(sql`
              INSERT INTO blocked_hosts(host,include_subdomains,reason)
              VALUES (${selected.host},${selected.includeSubdomains},${BLOCKLIST_REASON})
              ON CONFLICT (host) DO UPDATE SET
                include_subdomains=excluded.include_subdomains,reason=excluded.reason
            `);
          } else {
            await tx.execute(sql`DELETE FROM blocked_hosts WHERE host=${selected.host}`);
          }
        }, { isolationLevel: "read committed" });
      } catch {
        // Driver diagnostics may contain queries, credentials or supplied hosts.
        throw new Error("Blocklist update could not be completed.");
      }
    },
  };
}

/** Parse a bounded, explicit operator command without opening a connection. */
export function parseBlockHostArguments(args: readonly string[]): { apply: boolean; command: Command } {
  if (!Array.isArray(args) || args.length < 3 || args.length > 5 || args.some((item) => typeof item !== "string")) throw refused();
  const [action, host, ...flags] = args;
  if (!["add", "remove"].includes(action) || new Set(flags).size !== flags.length) throw refused();
  if (flags.some((flag) => !["--dry-run", "--apply", "--confirm-domain-control", "--exact-host"].includes(flag))) throw refused();
  const apply = flags.includes("--apply");
  if (apply === flags.includes("--dry-run") || (apply && !flags.includes("--confirm-domain-control"))) throw refused();
  if (action === "remove" && flags.includes("--exact-host")) throw refused();
  return {
    apply,
    command: command(action === "add"
      ? { action, host, includeSubdomains: !flags.includes("--exact-host"), reason: BLOCKLIST_REASON }
      : { action, host }),
  };
}
