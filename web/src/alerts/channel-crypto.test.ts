import { describe, expect, it } from "vitest";
import { createChannelCipher } from "./channel-crypto.ts";
import type { ChannelIdentity } from "./contracts.ts";

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
const identity: ChannelIdentity = {
  id: "844f8e77-dbc2-4742-a738-f89579349b7a",
  userId: "0cb94b87-5a0d-4a1d-a0be-0b6cae7a2941",
  type: "webhook",
};
const destination = { url: "https://example.test/hook?token=fixture-private-destination" };

describe("authenticated channel encryption", () => {
  it("uses the v1 envelope and a fresh 12-byte nonce", () => {
    const cipher = createChannelCipher({ CHANNEL_ENC_KEY_ID: "key_1", CHANNEL_ENC_KEY: key(1) });
    const encrypted = cipher.encrypt(destination, identity);
    const [version, keyId, nonce, ciphertext] = encrypted.split(".");
    expect([version, keyId]).toEqual(["v1", "key_1"]);
    expect(Buffer.from(nonce, "base64url")).toHaveLength(12);
    expect(Buffer.from(ciphertext, "base64url")).toHaveLength(
      Buffer.byteLength(JSON.stringify(destination)) + 16,
    );
    expect(cipher.encrypt(destination, identity).split(".")[2]).not.toBe(nonce);
    expect(encrypted).not.toContain("fixture-private-destination");
    expect(cipher.decrypt(encrypted, identity)).toEqual(destination);
  });

  it("rejects malformed or tampered ciphertext and binds channel ID, owner, type, and key ID", () => {
    const cipher = createChannelCipher({
      CHANNEL_ENC_KEY_ID: "active",
      CHANNEL_ENC_KEY: key(1),
      CHANNEL_ENC_PREVIOUS_KEY_ID: "older",
      CHANNEL_ENC_PREVIOUS_KEY: key(2),
    });
    const encrypted = cipher.encrypt(destination, identity);
    const [version, keyId, nonce, ciphertext] = encrypted.split(".");
    for (const changed of [
      `${version}.${keyId}.${nonce}.${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`,
      `${version}.older.${nonce}.${ciphertext}`,
      `${encrypted}=`,
      encrypted.replace("v1.", "v2."),
    ]) {
      expect(() => cipher.decrypt(changed, identity)).toThrow("Channel configuration is invalid.");
    }
    for (const changed of [
      { ...identity, id: identity.userId },
      { ...identity, userId: identity.id },
      { ...identity, type: "slack" } as const,
    ]) {
      expect(() => cipher.decrypt(encrypted, changed)).toThrow("Channel configuration is invalid.");
    }
  });

  it("reads the previous key and writes only the active key", () => {
    const previous = createChannelCipher({ CHANNEL_ENC_KEY_ID: "old", CHANNEL_ENC_KEY: key(1) });
    const current = createChannelCipher({
      CHANNEL_ENC_KEY_ID: "new",
      CHANNEL_ENC_KEY: key(2),
      CHANNEL_ENC_PREVIOUS_KEY_ID: "old",
      CHANNEL_ENC_PREVIOUS_KEY: key(1),
    });
    const linked = { ...identity, type: "telegram" } as const;
    const chat = { chatId: "4503599627370495" };
    const migrated = current.encrypt(current.decrypt(previous.encrypt(chat, linked), linked), linked);
    expect(current.activeKeyId).toBe("new");
    expect(migrated.startsWith("v1.new.")).toBe(true);
    expect(current.decrypt(migrated, linked)).toEqual(chat);
    expect(() => previous.decrypt(migrated, linked)).toThrow("Channel configuration is invalid.");
    expect(() => current.encrypt({ chatId: "-123" }, linked)).toThrow("Channel configuration is invalid.");
  });

  it.each([
    {},
    { CHANNEL_ENC_KEY_ID: "key.with.dots", CHANNEL_ENC_KEY: key(1) },
    { CHANNEL_ENC_KEY_ID: "key", CHANNEL_ENC_KEY: `${key(1)}=` },
    { CHANNEL_ENC_KEY_ID: "key", CHANNEL_ENC_KEY: key(1), CHANNEL_ENC_PREVIOUS_KEY_ID: "old" },
    {
      CHANNEL_ENC_KEY_ID: "key",
      CHANNEL_ENC_KEY: key(1),
      CHANNEL_ENC_PREVIOUS_KEY_ID: "key",
      CHANNEL_ENC_PREVIOUS_KEY: key(2),
    },
    {
      CHANNEL_ENC_KEY_ID: "key",
      CHANNEL_ENC_KEY: key(1),
      CHANNEL_ENC_PREVIOUS_KEY_ID: "old",
      CHANNEL_ENC_PREVIOUS_KEY: key(1),
    },
  ])("rejects an invalid key configuration without echoing values", (env) => {
    expect(() => createChannelCipher(env)).toThrow("Configure channel encryption keys.");
  });
});
