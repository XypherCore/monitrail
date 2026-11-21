import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";

if (process.env.CI !== "true" || !process.env.GITHUB_ENV) {
	console.error("Synthetic CI setup requires a GitHub Actions environment.");
	process.exitCode = 1;
} else {
	const random = () => randomBytes(36).toString("base64url");
	const configuration = {
		APP_URL: "https://127.0.0.1:41843",
		SIGNUP_MODE: "invite",
		ABUSE_CONTACT_EMAIL: "abuse@example.invalid",
		DATABASE_URL: `postgres://monitrail_app.fixture:${random()}@monitrail-qa.pooler.supabase.com:6543/monitrail_phase10_fixture`,
		AUTH_SECRET: random(),
		AUTH_GITHUB_ID: random(),
		AUTH_GITHUB_SECRET: random(),
		AUTH_GOOGLE_ID: random(),
		AUTH_GOOGLE_SECRET: random(),
		INTERNAL_HMAC_SECRET: random(),
		CHANNEL_ENC_KEY: randomBytes(32).toString("base64url"),
		CHANNEL_ENC_KEY_ID: "ci-synthetic",
	};
	await appendFile(
		process.env.GITHUB_ENV,
		Object.entries(configuration)
			.map(([key, value]) => `${key}=${value}\n`)
			.join(""),
	);
	console.log("Prepared synthetic CI configuration.");
}
