import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { APIResponse } from "@playwright/test";
import postgres from "postgres";
import {
  postgresOptions,
  postgresProject,
  readPostgresUrl,
  readRuntimePostgresUrl,
} from "../../src/db/postgres-config.ts";
import { fixtureOwners } from "../db/fixtures.ts";

export type FixtureDatabase = ReturnType<typeof postgres>;
export type FixtureSession = { userId: string; token: string; expires: Date };

export function openFixtureDatabase(): FixtureDatabase {
  const runtimeUrl = readRuntimePostgresUrl(process.env.DATABASE_URL);
  const migrationUrl = readPostgresUrl(process.env.MIGRATION_DATABASE_URL);
  if (
    postgresProject(runtimeUrl) !== postgresProject(migrationUrl) ||
    new URL(runtimeUrl).pathname !== new URL(migrationUrl).pathname
  ) {
    throw new Error("The fixture and runtime databases must use the same disposable project.");
  }
  return postgres(runtimeUrl, postgresOptions());
}

export function newFixtureSession(userId: string): FixtureSession {
  return { userId, token: randomUUID(), expires: new Date(Date.now() + 10 * 60_000) };
}

export async function insertSeededOwnerSession(db: FixtureDatabase, session: FixtureSession) {
  const [owner] = fixtureOwners;
  assert.equal(session.userId, owner.id);
  // Write only when the database role and the full synthetic identity match.
  const inserted = await db`INSERT INTO public.sessions(session_token,user_id,expires)
    SELECT ${session.token},u.id,${session.expires} FROM public.users u
    WHERE current_user='monitrail_app' AND u.id=${owner.id} AND u.email=${owner.email}
      AND u.name=${owner.name} AND EXISTS (
        SELECT 1 FROM public.monitors m WHERE m.id=${owner.monitorId} AND m.user_id=u.id
          AND m.url='https://demo-1.example.invalid/' AND m.is_paused=true
      ) RETURNING 1`;
  assert.equal(inserted.count, 1);
}

export function fixtureCookie(baseURL: string, session: FixtureSession) {
  const secure = new URL(baseURL).protocol === "https:";
  return {
    name: `${secure ? "__Secure-" : ""}next-auth.session-token`,
    value: session.token,
    url: new URL("/", baseURL).href,
    expires: Math.floor(session.expires.getTime() / 1000),
    httpOnly: true,
    secure,
    sameSite: "Lax" as const,
  };
}

export async function assertFixtureSessionProjection(
  db: FixtureDatabase,
  session: FixtureSession,
  request: () => Promise<APIResponse>,
  secureCookieName?: string,
) {
  const [owner] = fixtureOwners;
  try {
    const response = await request();
    assert.equal(response.status(), 200);
    assert.match(response.headers()["cache-control"], /no-store/);
    const body = await response.text();
    assert(!body.includes(session.token));
    const projected = JSON.parse(body);
    assert.deepEqual(Object.keys(projected).sort(), ["session", "user"]);
    assert.deepEqual(Object.keys(projected.session), ["expiresAt"]);
    assert.deepEqual(projected.user, { id: owner.id, email: owner.email, name: owner.name });
    if (secureCookieName) {
      const cookies = (await response.headersArray()).filter(({ name }) => name.toLowerCase() === "set-cookie");
      assert(cookies.some(({ value }) => value.startsWith(`${secureCookieName}=`) &&
        /;\s*Secure(?:;|$)/i.test(value) && /;\s*HttpOnly(?:;|$)/i.test(value) && /;\s*SameSite=Lax(?:;|$)/i.test(value)));
    }
  } finally {
    // Auth.js can renew a session on this endpoint. Restore the fixture's deadline.
    await db`UPDATE public.sessions SET expires=${session.expires}
      WHERE session_token=${session.token} AND user_id=${session.userId}`;
  }
}

export async function assertFixtureSessionRevoked(db: FixtureDatabase, session: FixtureSession) {
  const remaining = await db`SELECT 1 FROM public.sessions
    WHERE session_token=${session.token} AND user_id=${session.userId}`;
  assert.equal(remaining.length, 0);
}

export async function removeFixtureSession(db: FixtureDatabase, session: FixtureSession) {
  await db`DELETE FROM public.sessions
    WHERE session_token=${session.token} AND user_id=${session.userId}`;
}

const revocationOwnerName = "Demo revocation owner";

export async function insertRevocationAccount(db: FixtureDatabase, session: FixtureSession) {
  await db.begin(async (transaction) => {
    const inserted = await transaction`INSERT INTO public.users(id,name)
      SELECT ${session.userId},${revocationOwnerName} WHERE current_user='monitrail_app'
      RETURNING 1`;
    assert.equal(inserted.count, 1);
    await transaction`INSERT INTO public.sessions(session_token,user_id,expires)
      VALUES (${session.token},${session.userId},${session.expires})`;
  });
}

export async function removeRevocationAccount(db: FixtureDatabase, userId: string) {
  const deleted = await db`DELETE FROM public.users WHERE id=${userId}
    AND name=${revocationOwnerName} AND email IS NULL`;
  return deleted.count;
}
