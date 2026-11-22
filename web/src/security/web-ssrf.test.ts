import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Agent, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkerUserAgent } from "../../../shared/identity.ts";
import { createWebGuard, WebGuardError } from "./web-ssrf.ts";

const appUrl = "https://app.example.test";
const target = "https://recipient.example.test/hooks?token=fixture-secret";
const publicRecords = [
  { address: "1.1.1.1", family: 4 },
  { address: "2606:4700:4700::1111", family: 6 },
];

type Call = {
  options: RequestOptions;
  request: ClientRequest;
  callback: (response: IncomingMessage) => void;
  body?: unknown;
  connectedAddress?: string;
};

function response(statusCode = 204) {
  const stream = new PassThrough() as unknown as IncomingMessage;
  stream.statusCode = statusCode;
  stream.headers = { location: "http://127.0.0.1/", "x-fixture-secret": "fixture-response-secret" };
  vi.spyOn(stream, "destroy");
  vi.spyOn(stream, "read");
  return stream;
}

function fixture(makeReply: () => IncomingMessage = response, origin = appUrl) {
  const calls: Call[] = [];
  const replies: IncomingMessage[] = [];
  const resolve = vi.fn(async (_host: string) => publicRecords);
  const isBlockedHost = vi.fn(async (_host: string) => false);
  const request = vi.fn((options: RequestOptions, callback: (reply: IncomingMessage) => void) => {
    const handle = new EventEmitter() as ClientRequest;
    const call: Call = { options, request: handle, callback };
    handle.destroy = vi.fn(() => handle);
    handle.end = vi.fn((body: unknown) => {
      call.body = body;
      queueMicrotask(() => {
        const connected = (address: string) => {
          call.connectedAddress = address;
          const reply = makeReply();
          replies.push(reply);
          callback(reply);
        };
        const host = String(options.hostname);
        if (isIP(host)) connected(host);
        else
          options.lookup?.(host, {}, (error, address) => {
            if (error) handle.emit("error", error);
            else connected(String(address));
          });
      });
      return handle;
    }) as ClientRequest["end"];
    calls.push(call);
    return handle;
  });
  const guard = createWebGuard({ appUrl: origin, isBlockedHost }, { resolve, request });
  return { guard, resolve, isBlockedHost, request, calls, replies };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Node monitor admission", () => {
  it("canonicalizes and validates DNS without making a target request", async () => {
    const f = fixture();
    expect(
      await f.guard.validateMonitor("https://PUBLIC.example.test./health?key=fixture"),
    ).toEqual({
      url: "https://public.example.test/health?key=fixture",
      host: "public.example.test",
    });
    expect(f.isBlockedHost).toHaveBeenCalledWith(
      "public.example.test",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(f.resolve).toHaveBeenCalledWith(
      "public.example.test",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(f.request).not.toHaveBeenCalled();
  });

  it("validates and blocks public literals without DNS", async () => {
    const f = fixture();
    expect(await f.guard.validateMonitor("http://0x01010101:8080/")).toEqual({
      url: "http://1.1.1.1:8080/",
      host: "1.1.1.1",
    });
    expect(f.resolve).not.toHaveBeenCalled();
    f.isBlockedHost.mockResolvedValue(true);
    await expect(f.guard.validateMonitor("https://[::ffff:1.1.1.1]/")).rejects.toMatchObject({
      code: "blocked",
    });
    expect(f.isBlockedHost).toHaveBeenLastCalledWith("1.1.1.1", expect.anything());
  });

  it.each([
    "http://127.1/",
    "http://169.254.169.254/",
    "https://[fd00:ec2::254]/",
    "https://@public.example.test/",
    "https://user:pass@public.example.test/",
    "http://single/",
    "file:///etc/passwd",
    "https://public.example.test:22/",
  ])("rejects a forbidden static target before DNS (%s)", async (url) => {
    const f = fixture();
    await expect(f.guard.validateMonitor(url)).rejects.toMatchObject({ code: "blocked" });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "169.254.169.254", "::ffff:127.0.0.1", "fd00::1"])(
    "rejects any unsafe answer (%s)",
    async (address) => {
      const f = fixture();
      f.resolve.mockResolvedValue([...publicRecords, { address, family: isIP(address) }]);
      await expect(f.guard.validateMonitor(target)).rejects.toMatchObject({ code: "blocked" });
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("fails closed on empty, malformed or failed resolver and blocklist replies", async () => {
    const f = fixture();
    f.resolve.mockResolvedValueOnce([]).mockResolvedValueOnce([{ address: "1.1.1.1", family: 6 }]);
    await expect(f.guard.validateMonitor(target)).rejects.toMatchObject({ code: "dns" });
    await expect(f.guard.validateMonitor(target)).rejects.toMatchObject({ code: "dns" });
    f.resolve.mockRejectedValueOnce(new Error("private resolver detail"));
    await expect(f.guard.validateMonitor(target)).rejects.toMatchObject({ code: "dns" });
    f.isBlockedHost.mockRejectedValueOnce(new Error("private policy detail"));
    await expect(f.guard.validateMonitor(target)).rejects.toMatchObject({ code: "blocked" });
  });
});

describe("Node guarded webhook transport", () => {
  it("registers only the fixed Telegram webhook method and canonical application callback", async () => {
    const botToken = "123456:fixture_Bot_Token_Is_Not_Real";
    const secret = "fixture_telegram_webhook_secret_is_not_real";
    const f = fixture(() => {
      const reply = response(200);
      (reply as unknown as PassThrough).end('{"ok":true,"result":true}');
      return reply;
    });
    await expect(f.guard.registerTelegramWebhook(botToken, secret)).resolves.toEqual({ statusCode: 200 });
    expect(f.calls[0].options).toMatchObject({
      hostname: "api.telegram.org", port: 443, path: `/bot${botToken}/setWebhook`,
      method: "POST", servername: "api.telegram.org", rejectUnauthorized: true,
    });
    expect(f.calls[0].connectedAddress).toBe("1.1.1.1");
    expect(JSON.parse(String(f.calls[0].body))).toEqual({
      url: `${appUrl}/api/telegram/webhook`, secret_token: secret, allowed_updates: ["message"],
    });
    expect(f.isBlockedHost.mock.calls.map(([host]) => host)).toEqual(["app.example.test", "api.telegram.org"]);
    expect(f.resolve.mock.calls.map(([host]) => host)).toEqual(["app.example.test", "api.telegram.org"]);
    expect(f.replies[0].destroy).toHaveBeenCalled();
  });

  it("rejects unsafe Telegram registration settings before making a request", async () => {
    const f = fixture();
    const token = "123456:fixture_Bot_Token_Is_Not_Real";
    const secret = "fixture_telegram_webhook_secret_is_not_real";
    await expect(f.guard.registerTelegramWebhook(`${token}/getMe`, secret)).rejects.toMatchObject({ code: "blocked" });
    await expect(f.guard.registerTelegramWebhook(token, "too-short")).rejects.toMatchObject({ code: "blocked" });
    expect(f.request).not.toHaveBeenCalled();
    for (const origin of ["http://app.example.test", "https://127.0.0.1", "https://[::1]"]) {
      const unsafe = fixture(response, origin);
      await expect(unsafe.guard.registerTelegramWebhook(token, secret)).rejects.toMatchObject({ code: "blocked" });
      expect(unsafe.request).not.toHaveBeenCalled();
    }
  });

  it.each(["app.example.test", "api.telegram.org"])("refuses a private DNS answer while registering Telegram (%s)", async (privateHost) => {
    const f = fixture();
    f.resolve.mockImplementation(async (host) => host === privateHost ? [{ address: "10.0.0.1", family: 4 }] : publicRecords);
    await expect(f.guard.registerTelegramWebhook("123456:fixture_Bot_Token_Is_Not_Real", "fixture_telegram_webhook_secret_is_not_real"))
      .rejects.toMatchObject({ code: "blocked" });
    expect(f.calls.every((call) => call.connectedAddress === undefined)).toBe(true);
  });

  it.each(["app.example.test", "api.telegram.org"])("refuses a blocklisted registration host (%s)", async (blockedHost) => {
    const f = fixture();
    f.isBlockedHost.mockImplementation(async (host) => host === blockedHost);
    await expect(f.guard.registerTelegramWebhook("123456:fixture_Bot_Token_Is_Not_Real", "fixture_telegram_webhook_secret_is_not_real"))
      .rejects.toMatchObject({ code: "blocked" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    [302, '{"ok":true,"result":true}'], [200, '{"ok":false,"description":"private-provider-detail"}'],
    [200, '{"ok":true,"result":false}'], [200, "private-invalid-reply"],
    [200, JSON.stringify({ ok: true, result: true, extra: "x".repeat(65_536) })],
  ] as const)("refuses unsuccessful Telegram registration without exposing the provider reply (%i)", async (status, body) => {
    const f = fixture(() => {
      const reply = response(status);
      (reply as unknown as PassThrough).end(body);
      return reply;
    });
    const failure = await f.guard.registerTelegramWebhook("123456:fixture_Bot_Token_Is_Not_Real", "fixture_telegram_webhook_secret_is_not_real").catch((error) => error);
    expect(failure).toMatchObject({ code: "bad_status" });
    expect(String(failure)).not.toMatch(/private-|fixture_Bot_Token/);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("keeps the existing five-second total deadline for Telegram registration", async () => {
    vi.useFakeTimers();
    const f = fixture(() => response(200));
    const result = expect(f.guard.registerTelegramWebhook("123456:fixture_Bot_Token_Is_Not_Real", "fixture_telegram_webhook_secret_is_not_real"))
      .rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(f.replies[0].destroy).toHaveBeenCalled();
  });

  it("validates an exact webhook and its public DNS without posting", async () => {
    const f = fixture();
    expect(await f.guard.validateWebhook("https://discord.com/api/webhooks/123/fixture", "discord"))
      .toEqual({ url: "https://discord.com/api/webhooks/123/fixture", host: "discord.com" });
    f.resolve.mockResolvedValueOnce([{ address: "192.168.0.1", family: 4 }]);
    await expect(f.guard.validateWebhook(target, "webhook")).rejects.toMatchObject({ code: "blocked" });
    await expect(f.guard.validateWebhook("http://recipient.example.test/", "webhook"))
      .rejects.toMatchObject({ code: "blocked" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("adds Discord confirmation only after the user URL passes the allowlist", async () => {
    const f = fixture();
    await f.guard.sendWebhook("https://discord.com/api/webhooks/123/fixture", "discord", {});
    expect(f.calls[0].options.path).toBe("/api/webhooks/123/fixture?wait=true");
    await expect(f.guard.sendWebhook(
      "https://discord.com/api/webhooks/123/fixture?wait=false", "discord", {},
    )).rejects.toMatchObject({ code: "blocked" });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("uses only a fixed Telegram API target, checks the success flag and disables previews", async () => {
    const botToken = "123456:fixture_Bot_Token_Is_Not_Real";
    const f = fixture(() => {
      const reply = response(200);
      (reply as unknown as PassThrough).end('{"ok":true,"result":{"ignored":"fixture"}}');
      return reply;
    });
    await expect(f.guard.sendTelegram(botToken, "123456", "fixture test")).resolves.toEqual({ statusCode: 200 });
    expect(f.calls[0].options).toMatchObject({
      hostname: "api.telegram.org",
      path: `/bot${botToken}/sendMessage`,
      method: "POST",
    });
    expect(JSON.parse(String(f.calls[0].body))).toEqual({
      chat_id: "123456",
      text: "fixture test",
      link_preview_options: { is_disabled: true },
    });
    await expect(f.guard.sendTelegram(`${botToken}/getMe`, "123456", "x"))
      .rejects.toMatchObject({ code: "blocked" });
    await expect(f.guard.sendTelegram(botToken, "-123456", "x"))
      .rejects.toMatchObject({ code: "blocked" });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it.each([
    [302, '{"ok":true}'],
    [200, '{"ok":false,"description":"sensitive provider response"}'],
    [200, JSON.stringify({ ok: true, result: "x".repeat(65_536) })],
    [200, "invalid provider response"],
  ] as const)("fails closed on Telegram status or response (%i)", async (status, body) => {
    const f = fixture(() => {
      const reply = response(status);
      (reply as unknown as PassThrough).end(body);
      return reply;
    });
    const failure = await f.guard.sendTelegram("123456:fixture_Bot_Token_Is_Not_Real", "123456", "x")
      .catch((error) => error);
    expect(failure).toMatchObject({ code: "bad_status" });
    expect(String(failure)).not.toMatch(/sensitive provider|fixture_Bot_Token/);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("does not extend the transport budget for a stalled Telegram response", async () => {
    vi.useFakeTimers();
    const f = fixture(() => response(200));
    const result = expect(f.guard.sendTelegram("123456:fixture_Bot_Token_Is_Not_Real", "123456", "x"))
      .rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(f.replies[0].destroy).toHaveBeenCalled();
  });

  it("dials only the connect-time vetted answer with the original HTTP and TLS identity", async () => {
    const f = fixture();
    expect(await f.guard.sendWebhook(target, "webhook", { event: "fixture" })).toEqual({
      statusCode: 204,
    });
    expect(f.calls[0].connectedAddress).toBe("1.1.1.1");
    const options = f.calls[0].options;
    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "recipient.example.test",
      port: 443,
      path: "/hooks?token=fixture-secret",
      method: "POST",
      servername: "recipient.example.test",
      rejectUnauthorized: true,
      autoSelectFamily: false,
    });
    expect(options.headers).toEqual({
      Host: "recipient.example.test",
      "User-Agent": checkerUserAgent(appUrl),
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(JSON.stringify({ event: "fixture" })),
      Connection: "close",
    });
    expect(options.agent).toBeInstanceOf(Agent);
    expect((options.agent as Agent).options).toMatchObject({
      keepAlive: false,
      maxCachedSessions: 0,
      maxSockets: 1,
      proxyEnv: undefined,
    });
    expect(options.checkServerIdentity).toEqual(expect.any(Function));
    const mismatch = options.checkServerIdentity?.("attacker.example.test", {
      subjectaltname: "DNS:attacker.example.test",
    } as never);
    expect(mismatch).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(f.calls[0].body).toEqual(JSON.stringify({ event: "fixture" }));
    expect(f.replies[0].read).not.toHaveBeenCalled();
    expect(f.replies[0].destroy).toHaveBeenCalled();
    expect(f.calls[0].request.destroy).toHaveBeenCalled();
  });

  it("makes a fresh request and DNS decision for every delivery", async () => {
    const f = fixture();
    await f.guard.validateMonitor(target);
    f.resolve.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    await expect(f.guard.sendWebhook(target, "webhook", {})).rejects.toMatchObject({
      code: "blocked",
    });
    expect(f.calls[0].connectedAddress).toBeUndefined();
    f.resolve.mockResolvedValue(publicRecords);
    await f.guard.sendWebhook(target, "webhook", {});
    await f.guard.sendWebhook(target, "webhook", {});
    expect(f.calls[1].options.agent).not.toBe(f.calls[2].options.agent);
    expect(f.resolve).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["http://recipient.example.test/", "webhook"],
    ["https://recipient.example.test:8443/", "webhook"],
    ["https://hooks.slack.com.evil.test/services/T1/B2/token", "slack"],
    ["https://hooks.slack.com/services/T1/B2/token?secret=fixture", "slack"],
    ["https://discord.com/api/v10/webhooks/1/token", "discord"],
    ["https://discord.com/api/webhooks/1/token#fragment", "discord"],
  ] as const)("rejects an invalid provider URL before requests (%s)", async (url, provider) => {
    const f = fixture();
    await expect(f.guard.sendWebhook(url, provider, {})).rejects.toMatchObject({ code: "blocked" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    ["https://hooks.slack.com/services/T1/B2/fixture", "slack"],
    ["https://discord.com/api/webhooks/123/fixture", "discord"],
  ] as const)("sends to an exact supported provider URL (%s)", async (url, provider) => {
    const f = fixture();
    expect(await f.guard.sendWebhook(url, provider, {})).toEqual({ statusCode: 204 });
  });

  it("never follows redirects and returns a failed-delivery category", async () => {
    const f = fixture();
    f.request.mockImplementationOnce((options, callback) => {
      const handle = new EventEmitter() as ClientRequest;
      handle.destroy = vi.fn(() => handle);
      handle.end = vi.fn(() => {
        queueMicrotask(() => callback(response(302)));
        return handle;
      }) as ClientRequest["end"];
      f.calls.push({ options, request: handle, callback });
      return handle;
    });
    await expect(f.guard.sendWebhook(target, "webhook", {})).rejects.toMatchObject({
      code: "bad_status",
    });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it.each(["policy", "dns", "headers"])(
    "uses one five-second deadline while %s stalls",
    async (stage) => {
      vi.useFakeTimers();
      const f = fixture();
      if (stage === "policy") f.isBlockedHost.mockImplementation(() => new Promise(() => {}));
      if (stage === "dns") f.resolve.mockImplementation(() => new Promise(() => {}));
      if (stage === "headers")
        f.request.mockImplementationOnce((options, callback) => {
          const handle = new EventEmitter() as ClientRequest;
          handle.end = vi.fn(() => handle) as ClientRequest["end"];
          handle.destroy = vi.fn(() => handle);
          f.calls.push({ options, request: handle, callback });
          return handle;
        });
      const rejected = expect(f.guard.sendWebhook(target, "webhook", {})).rejects.toMatchObject({
        code: "timeout",
      });
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      for (const call of f.calls) expect(call.request.destroy).toHaveBeenCalled();
    },
  );

  it("emits fixed errors without response content, target query strings or raw exceptions", async () => {
    const f = fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    f.request.mockImplementationOnce(() => {
      throw new Error("private transport detail");
    });
    const failure = await f.guard.sendWebhook(target, "webhook", {}).catch((value) => value);
    expect(failure).toBeInstanceOf(WebGuardError);
    expect(failure.code).toBe("connect");
    expect(String(failure)).not.toMatch(/fixture-secret|private transport/);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps IPv6 literal Host and certificate identity while skipping DNS and SNI", async () => {
    const f = fixture();
    await f.guard.sendWebhook("https://[2606:4700:4700::1111]/hook", "webhook", {});
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.calls[0].options).toMatchObject({
      hostname: "2606:4700:4700::1111",
      servername: "",
      headers: { Host: "[2606:4700:4700::1111]" },
    });
  });

  it("returns a vetted single candidate when the socket requests all lookup addresses", async () => {
    const f = fixture();
    const addresses = vi.fn();
    f.request.mockImplementationOnce((options, callback) => {
      const handle = new EventEmitter() as ClientRequest;
      handle.destroy = vi.fn(() => handle);
      handle.end = vi.fn(() => {
        options.lookup?.("recipient.example.test", { all: true }, (error, records) => {
          addresses(error, records);
          if (error) handle.emit("error", error);
          else callback(response());
        });
        return handle;
      }) as ClientRequest["end"];
      return handle;
    });
    await f.guard.sendWebhook(target, "webhook", {});
    expect(addresses).toHaveBeenCalledWith(null, [{ address: "1.1.1.1", family: 4 }]);
  });

  it("rejects late lookup calls and a lookup for a different host", async () => {
    const f = fixture();
    await f.guard.sendWebhook(target, "webhook", {});
    const lookup = f.calls[0].options.lookup;
    const all = vi.fn();
    // The completed operation's signal is aborted, so even a late lookup
    // callback must fail instead of creating a new connection.
    lookup?.("recipient.example.test", { all: true }, all);
    await vi.waitFor(() => expect(all).toHaveBeenCalledOnce());
    expect(all.mock.calls[0][0]).toMatchObject({ code: "timeout" });
    const mismatch = vi.fn();
    lookup?.("different.example.test", {}, mismatch);
    expect(mismatch.mock.calls[0][0]).toMatchObject({ code: "blocked" });
  });

  it("classifies TLS failures without including the certificate or endpoint details", async () => {
    const f = fixture();
    f.request.mockImplementationOnce(() => {
      throw Object.assign(new Error("fixture certificate and private destination"), {
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      });
    });
    const failure = await f.guard.sendWebhook(target, "webhook", {}).catch((value) => value);
    expect(failure).toMatchObject({ code: "tls" });
    expect(String(failure)).not.toContain("private destination");
  });

  it("rejects malformed policy decisions and non-JSON payloads before sending", async () => {
    const f = fixture();
    f.isBlockedHost.mockResolvedValueOnce(undefined as unknown as boolean);
    await expect(f.guard.sendWebhook(target, "webhook", {})).rejects.toMatchObject({
      code: "blocked",
    });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(f.guard.sendWebhook(target, "webhook", circular)).rejects.toMatchObject({
      code: "other",
    });
    await expect(f.guard.sendWebhook(target, "webhook", undefined)).rejects.toMatchObject({
      code: "other",
    });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not restart the total timeout after a slow policy decision", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.isBlockedHost.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return false;
    });
    f.resolve.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return publicRecords;
    });
    const rejected = expect(f.guard.sendWebhook(target, "webhook", {})).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.calls[0].connectedAddress).toBeUndefined();
  });

  it("cancels headers returned by a transport after the deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const late = response();
    f.request.mockImplementationOnce((options, callback) => {
      const handle = new EventEmitter() as ClientRequest;
      handle.end = vi.fn(() => {
        setTimeout(() => callback(late), 6000);
        return handle;
      }) as ClientRequest["end"];
      handle.destroy = vi.fn(() => handle);
      f.calls.push({ options, request: handle, callback });
      return handle;
    });
    const rejected = expect(f.guard.sendWebhook(target, "webhook", {})).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(late.destroy).toHaveBeenCalled();
  });
});
