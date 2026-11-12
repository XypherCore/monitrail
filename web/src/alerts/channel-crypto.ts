import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isMonitorId } from "../monitors/input.ts";
import type { ChannelDestination, ChannelIdentity } from "./contracts.ts";
import { isTelegramChatId } from "./telegram-target.ts";

const keyIdPattern = /^[A-Za-z0-9_-]{1,64}$/u;
const base64urlPattern = /^[A-Za-z0-9_-]+$/u;
const nonceBytes = 12;
const tagBytes = 16;
const version = "v1";
// The alert settings body is bounded at 8 KiB. Keep decoding bounded too.
const maxPlaintextBytes = 8192;
const maxCiphertextChars = Math.ceil((maxPlaintextBytes + tagBytes) * 4 / 3);

const invalid = () => new Error("Channel configuration is invalid.");
const unavailable = () => new Error("Configure channel encryption keys.");

function decode(value: string, expectedBytes?: number): Buffer {
  if (!base64urlPattern.test(value)) throw invalid();
  const result = Buffer.from(value, "base64url");
  if (
    result.toString("base64url") !== value ||
    (expectedBytes !== undefined && result.length !== expectedBytes)
  ) throw invalid();
  return result;
}

function keyPair(id: string | undefined, value: string | undefined) {
  if (!id || !keyIdPattern.test(id) || value?.length !== 43) throw unavailable();
  return { id, value: decode(value, 32) };
}

function authenticate(identity: ChannelIdentity, keyId: string): Buffer {
  const { id, userId, type } = identity;
  if (
    !isMonitorId(id) ||
    !isMonitorId(userId) ||
    !["telegram", "discord", "slack", "webhook"].includes(type)
  ) throw invalid();
  return Buffer.from(JSON.stringify([version, keyId, id.toLowerCase(), userId.toLowerCase(), type]));
}

function parseDestination(value: unknown, type: ChannelIdentity["type"]): ChannelDestination {
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 1) throw invalid();
  if (type === "telegram") {
    if (!("chatId" in value) || !isTelegramChatId(value.chatId)) throw invalid();
    return { chatId: value.chatId };
  }
  if (!("url" in value) || typeof value.url !== "string" || !value.url) throw invalid();
  return { url: value.url };
}

export function createChannelCipher(env: Readonly<Record<string, string | undefined>> = process.env) {
  let active: ReturnType<typeof keyPair>;
  let previous: ReturnType<typeof keyPair> | undefined;
  try {
    active = keyPair(env.CHANNEL_ENC_KEY_ID, env.CHANNEL_ENC_KEY);
    if (env.CHANNEL_ENC_PREVIOUS_KEY_ID !== undefined || env.CHANNEL_ENC_PREVIOUS_KEY !== undefined) {
      previous = keyPair(env.CHANNEL_ENC_PREVIOUS_KEY_ID, env.CHANNEL_ENC_PREVIOUS_KEY);
      if (previous.id === active.id || previous.value.equals(active.value)) throw unavailable();
    }
  } catch {
    throw unavailable();
  }

  return {
    activeKeyId: active.id,
    encrypt(destination: ChannelDestination, identity: ChannelIdentity): string {
      try {
        const plaintext = Buffer.from(JSON.stringify(parseDestination(destination, identity.type)));
        if (plaintext.length > maxPlaintextBytes) throw invalid();
        const nonce = randomBytes(nonceBytes);
        const cipher = createCipheriv("aes-256-gcm", active.value, nonce, { authTagLength: tagBytes });
        cipher.setAAD(authenticate(identity, active.id));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
        return [version, active.id, nonce.toString("base64url"), ciphertext.toString("base64url")].join(".");
      } catch {
        throw invalid();
      }
    },
    decrypt(envelope: string, identity: ChannelIdentity): ChannelDestination {
      try {
        if (envelope.length > maxCiphertextChars + 85) throw invalid();
        const [format, id, nonceText, sealedText, extra] = envelope.split(".");
        if (format !== version || nonceText?.length !== 16 || !sealedText || extra !== undefined)
          throw invalid();
        const key = id === active.id ? active : id === previous?.id ? previous : undefined;
        if (!key || sealedText.length > maxCiphertextChars) throw invalid();
        const nonce = decode(nonceText, nonceBytes);
        const sealed = decode(sealedText);
        if (sealed.length <= tagBytes) throw invalid();
        const decipher = createDecipheriv("aes-256-gcm", key.value, nonce, { authTagLength: tagBytes });
        decipher.setAAD(authenticate(identity, key.id));
        decipher.setAuthTag(sealed.subarray(-tagBytes));
        const plaintext = Buffer.concat([decipher.update(sealed.subarray(0, -tagBytes)), decipher.final()]);
        return parseDestination(JSON.parse(plaintext.toString("utf8")), identity.type);
      } catch {
        throw invalid();
      }
    },
  };
}
