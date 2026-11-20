import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The operator supplies this origin. Monitor destinations never enter this path. */
export async function checkHealth(appUrl, transport = fetch) {
  let response;
  try {
    if (typeof appUrl !== "string" || !appUrl) return false;
    const url = new URL(appUrl);
    if (url.protocol !== "https:" || url.username || url.password ||
      (appUrl !== url.origin && appUrl !== url.origin + "/")) return false;
    response = await transport(new URL("/api/health", url.origin), {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return response.status === 200 && !response.redirected;
  } catch {
    return false;
  } finally {
    // Never consume or print the endpoint's content or network exception.
    void response?.body?.cancel().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (await checkHealth(process.env.APP_URL)) console.log("Application health check passed.");
  else {
    console.error("::error::Application health check failed.");
    process.exitCode = 1;
  }
}
