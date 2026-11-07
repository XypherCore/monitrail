"use client";

type Session = {
  user: { id: string; name: string; email: string | null };
  session: { expiresAt: string };
} | null;
type Result<T> = { data: T; error: null } | { data: null; error: { status: number } };

async function request<T>(path: string, body?: unknown): Promise<Result<T>> {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.ok
    ? { data: (await response.json()) as T, error: null }
    : { data: null, error: { status: response.status } };
}

async function csrfToken(): Promise<string> {
  const result = await request<{ csrfToken: string }>("csrf");
  if (result.error || typeof result.data.csrfToken !== "string")
    throw new Error("Sign-in unavailable.");
  return result.data.csrfToken;
}

export const authClient = {
  getSession: () => request<Session>("get-session"),
  signOut: async () => request<{ url: string }>("sign-out", { csrfToken: await csrfToken() }),
  signIn: {
    async social(input: {
      provider: "github" | "google";
      callbackURL: string;
      inviteCode?: string;
    }) {
      const result = await request<{ url: string }>("sign-in/social", {
        ...input,
        csrfToken: await csrfToken(),
      });
      if (!result.error) {
        const url = new URL(result.data.url);
        if (
          url.protocol !== "https:" ||
          url.hostname !== (input.provider === "github" ? "github.com" : "accounts.google.com")
        ) {
          throw new Error("Sign-in unavailable.");
        }
        window.location.assign(url.href);
      }
      return result;
    },
  },
};
