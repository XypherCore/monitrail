import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { accounts, sessions, users, verification } from "../db/schema.ts";
import type { AuthConfig } from "./config.ts";
import type { DataExecutor } from "../data/access.ts";
import { createAuthRateLimitStorage } from "./rate-limit.ts";

// Authentication persistence is restricted to these four tables. Pre-login
// identity/session lookup cannot depend on an already authenticated userId.
// Application resources must use the separate owner-scoped data-access layer.
export function createAuthCore(db: Parameters<typeof drizzleAdapter>[0] & DataExecutor, config: AuthConfig) {
  return betterAuth({
    appName: "Monitrail",
    baseURL: config.baseURL,
    basePath: "/api/auth",
    secret: config.secret,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: users, account: accounts, session: sessions, verification },
      transaction: true,
    }),
    socialProviders: { github: config.github, google: { ...config.google, includeGrantedScopes: false } },
    emailAndPassword: { enabled: false },
    user: {
      validateUserInfo: ({ user, source }) => {
        if (source.method !== "oauth" || user.emailVerified !== true) {
          return { error: "provider_email_unverified", errorDescription: "A verified provider email is required." };
        }
      },
    },
    account: {
      encryptOAuthTokens: true,
      storeAccountCookie: false,
      storeStateStrategy: "database",
      accountLinking: { enabled: false },
    },
    session: { cookieCache: { enabled: false } },
    // Preserve the framework's limits; persist atomic decisions across instances.
    rateLimit: { enabled: true, customStorage: createAuthRateLimitStorage(db, config.secret) },
    databaseHooks: {
      account: {
        // The framework encrypts access/refresh tokens, but not idToken.
        // Identity tokens are verified in-flight and are unnecessary at rest.
        create: { before: async account => ({ data: { ...account, idToken: null } }) },
        update: { before: async account => ({ data: { ...account, idToken: null } }) },
      },
    },
    trustedOrigins: [config.baseURL],
    advanced: {
      database: { generateId: "uuid" },
      disableOriginCheck: false, disableCSRFCheck: false,
    },
    disabledPaths: ["/sign-up/email", "/sign-in/email", "/get-access-token", "/refresh-token", "/link-social", "/unlink-account", "/update-user", "/delete-user", "/change-email"],
    onAPIError: { errorURL: `${config.baseURL}/login?error=oauth` },
    // Dependency exceptions may contain database URLs, profile data or tokens.
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
}
