import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decryptEvidence, newPrivateOutputPath, readEncryptedInput, writePrivateOutput } from "./dogfood-crypto.mjs";

export async function decryptDogfood(env, input, output) {
  try {
    await newPrivateOutputPath(output, ".json");
    const snapshot = decryptEvidence(await readEncryptedInput(input), env.DOGFOOD_PROOF_KEY, env.DOGFOOD_PROOF_KEY_ID);
    await writePrivateOutput(output, `${JSON.stringify(snapshot, null, 2)}\n`, ".json");
  } catch { throw new Error("Dogfood decryption failed."); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 6 || process.argv[2] !== "--input" || process.argv[4] !== "--output") throw new Error();
    await decryptDogfood(process.env, process.argv[3], process.argv[5]);
    console.log("Dogfood evidence decrypted to a new private file.");
  } catch {
    console.error("Dogfood decryption failed. Check the encrypted input, local key and new private output path.");
    process.exitCode = 1;
  }
}
