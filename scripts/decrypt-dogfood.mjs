import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { decryptEvidence, newPrivateOutputPath, proofKey, proofKeyId, readEncryptedInput, writePrivateOutput } from "./dogfood-crypto.mjs";

const productionFile = new URL("../web/.env.production.local", import.meta.url);
const MAX_CONFIGURATION_BYTES = 262_144;

/** Read only an owned, private regular file; never chmod it or follow a final-component symlink. */
export async function readPrivateProofConfiguration(file) {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let data;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_CONFIGURATION_BYTES || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error();
      data = Buffer.alloc(MAX_CONFIGURATION_BYTES + 1);
      let size = 0;
      while (size < data.length) {
        const { bytesRead } = await handle.read(data, size, data.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_CONFIGURATION_BYTES) throw new Error();
      return { content: data.toString("utf8", 0, size) };
    } finally {
      data?.fill(0);
      await handle.close();
    }
  } catch { throw new Error("Private proof settings are unavailable."); }
}

export function parseDecryptArguments(args) {
  if ((args.length !== 4 && args.length !== 5) || args[0] !== "--input" || args[2] !== "--output" ||
    (args.length === 5 && args[4] !== "--production-key") ||
    typeof args[1] !== "string" || typeof args[3] !== "string" ||
    !isAbsolute(args[1]) || !isAbsolute(args[3]) || extname(args[1]) !== ".enc" || extname(args[3]) !== ".json" ||
    /[\r\n\0]/.test(args[1]) || /[\r\n\0]/.test(args[3])) throw new Error("Dogfood decryption settings are invalid.");
  return { input: args[1], output: args[3], productionKey: args.length === 5 };
}

/** Follow the private settings writer's canonical keys and quote delimiters, then parse only proof entries. */
function productionProofSettings(content) {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_CONFIGURATION_BYTES || /[\r\0]/.test(content)) throw new Error();
  const entries = [], seen = new Set();
  let offset = 0;
  while (offset < content.length) {
    let end = content.indexOf("\n", offset);
    if (end < 0) end = content.length;
    const line = content.slice(offset, end);
    if (/^[ \t]*(?:#.*)?$/.test(line)) { offset = end + 1; continue; }
    const header = /^([A-Z][A-Z0-9_]{0,127})=/.exec(line);
    if (!header) throw new Error();
    let valueStart = offset + header[0].length;
    while (content[valueStart] === " " || content[valueStart] === "\t") valueStart++;
    const delimiter = content[valueStart];
    if (delimiter === "'" || delimiter === '"' || delimiter === "`") {
      const close = content.indexOf(delimiter, valueStart + 1);
      if (close < 0) throw new Error();
      end = content.indexOf("\n", close + 1);
      if (end < 0) end = content.length;
      if (!/^[ \t]*(?:#.*)?$/.test(content.slice(close + 1, end))) throw new Error();
    }
    const key = header[1];
    if (key === "DOGFOOD_PROOF_KEY" || key === "DOGFOOD_PROOF_KEY_ID") {
      if (seen.has(key)) throw new Error();
      seen.add(key);
      entries.push(content.slice(offset, end));
    }
    offset = end + 1;
  }
  const saved = parseEnv(entries.join("\n"));
  const selected = { DOGFOOD_PROOF_KEY: saved.DOGFOOD_PROOF_KEY };
  if (saved.DOGFOOD_PROOF_KEY_ID !== undefined) selected.DOGFOOD_PROOF_KEY_ID = saved.DOGFOOD_PROOF_KEY_ID;
  proofKey(selected.DOGFOOD_PROOF_KEY).fill(0);
  proofKeyId(selected.DOGFOOD_PROOF_KEY_ID);
  return selected;
}

export async function decryptDogfood(env, input, output) {
  try {
    await newPrivateOutputPath(output, ".json");
    const snapshot = decryptEvidence(await readEncryptedInput(input), env.DOGFOOD_PROOF_KEY, env.DOGFOOD_PROOF_KEY_ID);
    await writePrivateOutput(output, `${JSON.stringify(snapshot, null, 2)}\n`, ".json");
  } catch { throw new Error("Dogfood decryption failed."); }
}

/** Production key selection stays in memory and never loads unrelated settings into process.env. */
export async function runDecryptDogfood(args, env = process.env, dependencies = {}) {
  try {
    const options = parseDecryptArguments(args);
    let selected = env;
    if (options.productionKey) {
      const { content } = await (dependencies.readConfiguration ?? readPrivateProofConfiguration)(productionFile);
      selected = productionProofSettings(content);
    }
    await (dependencies.decrypt ?? decryptDogfood)(selected, options.input, options.output);
  } catch { throw new Error("Dogfood decryption failed."); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runDecryptDogfood(process.argv.slice(2));
    console.log("Dogfood evidence decrypted to a new private file.");
  } catch {
    console.error("Dogfood decryption failed. Check the encrypted input, local key and new private output path.");
    process.exitCode = 1;
  }
}
