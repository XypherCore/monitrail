import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createDataAccess } from "../data/access.ts";
import { getRuntimeDatabase } from "../db/runtime.ts";
import { sanitizeNextPath } from "./redirect.ts";
import { getAuthRuntime } from "./runtime.ts";

export const getCurrentUser = cache(
  async (): Promise<{ id: string; name: string; email: string | null } | null> => {
    // Let Next.js observe this dynamic read; do not mask its rendering signal.
    const requestHeaders = await headers();
    if (!requestHeaders.has("cookie")) return null;
    try {
      const session = await getAuthRuntime().api.getSession({
        headers: requestHeaders,
        query: { disableRefresh: true },
      });
      if (!session || !/^[0-9a-f-]{36}$/i.test(session.user.id)) return null;
      return { id: session.user.id, name: session.user.name, email: session.user.email };
    } catch {
      throw new Error("Authentication is temporarily unavailable.");
    }
  },
);

export async function requireUser(nextPath: string) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(sanitizeNextPath(nextPath))}`);
  return user;
}

export async function getCurrentDataAccess() {
  const user = await requireUser("/dashboard");
  return createDataAccess(getRuntimeDatabase(), user.id);
}
