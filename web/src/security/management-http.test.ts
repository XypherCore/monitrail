import { describe, expect, it, vi } from "vitest";
import { createAlertHandlers } from "../alerts/http.ts";
import { createMonitorHandlers } from "../monitors/http.ts";
import { createStatusPageHandlers } from "../status-pages/owner-http.ts";
import { ManagementRateError } from "./management-rate.ts";

const origin = "https://app.example.invalid";
const id = "10000000-0000-4000-8000-000000000001";

function setup() {
  const authenticate = vi.fn(async () => { throw new ManagementRateError(120); });
  const common = { origin: () => origin, authenticate };
  return {
    authenticate,
    monitor: createMonitorHandlers({ ...common, mapError: () => null }),
    alert: createAlertHandlers(common),
    status: createStatusPageHandlers({ ...common, invalidate: () => {} }),
  };
}

function request(method: string, from = origin) {
  return new Request(`${origin}/api/fixture`, {
    method,
    headers: { origin: from, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("management limit HTTP responses", () => {
  it("returns private 429 responses across every monitor, channel and status-page write", async () => {
    const { monitor, alert, status } = setup();
    const results = await Promise.all([
      monitor.create(request("POST")),
      monitor.update(request("PATCH"), id),
      monitor.delete(request("DELETE"), id),
      monitor.subscriptions(request("PUT"), id),
      alert.create(request("POST")),
      alert.rename(request("PATCH"), id),
      alert.remove(request("DELETE"), id),
      alert.test(request("POST"), id),
      alert.telegram(request("POST")),
      status.create(request("POST")),
      status.update(request("PATCH"), id),
      status.remove(request("DELETE"), id),
    ]);
    for (const response of results) {
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("120");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect((await response.json()).error.message).toContain("60 management changes per hour");
    }
  });

  it("rejects cross-origin requests before authenticating or reserving a write", async () => {
    const { monitor, alert, status, authenticate } = setup();
    expect((await monitor.create(request("POST", "https://foreign.example.invalid"))).status).toBe(403);
    expect((await alert.create(request("POST", "https://foreign.example.invalid"))).status).toBe(403);
    expect((await status.create(request("POST", "https://foreign.example.invalid"))).status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });
});
