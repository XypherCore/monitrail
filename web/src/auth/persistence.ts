import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Adapter } from "next-auth/adapters";
import type { DataExecutor } from "../data/access.ts";

export type AuthDatabase = DataExecutor & {
  transaction<T>(run: (transaction: DataExecutor) => Promise<T>): Promise<T>;
};
export type AuthUser = { id: string; name: string; email: string | null; image: string | null };
export type AuthIdentity = {
  provider: "github" | "google";
  providerAccountId: string;
  name: string;
  email: string | null;
  image: string | null;
};
export class AuthPersistenceError extends Error {
  readonly category: "unavailable" | "invite" | "account-conflict";
  constructor(category: AuthPersistenceError["category"] = "unavailable") {
    super("Authentication could not be completed.");
    this.name = "AuthPersistenceError";
    this.category = category;
  }
}
type Row = Record<string, unknown>;

async function rows(db: DataExecutor, statement: SQL): Promise<Row[]> {
  try {
    const result = await db.execute(statement);
    if (!Array.isArray(result.rows)) throw new Error();
    return result.rows as Row[];
  } catch {
    throw new AuthPersistenceError();
  }
}

function user(row: Row): AuthUser {
  return {
    id: String(row.id),
    name: String(row.name),
    email: row.email === null ? null : String(row.email),
    image: row.image === null ? null : String(row.image),
  };
}
const fields = sql`u.id,u.name,u.email,u.avatar_url AS image`;

export function createAuthPersistence(db: AuthDatabase) {
  const getUser = async (id: string) => {
    const [found] = await rows(db, sql`SELECT ${fields} FROM users u WHERE u.id=${id}::uuid`);
    return found ? user(found) : null;
  };
  const getUserByAccount = async (account: { provider: string; providerAccountId: string }) => {
    const [found] = await rows(
      db,
      sql`SELECT ${fields} FROM users u JOIN accounts a ON a.user_id=u.id
      WHERE a.provider=${account.provider} AND a.provider_account_id=${account.providerAccountId}`,
    );
    return found ? user(found) : null;
  };
  const getSessionAndUser = async (token: string) => {
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) return null;
    const [found] = await rows(
      db,
      sql`SELECT ${fields},s.session_token,s.expires FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.session_token=${token} AND s.expires>now()`,
    );
    if (!found) return null;
    return {
      user: user(found),
      session: {
        sessionToken: String(found.session_token),
        userId: String(found.id),
        expires: new Date(found.expires as string | Date),
      },
    };
  };

  return {
    getUser,
    getUserByAccount,
    getSessionAndUser,
    async provision(
      identity: AuthIdentity,
      inviteHash: string | null,
      signupMode: "invite" | "open",
    ): Promise<AuthUser> {
      if (
        !["github", "google"].includes(identity.provider) ||
        !identity.providerAccountId ||
        !identity.name ||
        (identity.email !== null && (!identity.email || /\s/u.test(identity.email)))
      ) {
        throw new AuthPersistenceError();
      }
      try {
        return await db.transaction(async (transaction) => {
          await rows(transaction, sql`SET LOCAL lock_timeout = '2s'`);
          await rows(transaction, sql`SET LOCAL statement_timeout = '5s'`);
          await rows(transaction, sql`SELECT pg_advisory_xact_lock(1869507689,1953653098)`);
          const [existing] = await rows(
            transaction,
            sql`SELECT ${fields} FROM users u JOIN accounts a ON a.user_id=u.id
            WHERE a.provider=${identity.provider} AND a.provider_account_id=${identity.providerAccountId}`,
          );
          if (existing) return user(existing);
          if (identity.email !== null) {
            const duplicate = await rows(
              transaction,
              sql`SELECT id FROM users WHERE lower(email)=lower(${identity.email})`,
            );
            if (duplicate.length) throw new AuthPersistenceError("account-conflict");
          }
          let invitation: Row | undefined;
          if (signupMode === "invite") {
            if (!inviteHash || !/^[0-9a-f]{64}$/.test(inviteHash))
              throw new AuthPersistenceError("invite");
            [invitation] = await rows(
              transaction,
              sql`SELECT id FROM invites WHERE code_hash=${inviteHash} AND used_at IS NULL FOR UPDATE`,
            );
            if (!invitation) throw new AuthPersistenceError("invite");
          }
          const id = randomUUID();
          const [created] = await rows(
            transaction,
            sql`INSERT INTO users(id,name,email,avatar_url)
            VALUES (${id},${identity.name},${identity.email},${identity.image})
            RETURNING id,name,email,avatar_url AS image`,
          );
          if (!created) throw new AuthPersistenceError();
          await rows(
            transaction,
            sql`INSERT INTO accounts(provider,provider_account_id,user_id)
            VALUES (${identity.provider},${identity.providerAccountId},${id})`,
          );
          if (invitation)
            await rows(
              transaction,
              sql`UPDATE invites SET used_at=now(),used_by=${id} WHERE id=${invitation.id}::uuid`,
            );
          return user(created);
        });
      } catch (error) {
        if (error instanceof AuthPersistenceError) throw error;
        throw new AuthPersistenceError();
      }
    },
    // Auth.js calls provisioning methods only after the verified signIn callback.
    // The callback atomically creates the user, provider account and invite above.
    // Runtime null email is supported by the OAuth core. Its adapter declaration
    // still requires string email, so the cast is confined to this boundary.
    adapter: {
      getUser: async (id: string) => {
        const found = await getUser(id);
        return found && { ...found, emailVerified: null };
      },
      getUserByAccount: async (account: { provider: string; providerAccountId: string }) => {
        const found = await getUserByAccount(account);
        return found && { ...found, emailVerified: null };
      },
      getUserByEmail: async (email: string) => {
        const [found] = await rows(
          db,
          sql`SELECT ${fields} FROM users u WHERE lower(u.email)=lower(${email})`,
        );
        return found ? { ...user(found), emailVerified: null } : null;
      },
      createUser: async () => {
        throw new AuthPersistenceError();
      },
      linkAccount: async () => {
        throw new AuthPersistenceError();
      },
      updateUser: async ({ id }: { id: string }) => {
        const found = await getUser(id);
        if (!found) throw new AuthPersistenceError();
        return { ...found, emailVerified: null };
      },
      createSession: async (session: { sessionToken: string; userId: string; expires: Date }) => {
        await rows(
          db,
          sql`INSERT INTO sessions(session_token,user_id,expires) VALUES
          (${session.sessionToken},${session.userId}::uuid,${session.expires.toISOString()}::timestamptz)`,
        );
        return session;
      },
      getSessionAndUser: async (token: string) => {
        const found = await getSessionAndUser(token);
        return found && { ...found, user: { ...found.user, emailVerified: null } };
      },
      updateSession: async (session: { sessionToken: string; expires?: Date }) => {
        const found = await getSessionAndUser(session.sessionToken);
        if (!found) return null;
        if (session.expires)
          await rows(
            db,
            sql`UPDATE sessions SET expires=${session.expires.toISOString()}::timestamptz
          WHERE session_token=${session.sessionToken} AND expires>now()`,
          );
        return { ...found.session, ...session };
      },
      deleteSession: async (token: string) => {
        await rows(db, sql`DELETE FROM sessions WHERE session_token=${token}`);
      },
    } as Adapter,
  };
}
