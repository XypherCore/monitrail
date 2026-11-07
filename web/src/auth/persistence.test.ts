import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthPersistence } from "./persistence.ts";

const inviteHash = "a".repeat(64);
const identity = {
  provider: "github" as const,
  providerAccountId: "fixture-provider-id",
  name: "Fixture",
  email: null,
  image: null,
};

describe("OAuth-only Auth.js persistence and atomic invite admission", () => {
  let client: PGlite;
  let persistence: ReturnType<typeof createAuthPersistence>;
  beforeAll(async () => {
    client = new PGlite();
    const db = drizzle(client);
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)),
    });
    persistence = createAuthPersistence(db);
  }, 30000);
  beforeEach(async () => {
    await client.exec("TRUNCATE users, invites CASCADE");
    await client.query("INSERT INTO invites(code_hash) VALUES ($1)", [inviteHash]);
  });
  afterAll(async () => {
    await client.close();
  });

  it("admits an email-less provider account and never stores OAuth tokens", async () => {
    const created = await persistence.provision(identity, inviteHash, "invite");
    expect(created.email).toBeNull();
    expect((await client.query("SELECT * FROM accounts")).rows).toEqual([
      {
        user_id: created.id,
        provider: identity.provider,
        provider_account_id: identity.providerAccountId,
      },
    ]);
    expect(await persistence.adapter.getUser?.(created.id)).toMatchObject({
      email: null,
      emailVerified: null,
    });
  });
  it("requires an invitation for a new account and allows its existing provider account to return", async () => {
    await expect(persistence.provision(identity, null, "invite")).rejects.toMatchObject({
      category: "invite",
    });
    const created = await persistence.provision(identity, inviteHash, "invite");
    expect(await persistence.provision(identity, null, "invite")).toEqual(created);
  });
  it("cannot redeem one invitation concurrently for two different identities", async () => {
    const results = await Promise.allSettled([
      persistence.provision(identity, inviteHash, "invite"),
      persistence.provision({ ...identity, providerAccountId: "second" }, inviteHash, "invite"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await client.query("SELECT id FROM users")).rows).toHaveLength(1);
  });
  it("never links or merges accounts by email", async () => {
    const first = await persistence.provision(
      { ...identity, email: "fixture@example.invalid" },
      inviteHash,
      "invite",
    );
    await expect(
      persistence.provision(
        { ...identity, provider: "google", email: "FIXTURE@example.invalid" },
        null,
        "open",
      ),
    ).rejects.toMatchObject({ category: "account-conflict" });
    expect((await client.query("SELECT id FROM users")).rows).toEqual([{ id: first.id }]);
  });
  it("keeps an invitation consumed after deletion and revokes the session", async () => {
    const created = await persistence.provision(identity, inviteHash, "invite");
    const token = randomUUID();
    await persistence.adapter.createSession?.({
      userId: created.id,
      sessionToken: token,
      expires: new Date(Date.now() + 60000),
    });
    expect(await persistence.getSessionAndUser(token)).not.toBeNull();
    await client.query("DELETE FROM users WHERE id=$1", [created.id]);
    expect(await persistence.getSessionAndUser(token)).toBeNull();
    const [invitation] = (await client.query("SELECT used_by,used_at FROM invites")).rows as {
      used_by: string | null;
      used_at: Date | null;
    }[];
    expect(invitation.used_by).toBeNull();
    expect(invitation.used_at).not.toBeNull();
    await expect(persistence.provision(identity, inviteHash, "invite")).rejects.toMatchObject({
      category: "invite",
    });
  });
  it("refuses direct framework provisioning and stores neither passwords nor verification metadata", async () => {
    await expect(
      persistence.adapter.createUser?.({ email: "ignored@example.invalid", emailVerified: null }),
    ).rejects.toThrow();
    await expect(
      persistence.adapter.linkAccount?.({
        provider: "github",
        providerAccountId: "bypass",
        type: "oauth",
        userId: randomUUID(),
      }),
    ).rejects.toThrow();
    expect((await client.query("SELECT id FROM users")).rows).toHaveLength(0);
  });
});
