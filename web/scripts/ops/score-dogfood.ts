import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scoreDogfoodProof, type DogfoodProofReport } from "../../src/ops/dogfood-proof.ts";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;

function jsonPath(value: string | undefined): string {
  if (!value || value.length > 4096 || !isAbsolute(value) || extname(value) !== ".json" || /[\r\n\0]/.test(value)) throw new Error();
  return resolve(value);
}

export function parseScoreArguments(args: string[]): { manifest: string; evidence: string[]; reviews: string; asOf: string; output: string } {
  if (args.length !== 10) throw new Error();
  const allowed = new Set(["--manifest", "--evidence", "--reviews", "--as-of", "--output"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith("--")) throw new Error();
    values.set(key, value);
  }
  const evidence = values.get("--evidence")?.split(",").map(jsonPath);
  const asOf = values.get("--as-of");
  if (!evidence?.length || evidence.length > 128 || new Set(evidence).size !== evidence.length || !asOf || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(asOf)) throw new Error();
  const date = new Date(asOf);
  if (!Number.isFinite(date.getTime()) || (date.toISOString() !== asOf && date.toISOString().replace(".000Z", "Z") !== asOf)) throw new Error();
  return { manifest: jsonPath(values.get("--manifest")), evidence, reviews: jsonPath(values.get("--reviews")), asOf: date.toISOString(), output: jsonPath(values.get("--output")) };
}

async function privateOutputPath(value: string): Promise<string> {
  const output = jsonPath(value);
  const path = resolve(await realpath(dirname(output)), basename(output));
  const inside = relative(await realpath(checkout), path);
  if (!inside.startsWith("../") && inside !== "..") throw new Error();
  try { await lstat(path); throw new Error(); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw new Error();
  }
  return path;
}

export async function writePrivateProofReport(output: string, report: DogfoodProofReport): Promise<void> {
  const path = await privateOutputPath(output);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

async function readJson(path: string, remaining: { bytes: number }, maximum = MAX_FILE): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await file.stat();
    if (!stats.isFile() || !stats.size || stats.size > maximum || stats.size > remaining.bytes) throw new Error();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(65_536, maximum - size + 1));
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maximum || size > remaining.bytes) throw new Error();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    remaining.bytes -= size;
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally { await file.close(); }
}

async function main() {
  try {
    const args = parseScoreArguments(process.argv.slice(2));
    if (Date.parse(args.asOf) > Date.now()) throw new Error();
    await privateOutputPath(args.output);
    const remaining = { bytes: MAX_TOTAL };
    const manifest = await readJson(args.manifest, remaining, 1024 * 1024);
    const reviews = await readJson(args.reviews, remaining, 2 * 1024 * 1024);
    if (!reviews || typeof reviews !== "object" || Array.isArray(reviews) || Object.keys(reviews).sort().join(",") !== "reviews,version" || !("version" in reviews) || reviews.version !== 1 || !("reviews" in reviews)) throw new Error();
    const snapshots: unknown[] = [];
    for (const path of args.evidence) snapshots.push(await readJson(path, remaining));
    const report = scoreDogfoodProof({ manifest, asOf: args.asOf, snapshots, reviews: reviews.reviews });
    await writePrivateProofReport(args.output, report);
    console.log(`Dogfood proof assessed. Status: ${report.status}. Completed days: ${report.completedDays} of 14. Private report saved.`);
    process.exitCode = report.status === "passed" ? 0 : report.status === "incomplete" ? 2 : 1;
  } catch {
    console.error("Dogfood proof could not be scored. Check the bounded JSON inputs, elapsed time and new private report path. Raw values and errors were suppressed.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
