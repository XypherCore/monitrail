import { CHECK_CRON, type CheckerEnv, runCheckTick } from "./tick.ts";

export default {
  fetch(): Response {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  },
  async scheduled(controller, env): Promise<void> {
    if (controller.cron !== CHECK_CRON) return;
    const metrics = await runCheckTick(env);
    console.log("checker_tick", metrics);
    if (metrics.outcome !== "completed" && metrics.outcome !== "idle") {
      throw new Error("Checker tick failed.");
    }
  },
} satisfies ExportedHandler<CheckerEnv>;
