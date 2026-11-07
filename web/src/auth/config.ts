export type AuthConfig = {
  baseURL: string;
  secret: string;
  github: { clientId: string; clientSecret: string };
  google: { clientId: string; clientSecret: string };
  signupMode: "invite" | "open";
};

export function readAuthConfig(
  env: Readonly<Record<string, string | undefined>>,
  production = false,
): AuthConfig {
  const invalid = () => new Error("Authentication configuration is invalid.");
  function required(name: string): string {
    const value = env[name];
    if (!value || value.trim() !== value || /[<>\r\n]/.test(value)) throw invalid();
    return value;
  }
  let origin: URL;
  try {
    origin = new URL(required("APP_URL"));
  } catch {
    throw invalid();
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && local && !production))
  )
    throw invalid();
  const secret = required("AUTH_SECRET");
  if (secret.length < 32) throw invalid();
  const signupMode = env.SIGNUP_MODE ?? "invite";
  if (signupMode !== "invite" && signupMode !== "open") throw invalid();
  return {
    baseURL: origin.origin,
    secret,
    github: { clientId: required("AUTH_GITHUB_ID"), clientSecret: required("AUTH_GITHUB_SECRET") },
    google: { clientId: required("AUTH_GOOGLE_ID"), clientSecret: required("AUTH_GOOGLE_SECRET") },
    signupMode,
  };
}
