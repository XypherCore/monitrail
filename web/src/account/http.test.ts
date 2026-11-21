import { describe, expect, it, vi } from "vitest";
import { createAccountDeletionHandler } from "./http.ts";

const origin = "https://app.example.invalid";

function request(body: unknown = { confirm: true }, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/account`, {
    method: "DELETE",
    headers: { origin, "content-type": "application/json", cookie: "fixture-session=private", ...headers },
    body: JSON.stringify(body),
  });
}

function setup() {
  const deleteAccount = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const authenticate = vi.fn().mockResolvedValue({ deleteAccount });
  const handler = createAccountDeletionHandler({ origin: () => origin, authenticate });
  return { handler, authenticate, deleteAccount };
}

describe("authenticated account deletion", () => {
  it("deletes the session-bound account and expires its secure session cookie", async () => {
    const { handler, authenticate, deleteAccount } = setup();
    const input = request();
    const response = await handler(input);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(authenticate).toHaveBeenCalledWith(input);
    expect(deleteAccount).toHaveBeenCalledExactlyOnceWith();
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("set-cookie")).toBe(
      "__Secure-next-auth.session-token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    );
  });

  it.each([undefined, "https://foreign.example.invalid", `${origin}/`, "null"])(
    "refuses a missing or foreign Origin %j before authentication", async (value) => {
      const { handler, authenticate, deleteAccount } = setup();
      const input = request();
      if (value === undefined) input.headers.delete("origin");
      else input.headers.set("origin", value);
      const response = await handler(input);
      expect(response.status).toBe(403);
      expect(authenticate).not.toHaveBeenCalled();
      expect(deleteAccount).not.toHaveBeenCalled();
    },
  );

  it("refuses a missing validated session", async () => {
    const { handler, authenticate, deleteAccount } = setup();
    authenticate.mockResolvedValue(null);
    const response = await handler(request());
    expect(response.status).toBe(401);
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([null, [], {}, { confirm: false }, { confirm: "true" }, { confirm: true, userId: "foreign-owner" }])(
    "rejects an unconfirmed or ambiguous body %j", async (body) => {
      const { handler, deleteAccount } = setup();
      const response = await handler(request(body));
      expect(response.status).toBe(400);
      expect(deleteAccount).not.toHaveBeenCalled();
    },
  );

  it("bounds and validates the deletion request body before changing data", async () => {
    const { handler, deleteAccount } = setup();
    const oversized = request({ confirm: true, extra: "x".repeat(8192) });
    expect((await handler(oversized)).status).toBe(413);
    expect((await handler(request({ confirm: true }, { "content-type": "text/plain" }))).status).toBe(415);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("fails generically and keeps the cookie when persistence fails", async () => {
    const { handler, deleteAccount } = setup();
    deleteAccount.mockRejectedValue(new Error("private-fixture-credential"));
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-fixture");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("reports success when a concurrent deletion already removed the validated account", async () => {
    const { handler, deleteAccount } = setup();
    deleteAccount.mockResolvedValue(false);
    expect((await handler(request())).status).toBe(204);
  });

  it("accepts only DELETE and uses the development cookie on a local HTTP origin", async () => {
    const { handler, deleteAccount } = setup();
    const response = await handler(new Request(`${origin}/api/account`, { method: "GET" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("DELETE");
    expect(deleteAccount).not.toHaveBeenCalled();
    const local = createAccountDeletionHandler({
      origin: () => "http://localhost:3000",
      authenticate: async () => ({ deleteAccount }),
    });
    const input = request();
    input.headers.set("origin", "http://localhost:3000");
    expect((await local(input)).headers.get("set-cookie")).toBe(
      "next-auth.session-token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    );
  });
});
