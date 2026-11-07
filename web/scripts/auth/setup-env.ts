import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { readAuthConfig } from "../../src/auth/config.ts";

// Bounded local preparation: never print file contents, values or raw errors.
try {
  const path = new URL("../../.env.local", import.meta.url);
  const existing = await readFile(path, "utf8");
  const env = parseEnv(existing);
  if (!env.AUTH_SECRET) {
    if (!process.argv.includes("--generate-missing-secret")) throw new Error("Secret opt-in required.");
    env.AUTH_SECRET = randomBytes(32).toString("base64url");
    // Validate all owner-provided values before writing any secret.
    readAuthConfig(env);
    await writeFile(path, `${existing}${existing.endsWith("\n") ? "" : "\n"}AUTH_SECRET=${env.AUTH_SECRET}\n`, { mode: 0o600 });
  } else {
    readAuthConfig(env);
  }
  await chmod(path, 0o600);
  console.log("OAuth configuration is valid. Local credentials are owner-readable only.");
} catch {
  console.error("OAuth configuration check failed. Check the required local settings.");
  process.exitCode = 1;
}
