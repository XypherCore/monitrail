import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChannelCipher } from "./channel-crypto.ts";
import type { ChannelIdentity } from "./contracts.ts";
import { rotateChannelKeys } from "./key-rotation.ts";

const key = (value: number) => Buffer.alloc(32, value).toString("base64url");
const previous = createChannelCipher({ CHANNEL_ENC_KEY_ID: "old", CHANNEL_ENC_KEY: key(1) });
const active = createChannelCipher({
  CHANNEL_ENC_KEY_ID: "new",
  CHANNEL_ENC_KEY: key(2),
  CHANNEL_ENC_PREVIOUS_KEY_ID: "old",
  CHANNEL_ENC_PREVIOUS_KEY: key(1),
});
const userId = "10000000-0000-4000-8000-000000000001";
const first: ChannelIdentity = { id: "20000000-0000-4000-8000-000000000001", userId, type: "slack" };
const second: ChannelIdentity = { id: "20000000-0000-4000-8000-000000000002", userId, type: "telegram" };
const destination = { url: "https://hooks.slack.com/services/T1/B2/fixture" };
const linked = { chatId: "1234" };

describe("channel key rotation against the migrated schema", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)) });
  }, 30_000);

  beforeEach(async () => {
    await client.exec("TRUNCATE users CASCADE");
    await client.query("INSERT INTO users(id,name) VALUES($1,'Rotation fixture')", [userId]);
  });

  afterAll(async () => {
    await client?.close();
  });

  async function insert(channel: ChannelIdentity, encrypted: string) {
    await client.query("INSERT INTO alert_channels(id,user_id,type,label,config_enc,is_verified) VALUES($1,$2,$3,'Fixture',$4,true)",
      [channel.id, channel.userId, channel.type, encrypted]);
  }

  async function channels() {
    return (await client.query<{ id: string; config_enc: string; is_verified: boolean }>(
      "SELECT id,config_enc,is_verified FROM alert_channels ORDER BY id",
    )).rows;
  }

  it("rotates all old rows and preserves an already active envelope on replay", async () => {
    const alreadyActive = active.encrypt(linked, second);
    await insert(first, previous.encrypt(destination, first));
    await insert(second, alreadyActive);
    expect(await rotateChannelKeys(db, active)).toBe(1);
    const [rotated, unchanged] = await channels();
    expect(rotated).toMatchObject({ id: first.id, is_verified: true });
    expect(rotated.config_enc.startsWith("v1.new.")).toBe(true);
    expect(active.decrypt(rotated.config_enc, first)).toEqual(destination);
    expect(unchanged.config_enc).toBe(alreadyActive);
    expect(await rotateChannelKeys(db, active)).toBe(0);
    expect(await channels()).toEqual([rotated, unchanged]);
  });

  it("rolls back earlier rows when an envelope is invalid and surfaces only a fixed error", async () => {
    const original = previous.encrypt(destination, first);
    await insert(first, original);
    await insert(second, "fixture-corrupt-sensitive-data");
    await expect(rotateChannelKeys(db, active)).rejects.toThrow("Channel key rotation failed.");
    expect((await channels())[0].config_enc).toBe(original);
  });
});
