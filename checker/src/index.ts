import {
  INTERNAL_MAINTENANCE_PATH,
  signInternalRequest,
} from "../../shared/checks/signing.ts";
import { awaitSignal, cancelBody, type Transport } from "../../shared/ssrf/io.ts";
import {
  applicationOrigin,
  CHECK_CRON,
  type CheckerEnv,
  LEASE_WINDOW_MS,
  readControlJSON,
  runCheckTick,
} from "./tick.ts";

const CHECK_MARKER = "check";
const CHECK_INTERVAL_MS = 60_000;
export const MAINTENANCE_CRON = "17 3 * * *";

type QueueCheckerEnv = CheckerEnv & { CHECK_TICKS: Queue<typeof CHECK_MARKER> };

async function runMaintenance(env: CheckerEnv): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), LEASE_WINDOW_MS);
  try {
    const origin = applicationOrigin(env.APP_URL);
    const body = "{}";
    const headers = await signInternalRequest(env.INTERNAL_HMAC_SECRET, INTERNAL_MAINTENANCE_PATH, body);
    const transport: Transport = fetch;
    const response = await awaitSignal(
      transport(origin + INTERNAL_MAINTENANCE_PATH, {
        method: "POST",
        headers,
        body,
        cache: "no-store",
        redirect: "manual",
        credentials: "omit",
        signal: deadline.signal,
      }).then((result) => {
        if (deadline.signal.aborted) cancelBody(result);
        return result;
      }),
      deadline.signal,
    );
    try {
      const result = await readControlJSON(response, deadline.signal);
      const keys = ["removed", "dnsRevalidated", "blocked"];
      if (
        typeof result !== "object" || result === null || Array.isArray(result) ||
        Object.keys(result).length !== keys.length ||
        keys.some((key) => !Number.isSafeInteger(Reflect.get(result, key)) || Reflect.get(result, key) < 0)
      ) throw new Error("Invalid maintenance response.");
    } finally {
      cancelBody(response);
    }
  } catch {
    throw new Error("Maintenance request failed.");
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}

export default {
  fetch(): Response {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  },
  async scheduled(controller, env): Promise<void> {
    if (controller.cron === MAINTENANCE_CRON) {
      await runMaintenance(env);
      return;
    }
    if (controller.cron !== CHECK_CRON) return;
    try {
      await env.CHECK_TICKS.send(CHECK_MARKER);
    } catch {
      throw new Error("Checker tick enqueue failed.");
    }
  },
  async queue(batch, env): Promise<void> {
    const [message] = batch.messages;
    if (batch.messages.length !== 1 || message.body !== CHECK_MARKER) return;

    const delay = Date.now() - message.timestamp.getTime();
    if (!Number.isFinite(delay) || delay >= CHECK_INTERVAL_MS) return;

    const metrics = await runCheckTick(env);
    console.log("checker_tick", { ...metrics, queueDelayMs: Math.max(0, delay) });
    if (metrics.outcome !== "completed" && metrics.outcome !== "idle") {
      throw new Error("Checker tick failed.");
    }
  },
} satisfies ExportedHandler<QueueCheckerEnv>;
