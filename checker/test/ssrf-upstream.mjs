const attemptId = (index) => `00000000-0000-4000-8000-00000000000${index}`;
const monitorId = (index) => `10000000-0000-4000-8000-00000000000${index}`;

const tickJob = (index, url) => ({
  attempt_id: attemptId(index),
  monitor_id: monitorId(index),
  config_rev: 1,
  url,
  expected_status: "2xx_3xx",
  due_at: "2026-11-08T00:00:00.000Z",
});

async function controlResponse(request) {
  if (
    request.method !== "POST" ||
    request.headers.get("content-type") !== "application/json" ||
    !/^\d+$/.test(request.headers.get("x-monitrail-ts") ?? "") ||
    !/^[a-f\d-]{36}$/.test(request.headers.get("x-monitrail-nonce") ?? "") ||
    !/^[a-f\d]{64}$/.test(request.headers.get("x-monitrail-sig") ?? "")
  ) return new Response(null, { status: 400 });

  const body = await request.json();
  if (request.url === "https://monitor.example/api/internal/claim" && body.max === 15) {
    return Response.json({
      jobs: [
        tickJob(1, "https://public.example/terminal?token=synthetic-private"),
        tickJob(2, "http://169.254.169.254/"),
      ],
      blocklist: [],
    });
  }
  if (request.url === "https://monitor.example/api/internal/ingest") {
    const [terminal, blocked] = body.results ?? [];
    if (
      body.results?.length !== 2 ||
      terminal?.attempt_id !== attemptId(1) ||
      terminal.status_code !== 302 ||
      !Number.isInteger(terminal.response_ms) ||
      blocked?.attempt_id !== attemptId(2) ||
      blocked.error_type !== "blocked" ||
      JSON.stringify(body).includes("synthetic-private")
    ) return new Response(null, { status: 400 });

    return Response.json({
      results: [1, 2].map((index) => ({ attempt_id: attemptId(index), outcome: "accepted" })),
    });
  }
  return new Response(null, { status: 404 });
}

export default {
  fetch(request) {
    if (new URL(request.url).origin === "https://monitor.example") return controlResponse(request);
    if (request.method !== "GET") throw new Error("Unexpected fixture method.");
    if (request.url === "https://public.example/terminal?token=synthetic-private") {
      if (request.headers.has("x-monitrail-sig")) throw new Error("Unexpected target signature.");
      return new Response(null, { status: 302 });
    }
    if (request.url === "https://public.example/redirect")
      return Response.redirect("http://127.0.0.1/");
    if (request.url === "https://public.example/body") return new Response(new Uint8Array(131072));
    const chain = /^https:\/\/public\.example\/chain\/([0-2])$/.exec(request.url);
    if (chain) return Response.redirect(`https://public.example/chain/${Number(chain[1]) + 1}`);
    throw new Error("Unexpected fixture URL.");
  },
};
