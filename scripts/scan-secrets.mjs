import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const release = "8.30.1";
const checksum =
	"551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb";
const temporary = await mkdtemp(join(tmpdir(), "monitrail-secret-scan-"));
let failed = false;

async function run(command, args) {
	const child = spawn(command, args, {
		cwd: root,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const chunks = [];
	child.stdout.on("data", (data) => chunks.push(data));
	child.stderr.resume();
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	return { code, output: Buffer.concat(chunks) };
}

try {
	let binary = process.env.GITLEAKS_BINARY;
	if (!binary) {
		if (process.platform !== "linux" || process.arch !== "x64")
			throw new Error();
		const response = await fetch(
			`https://github.com/gitleaks/gitleaks/releases/download/v${release}/gitleaks_${release}_linux_x64.tar.gz`,
		);
		if (!response.ok) throw new Error();
		const archive = Buffer.from(await response.arrayBuffer());
		if (createHash("sha256").update(archive).digest("hex") !== checksum)
			throw new Error();
		const file = join(temporary, "gitleaks.tar.gz");
		await writeFile(file, archive, { mode: 0o600 });
		if (
			(await run("tar", ["-xzf", file, "-C", temporary, "gitleaks"])).code !== 0
		)
			throw new Error();
		binary = join(temporary, "gitleaks");
		await chmod(binary, 0o700);
	}
	const version = await run(binary, ["version"]);
	if (version.code !== 0 || version.output.toString().trim() !== release)
		throw new Error();
	const listed = await run("git", [
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard",
		"-z",
	]);
	if (listed.code !== 0) throw new Error();
	const exported = join(temporary, "source");
	await mkdir(exported);
	for (const name of listed.output.toString().split("\0").filter(Boolean)) {
		const source = resolve(root, name);
		const destination = resolve(exported, name);
		if (!source.startsWith(root) || !destination.startsWith(exported + "/"))
			throw new Error();
		await mkdir(resolve(destination, ".."), { recursive: true });
		try {
			await cp(source, destination);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	for (const [label, args] of [
		["history", ["git", "--log-opts=--all", root]],
		["source", ["dir", exported]],
	]) {
		const report = join(temporary, label + ".json");
		const result = await run(binary, [
			...args,
			"--redact",
			"--no-banner",
			"--report-format=json",
			"--report-path=" + report,
		]);
		if (result.code !== 0) {
			failed = true;
			const findings = JSON.parse(await readFile(report, "utf8"));
			console.error(
				JSON.stringify({
					scan: label,
					findings: findings.map((value) => ({
						file: value.File.startsWith(exported + "/")
							? value.File.slice(exported.length + 1)
							: value.File,
						line: value.StartLine,
						rule: value.RuleID,
						fingerprint: value.Fingerprint,
					})),
				}),
			);
		}
	}
	if (failed) throw new Error();
	console.log("Source and Git history secret scans passed.");
} catch {
	console.error(
		"Secret scan failed or was incomplete. No secret values were displayed.",
	);
	process.exitCode = 1;
} finally {
	await rm(temporary, { recursive: true, force: true });
}
