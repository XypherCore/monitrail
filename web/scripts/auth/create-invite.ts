import { createHash, randomBytes } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import postgres from "postgres";
import { postgresOptions, readRuntimePostgresUrl } from "../../src/db/postgres-config.ts";
import { readPrivateConfiguration } from "../deploy/configure-production.ts";

type Environment = Readonly<Record<string, string | undefined>>;
export type InviteStore = {
  transaction(action: (transaction: { insertHash(hash: string): Promise<void> }) => Promise<void>): Promise<void>;
  close(): Promise<void>;
};
type InviteOutput = {
  writeFile(content: string): Promise<void>;
  close(): Promise<void>;
  removeIfOwned(): Promise<void>;
};
type Dependencies = {
  openStore(url: string, options: ReturnType<typeof postgresOptions>): InviteStore;
  readConfiguration(file: URL): Promise<{ content: string }>;
  openOutput(file: URL): Promise<InviteOutput>;
};

export function parseInviteArguments(args: readonly string[], nodeEnv: string | undefined) {
  if (args.length !== 1 || !["--confirm-invite", "--confirm-production-invite"].includes(args[0]) ||
    (args[0] === "--confirm-invite" && nodeEnv === "production")) throw new Error("Invite creation settings are invalid.");
  const production = args[0] === "--confirm-production-invite";
  return { production, destination: new URL(production ? "../../.env.invite.production.local" : "../../.env.invite.local", import.meta.url) };
}

function openInviteStore(url: string, options: ReturnType<typeof postgresOptions>): InviteStore {
  const client = postgres(url, options);
  return {
    async transaction(action) {
      await client.begin(async (transaction) => {
        await action({ insertHash: async (hash) => { await transaction`INSERT INTO invites(code_hash) VALUES (${hash})`; } });
      });
    },
    close: () => client.end({ timeout: 5 }),
  };
}

/** An existing destination is never opened, overwritten or owned by this command. */
export async function openInviteOutput(file: URL): Promise<InviteOutput> {
  const handle = await open(file, "wx", 0o600);
  try {
    const identity = await handle.stat({ bigint: true });
    return {
      writeFile: (content) => handle.writeFile(content),
      close: () => handle.close(),
      async removeIfOwned() {
        const current = await lstat(file, { bigint: true });
        if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino && current.birthtimeNs === identity.birthtimeNs) await unlink(file);
      },
    };
  } catch {
    await handle.close().catch(() => {});
    throw new Error();
  }
}

function assertNoAmbientOverrides(saved: Environment, ambient: Environment) {
  for (const key of ["DATABASE_URL", "DATABASE_CA_FILE", "DATABASE_CA_PEM"] as const) {
    if (ambient[key] !== undefined && ambient[key] !== saved[key]) throw new Error();
  }
}

/** Owner-only command. No invitation code is returned or printed. */
export async function createInvite(args: readonly string[], env: Environment = process.env, dependencies: Partial<Dependencies> = {}) {
  try {
    const mode = parseInviteArguments(args, env.NODE_ENV);
    let configuration = env;
    if (mode.production) {
      const file = new URL("../../.env.production.local", import.meta.url);
      const { content } = await (dependencies.readConfiguration ?? readPrivateConfiguration)(file);
      configuration = parseEnv(content);
      assertNoAmbientOverrides(configuration, env);
      // postgresOptions has process-level CA defaults, including when env was injected.
      assertNoAmbientOverrides(configuration, process.env);
    }
    const runtime = readRuntimePostgresUrl(configuration.DATABASE_URL);
    const caFile = mode.production && configuration.DATABASE_CA_FILE !== undefined
      ? resolve(fileURLToPath(new URL("../../", import.meta.url)), configuration.DATABASE_CA_FILE)
      : configuration.DATABASE_CA_FILE;
    const options = mode.production ? postgresOptions(caFile, configuration.DATABASE_CA_PEM) : postgresOptions();
    const store = (dependencies.openStore ?? openInviteStore)(runtime, options);
    let output: InviteOutput | undefined;
    let closed = false;
    try {
      const code = randomBytes(32).toString("base64url");
      const hash = createHash("sha256").update(code).digest("hex");
      try {
        await store.transaction(async (transaction) => {
          await transaction.insertHash(hash);
          output = await (dependencies.openOutput ?? openInviteOutput)(mode.destination);
          await output.writeFile(`INVITE_CODE=${code}\n`);
          await output.close();
          closed = true;
        });
      } catch {
        if (output) {
          if (!closed) await output.close().catch(() => {});
          await output.removeIfOwned().catch(() => {});
        }
        throw new Error();
      }
      return { production: mode.production };
    } finally {
      await store.close();
    }
  } catch {
    throw new Error("Invite creation failed.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { production } = await createInvite(process.argv.slice(2));
    console.log(production
      ? "Single-use production invite saved in the ignored web/.env.invite.production.local file. Open that file locally to use it."
      : "Single-use invite saved in the ignored web/.env.invite.local file. Open that file locally to use it.");
  } catch {
    console.error("Invite creation failed. The output file must be absent and the runtime database configured.");
    process.exitCode = 1;
  }
}
