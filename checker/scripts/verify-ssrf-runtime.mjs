import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import workerd from "workerd";

const directory = await mkdtemp(join(tmpdir(), "monitrail-workerd-"));
try {
  const config = join(directory, "ssrf-runtime.capnp");
  await Promise.all([
    copyFile(new URL("../test/ssrf-runtime.capnp", import.meta.url), config),
    copyFile(
      new URL("../test/ssrf-upstream.mjs", import.meta.url),
      join(directory, "ssrf-upstream.mjs"),
    ),
    build({
      entryPoints: [fileURLToPath(new URL("../test/ssrf-runtime.ts", import.meta.url))],
      outfile: join(directory, "ssrf-runtime.mjs"),
      bundle: true,
      format: "esm",
      target: "es2024",
    }),
  ]);
  execFileSync(workerd.default, ["test", config], { stdio: "inherit", timeout: 20000 });
} finally {
  await rm(directory, { recursive: true, force: true });
}
