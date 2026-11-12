import { describe, expect, it, vi } from "vitest";
import type { ChannelIdentity } from "./contracts.ts";
import { createAlertSender } from "./delivery.ts";
import { WebGuardError } from "../security/web-ssrf.ts";

const identity: ChannelIdentity = {
  id: "e8648db9-6f1a-4f68-bb72-a2e696a76b48",
  userId: "045fe056-8fbf-4711-b7ec-6f42e7526099",
  type: "webhook",
};
const eventId = "43309c80-b220-4a86-ac2a-00e6f4d2b6e0";
const now = new Date("2026-11-12T00:00:00Z");
const url = "https://example.test/hook?token=fixture-secret";
const incident = {
  version: 1,
  event: "incident.opened",
  event_id: eventId,
  monitor: { name: "Demo <!channel> @everyone", url: "must-not-leak" },
  incident: {
    started_at: "2026-11-11T00:00:00+00:00",
    confirmed_at: "2026-11-11T00:01:00+00:00",
    resolved_at: null,
    cause: "timeout",
    body: "must-not-leak",
  },
  sent_at: null,
  configEnc: "must-not-leak",
};

function fixture() {
  const guard = {
    sendWebhook: vi.fn(async (..._args: unknown[]) => ({ statusCode: 204 })),
    sendTelegram: vi.fn(async (..._args: unknown[]) => ({ statusCode: 200 })),
  };
  const decrypt = vi.fn((_config: string, channel: ChannelIdentity) =>
    channel.type === "telegram" ? { chatId: "123456" } : { url },
  );
  const send = createAlertSender({
    cipher: { decrypt },
    guard,
    botToken: "123456:fixture_Bot_Token_Is_Not_Real",
    now: () => now,
  });
  return { guard, decrypt, send };
}

describe("alert provider adapters", () => {
  it("projects only versioned generic payload fields and keeps the event ID stable", async () => {
    const f = fixture();
    const input = { ...identity, configEnc: "envelope", payload: incident };
    expect(await f.send(input)).toEqual({ ok: true });
    expect(await f.send(input)).toEqual({ ok: true });
    expect(f.guard.sendWebhook).toHaveBeenCalledTimes(2);
    for (const [destination, type, payload] of f.guard.sendWebhook.mock.calls) {
      expect([destination, type]).toEqual([url, "webhook"]);
      expect(payload).toEqual({
        version: 1,
        event: "incident.opened",
        event_id: eventId,
        monitor: { name: incident.monitor.name },
        incident: {
          started_at: "2026-11-11T00:00:00.000Z",
          confirmed_at: "2026-11-11T00:01:00.000Z",
          resolved_at: null,
          cause: "timeout",
        },
        sent_at: now.toISOString(),
      });
    }
    expect(f.decrypt).toHaveBeenCalledWith("envelope", identity);
  });

  it("sends a distinct generic test event with no incident details", async () => {
    const f = fixture();
    const payload = { version: 1, event: "alert.test", event_id: eventId, sent_at: null };
    expect(await f.send({ ...identity, configEnc: "envelope", payload })).toEqual({ ok: true });
    expect(f.guard.sendWebhook).toHaveBeenCalledWith(url, "webhook", {
      ...payload,
      sent_at: now.toISOString(),
    });
  });

  it("prevents provider-side mentions, previews, and secret projection", async () => {
    const f = fixture();
    for (const type of ["slack", "discord", "telegram"] as const) {
      expect(await f.send({ ...identity, type, configEnc: "envelope", payload: incident }))
        .toEqual({ ok: true });
    }
    const slack = f.guard.sendWebhook.mock.calls[0][2];
    expect(slack).toMatchObject({
      text: expect.stringContaining("&lt;!channel&gt;"),
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    const discord = f.guard.sendWebhook.mock.calls[1][2];
    expect(discord).toMatchObject({ allowed_mentions: { parse: [] }, flags: 4 });
    expect(f.guard.sendTelegram.mock.calls[0][1]).toBe("123456");
    expect(f.guard.sendTelegram.mock.calls[0][2]).toEqual(expect.stringContaining("Demo"));
    for (const output of [slack, discord, f.guard.sendTelegram.mock.calls[0][2]]) {
      expect(JSON.stringify(output)).not.toMatch(/must-not-leak|fixture-secret/);
    }
  });

  it("rejects corrupt payloads before decrypting and returns only safe error categories", async () => {
    const f = fixture();
    const input = { ...identity, configEnc: "envelope", payload: incident };
    expect(await f.send({ ...input, payload: { ...incident, event_id: "wrong" } })).toEqual({
      ok: false,
      category: "other",
    });
    expect(f.decrypt).not.toHaveBeenCalled();
    f.guard.sendWebhook.mockRejectedValueOnce(new WebGuardError("blocked"));
    expect(await f.send(input)).toEqual({ ok: false, category: "blocked" });
    f.guard.sendWebhook.mockRejectedValueOnce(new Error("provider-secret"));
    expect(await f.send(input)).toEqual({ ok: false, category: "other" });
    f.decrypt.mockImplementationOnce(() => { throw new Error("configuration-secret"); });
    expect(await f.send(input)).toEqual({ ok: false, category: "other" });
    expect(f.guard.sendWebhook).toHaveBeenCalledTimes(2);
  });
});
