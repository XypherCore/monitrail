import { CHECK_CRON, type CheckerEnv, runCheckTick } from "./tick.ts";

const CHECK_MARKER = "check";
const CHECK_INTERVAL_MS = 60_000;

type QueueCheckerEnv = CheckerEnv & { CHECK_TICKS: Queue<typeof CHECK_MARKER> };

export default {
  fetch(): Response {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  },
  async scheduled(controller, env): Promise<void> {
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
