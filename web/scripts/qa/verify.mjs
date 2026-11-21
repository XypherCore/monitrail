import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:https";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { chromium } from "@playwright/test";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const lab = await mkdtemp(join(tmpdir(), "monitrail-phase10-"));
const reportDirectory = resolve(
	process.env.QA_REPORT_DIR ?? join(tmpdir(), "monitrail-phase10-report"),
);
const databaseName = "monitrail_phase10_fixture";
const origin = "https://127.0.0.1:41843";
const baseEnv = {
	PATH: process.env.PATH,
	LANG: "C.UTF-8",
	NEXT_TELEMETRY_DISABLED: "1",
	WRANGLER_SEND_METRICS: "false",
};
let pg;
let server;
let app;
let db;
let startedPostgres = false;
let stage = "isolated setup";
const children = new Set();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(command, args, options = {}) {
	const child = spawn(command, args, {
		cwd: repo,
		env: baseEnv,
		stdio: ["pipe", "pipe", "pipe"],
		...options,
	});
	children.add(child);
	let output = "";
	child.stdout.on("data", (value) => {
		output += value;
	});
	child.stderr.on("data", (value) => {
		output += value;
	});
	if (options.input !== undefined) child.stdin.end(options.input);
	else child.stdin.end();
	const result = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	children.delete(child);
	if (options.log) await writeFile(options.log, output, { mode: 0o600 });
	if (result.code !== 0) throw new Error("Fixture subprocess failed.");
	return output;
}

try {
	await mkdir(reportDirectory, { recursive: true });
	for (const name of ["failure.json", "browser.json", "lighthouse.json", "storage.json"]) {
		await rm(join(reportDirectory, name), { force: true });
	}
	const versions = (await readdir("/usr/lib/postgresql"))
		.filter((value) => /^\d+$/.test(value))
		.sort((a, b) => Number(b) - Number(a));
	pg = join("/usr/lib/postgresql", versions[0], "bin");
	await stat(join(pg, "initdb"));
	await run("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		join(lab, "ca.key"),
		"-out",
		join(lab, "ca.crt"),
		"-subj",
		"/CN=Monitrail synthetic verification CA",
		"-days",
		"1",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
	]);
	await run("openssl", [
		"req",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		join(lab, "server.key"),
		"-out",
		join(lab, "server.csr"),
		"-subj",
		"/CN=monitrail-qa.pooler.supabase.com",
	]);
	await writeFile(
		join(lab, "tls.ext"),
		"subjectAltName=DNS:monitrail-qa.pooler.supabase.com,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
	);
	await run("openssl", [
		"x509",
		"-req",
		"-in",
		join(lab, "server.csr"),
		"-CA",
		join(lab, "ca.crt"),
		"-CAkey",
		join(lab, "ca.key"),
		"-CAcreateserial",
		"-out",
		join(lab, "server.crt"),
		"-days",
		"1",
		"-extfile",
		join(lab, "tls.ext"),
	]);
	await run(join(pg, "initdb"), [
		"-D",
		join(lab, "data"),
		"-U",
		"fixture_admin",
		"--auth-local=trust",
		"--auth-host=scram-sha-256",
		"--no-locale",
		"--encoding=UTF8",
	]);
	await run(join(pg, "pg_ctl"), [
		"-D",
		join(lab, "data"),
		"-l",
		join(lab, "postgres.log"),
		"-o",
		`-k ${lab} -h 127.0.0.1 -p 6543 -c fsync=off -c ssl=on -c ssl_cert_file=${lab}/server.crt -c ssl_key_file=${lab}/server.key`,
		"-w",
		"start",
	]);
	startedPostgres = true;
	const adminEnv = {
		...baseEnv,
		PGHOST: lab,
		PGPORT: "6543",
		PGUSER: "fixture_admin",
		PGDATABASE: databaseName,
	};
	await run(
		join(pg, "psql"),
		[
			"-X",
			"-v",
			"ON_ERROR_STOP=1",
			"-d",
			"postgres",
			"-q",
			"-c",
			`CREATE DATABASE ${databaseName}`,
		],
		{ env: adminEnv },
	);
	for (const migration of (await readdir(join(repo, "web/drizzle-rev2")))
		.filter((file) => file.endsWith(".sql"))
		.sort()) {
		await run(
			join(pg, "psql"),
			[
				"-X",
				"-v",
				"ON_ERROR_STOP=1",
				"-q",
				"-f",
				join(repo, "web/drizzle-rev2", migration),
			],
			{ env: adminEnv },
		);
	}
	const password = randomBytes(32).toString("hex");
	await run(join(pg, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-q"], {
		env: adminEnv,
		input: `CREATE ROLE "monitrail_app.fixture" LOGIN NOINHERIT PASSWORD '${password}';
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO "monitrail_app.fixture";
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "monitrail_app.fixture";
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "monitrail_app.fixture";`,
	});
	db = postgres({
		host: "127.0.0.1",
		port: 6543,
		database: databaseName,
		username: "monitrail_app.fixture",
		password,
		max: 1,
		prepare: false,
		onnotice: () => {},
		ssl: {
			rejectUnauthorized: true,
			servername: "monitrail-qa.pooler.supabase.com",
			ca: await readFile(join(lab, "ca.crt"), "utf8"),
		},
	});
	await db`SELECT current_user`;
	const tree = join(lab, "tree");
	await mkdir(join(tree, "web"), { recursive: true });
	for (const name of ["package.json", "package-lock.json", "shared"])
		await cp(join(repo, name), join(tree, name), { recursive: true });
	for (const name of [
		"src",
		"scripts",
		"package.json",
		"tsconfig.json",
		"next.config.ts",
		"postcss.config.mjs",
	]) {
		await cp(join(repo, "web", name), join(tree, "web", name), {
			recursive: true,
		});
	}
	await symlink(join(repo, "node_modules"), join(tree, "node_modules"), "dir");
	const fixtureEnv = {
		...baseEnv,
		APP_URL: origin,
		DATABASE_URL: `postgres://monitrail_app.fixture:${password}@monitrail-qa.pooler.supabase.com:6543/${databaseName}`,
		DATABASE_CA_FILE: join(lab, "ca.crt"),
		AUTH_SECRET: randomBytes(36).toString("base64url"),
		AUTH_GITHUB_ID: "synthetic-github-id",
		AUTH_GITHUB_SECRET: "synthetic-github-secret",
		AUTH_GOOGLE_ID: "synthetic-google-id",
		AUTH_GOOGLE_SECRET: "synthetic-google-secret",
		INTERNAL_HMAC_SECRET: randomBytes(36).toString("base64url"),
		CHANNEL_ENC_KEY: randomBytes(32).toString("base64url"),
		CHANNEL_ENC_KEY_ID: "synthetic",
		TELEGRAM_BOT_USERNAME: "monitrail_fixture_bot",
		TELEGRAM_BOT_TOKEN: "12345:synthetic_fixture_bot_token",
		TELEGRAM_WEBHOOK_SECRET: randomBytes(32).toString("base64url"),
		ABUSE_CONTACT_EMAIL: "abuse@example.invalid",
		SIGNUP_MODE: "invite",
	};
	const preload = join(lab, "preload.cjs");
	await writeFile(
		preload,
		`
    const dns = require('node:dns');
    const promises = require('node:dns/promises');
    const https = require('node:https');
    const {EventEmitter} = require('node:events');
    const {Readable} = require('node:stream');
    const {syncBuiltinESMExports} = require('node:module');
    const original = dns.lookup;
    dns.lookup = function(host,options,callback) {
      if(host!=='monitrail-qa.pooler.supabase.com')return original.apply(this,arguments);
      if(typeof options==='function'){callback=options;options={};}
      queueMicrotask(()=>options?.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4));
    };
    promises.lookup = async(host)=> {
      if(!['monitor.fixture.invalid','recipient.fixture.invalid','api.telegram.org','discord.com','hooks.slack.com'].includes(host)) throw new Error('Synthetic DNS refused');
      return [{address:'93.184.216.34',family:4}];
    };
    https.request = (options,listener)=> {
      const outgoing = new EventEmitter();
      outgoing.destroy=()=>outgoing;
      outgoing.end=()=> {
        if(!['recipient.fixture.invalid','api.telegram.org','discord.com','hooks.slack.com'].includes(options.hostname)) {
          queueMicrotask(()=>outgoing.emit('error',new Error('Synthetic external HTTP refused')));return;
        }
        options.lookup(options.hostname,{all:true},error=>{
          if(error){outgoing.emit('error',error);return;}
          const incoming=Readable.from([Buffer.from('{"ok":true}')]);
          incoming.statusCode=200;incoming.headers={};listener(incoming);
        });
      };
      return outgoing;
    };
    syncBuiltinESMExports();
  `,
	);
	stage = "production build";
	console.log("Building isolated production app with synthetic credentials.");
	await run(
		process.execPath,
		[join(repo, "node_modules/next/dist/bin/next"), "build", "--webpack"],
		{
			cwd: join(tree, "web"),
			env: fixtureEnv,
			log: join(reportDirectory, "build.log"),
		},
	);
	stage = "HTTPS startup";
	let serverLog = "";
	app = spawn(
		process.execPath,
		[
			join(repo, "node_modules/next/dist/bin/next"),
			"start",
			"-H",
			"127.0.0.1",
			"-p",
			"41844",
		],
		{
			cwd: join(tree, "web"),
			env: { ...fixtureEnv, NODE_OPTIONS: `--require=${preload}` },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	app.stdout.on("data", (value) => {
		serverLog += value;
	});
	app.stderr.on("data", (value) => {
		serverLog += value;
	});
	app.once("error", () => {
		serverLog += "Fixture server startup failed.";
	});
	server = createServer(
		{
			key: await readFile(join(lab, "server.key")),
			cert: await readFile(join(lab, "server.crt")),
		},
		(incoming, outgoing) => {
			const upstream = request(
				{
					hostname: "127.0.0.1",
					port: 41844,
					path: incoming.url,
					method: incoming.method,
					headers: {
						...incoming.headers,
						"x-forwarded-proto": "https",
						"x-forwarded-host": incoming.headers.host,
					},
				},
				(response) => {
					outgoing.writeHead(response.statusCode, response.headers);
					response.pipe(outgoing);
				},
			);
			upstream.on("error", () => {
				if (!outgoing.headersSent) outgoing.writeHead(502);
				outgoing.end();
			});
			incoming.pipe(upstream);
		},
	);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(41843, "127.0.0.1", resolve);
	});
	for (let index = 0; index < 50; index++) {
		try {
			await run("curl", [
				"--cacert",
				join(lab, "ca.crt"),
				"-fsS",
				origin,
				"-o",
				"/dev/null",
			]);
			break;
		} catch {
			if (index === 49 || app.exitCode !== null)
				throw new Error("Fixture server unavailable.");
			await pause(200);
		}
	}
	stage = "keyboard and security browser checks";
	// Only the verifier process receives the fixture's inbound webhook secret.
	process.env.TELEGRAM_WEBHOOK_SECRET = fixtureEnv.TELEGRAM_WEBHOOK_SECRET;
	process.env.INTERNAL_HMAC_SECRET = fixtureEnv.INTERNAL_HMAC_SECRET;
	const { verifyBrowser } = await import("./browser.ts");
	const lighthouseReports = [];
	async function audit(page, paths) {
		const cookies = await page.context().cookies(origin);
		const headers = join(lab, "lighthouse-headers.json");
		await writeFile(
			headers,
			JSON.stringify({
				Cookie: cookies
					.map((cookie) => `${cookie.name}=${cookie.value}`)
					.join("; "),
			}),
			{ mode: 0o600 },
		);
		for (const path of paths) {
			if (
				!path.startsWith("/") ||
				path.startsWith("//") ||
				new URL(path, origin).origin !== origin
			)
				throw new Error();
			const output = join(lab, "lighthouse.json");
			await run(
				process.execPath,
				[
					join(repo, "node_modules/lighthouse/cli/index.js"),
					origin + path,
					"--quiet",
					"--output=json",
					`--output-path=${output}`,
					"--only-categories=performance,accessibility,best-practices",
					`--extra-headers=${headers}`,
					"--chrome-flags=--headless --no-sandbox --ignore-certificate-errors --disable-dev-shm-usage",
				],
				{
					env: {
						...baseEnv,
						CHROME_PATH:
							process.env.CHROME_PATH ??
							(existsSync("/usr/bin/chromium")
								? "/usr/bin/chromium"
								: chromium.executablePath()),
					},
					log: join(lab, "lighthouse.log"),
				},
			);
			const report = JSON.parse(await readFile(output, "utf8"));
			if (report.runtimeError) throw new Error();
			lighthouseReports.push({
				path: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "[monitor]"),
				scores: Object.fromEntries(
					Object.entries(report.categories).map(([name, value]) => [
						name,
						value.score,
					]),
				),
				failedAudits: Object.values(report.audits)
					.filter((value) => value.score !== null && value.score < 1)
					.map(({ id, score }) => ({ id, score })),
			});
			await writeFile(
				join(reportDirectory, "lighthouse.json"),
				`${JSON.stringify(lighthouseReports, null, 2)}\n`,
			);
			console.log("Completed a Lighthouse page audit.");
		}
		await rm(headers);
	}
	await verifyBrowser({ origin, db, reportDirectory, audit });
	await writeFile(join(reportDirectory, "server.log"), serverLog, {
		mode: 0o600,
	});
	assert(
		!serverLog.includes("fixture-private-query"),
		"Synthetic query must stay out of server logs.",
	);
	stage = "storage budget";
	assert.equal(
		(await db`SELECT count(*)::int AS count FROM monitors`)[0].count,
		0,
	);
	const { measureStorage } = await import("../db/measure-storage.ts");
	const storage = await measureStorage(db, { confirmSyntheticFixtures: true });
	await writeFile(
		join(reportDirectory, "storage.json"),
		`${JSON.stringify(storage, null, 2)}\n`,
	);
	console.log(
		"Production browser and storage verification passed. Reports saved locally.",
	);
} catch (error) {
	await writeFile(join(reportDirectory, "failure.json"), JSON.stringify({
		stage,
		error: error instanceof Error ? error.name : "Unknown",
		code: error && typeof error === "object" && "code" in error ? error.code : undefined,
		causeCode: error && typeof error === "object" && "cause" in error ? error.cause?.code : undefined,
		location: error instanceof Error ? error.stack?.split("\n")
			.filter(line => line.trim().startsWith("at ")).slice(0, 5) : [],
	}, null, 2), { mode: 0o600 });
	console.error(
		`Production verification failed during ${stage}. Inspect the local report privately.`,
	);
	process.exitCode = 1;
} finally {
	if (app) {
		app.kill("SIGTERM");
		await new Promise((resolve) => {
			if (app.exitCode !== null || app.signalCode !== null) resolve();
			else app.once("exit", resolve);
		});
	}
	if (server) await new Promise((resolve) => server.close(resolve));
	if (db) await db.end({ timeout: 5 });
	for (const child of children) child.kill("SIGTERM");
	if (startedPostgres) {
		try {
			await run(join(pg, "pg_ctl"), [
				"-D",
				join(lab, "data"),
				"-m",
				"immediate",
				"-w",
				"stop",
			]);
		} catch {
			process.exitCode = 1;
		}
	}
	await rm(lab, { recursive: true, force: true });
	console.log("Removed isolated app, database and synthetic credentials.");
}
