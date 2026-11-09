import type { BlockedHost } from "../../../shared/ssrf/blocklist.ts";

export type ClaimedCheck = Readonly<{
  attemptId: string;
  monitorId: string;
  configRev: number;
  url: string;
  expectedStatus: "2xx" | "2xx_3xx";
  dueAt: Date;
}>;

export type AttemptResult = (
  | { statusCode: number; responseMs: number }
  | { errorType: "blocked" | "connect" | "dns" | "other" | "timeout" | "tls" }
) &
  Readonly<{
    attemptId: string;
    monitorId: string;
    configRev: number;
    startedAt: Date;
    redirectCount: number;
  }>;

/**
 * Implementation contracts for authenticated internal entry points and admin
 * tooling. Their implementations belong to the checking and delivery phases.
 * The user DAL never receives or constructs one of these capabilities.
 */
export interface CheckCapabilities {
  claimChecks(input: Readonly<{ max: 15 }>): Promise<{
    jobs: readonly ClaimedCheck[];
    blocklist: readonly BlockedHost[];
  }>;
  ingestResults(input: Readonly<{ results: readonly AttemptResult[] }>): Promise<
    readonly {
      attemptId: string;
      outcome: "accepted" | "dropped" | "error";
    }[]
  >;
}

export interface MaintenanceCapability {
  runMaintenance(): Promise<{ removed: number; dnsRevalidated: number; blocked: number }>;
}

export interface OutboxCapability {
  deliverOutbox(): Promise<{ sent: number; retrying: number; failed: number }>;
}

export interface BlocklistCapability {
  manageBlocklist(
    input:
      | Readonly<{ action: "add"; host: string; includeSubdomains: boolean; reason: string }>
      | Readonly<{ action: "remove"; host: string }>,
  ): Promise<void>;
}

export interface TelegramCapability {
  handleTelegramWebhook(
    input: Readonly<{
      code: string;
      chatId: string;
      chatType: "private";
    }>,
  ): Promise<{ linked: boolean }>;
}
