import {
  alertPrivateHeaders,
  AlertRequestError,
  readAlertJson,
} from "../alerts/request-json.ts";

export type AccountDeletionAccess = { deleteAccount(): Promise<boolean> };
type Dependencies = {
  origin(): string;
  authenticate(request: Request): Promise<AccountDeletionAccess | null>;
};
const privateHeaders = { ...alertPrivateHeaders, vary: "Cookie" };

function failure(status: number, message: string) {
  return Response.json({ error: { message } }, { status, headers: privateHeaders });
}

/** The authentication boundary binds deletion to the validated account. */
export function createAccountDeletionHandler(dependencies: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "DELETE") {
      const response = failure(405, "Unsupported request method.");
      response.headers.set("allow", "DELETE");
      return response;
    }
    try {
      const origin = dependencies.origin();
      if (request.headers.get("origin") !== origin)
        return failure(403, "This request must come from the app.");
      const account = await dependencies.authenticate(request);
      if (!account) return failure(401, "Sign in to delete your account.");
      const input = await readAlertJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== 1 || !("confirm" in input) || input.confirm !== true)
        return failure(400, "Confirm account deletion before continuing.");

      await account.deleteAccount();
      const secure = origin.startsWith("https:");
      return new Response(null, {
        status: 204,
        headers: {
          ...privateHeaders,
          "set-cookie": `${secure ? "__Secure-" : ""}next-auth.session-token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
        },
      });
    } catch (error) {
      return error instanceof AlertRequestError
        ? failure(error.status, "Invalid account deletion request.")
        : failure(503, "Account deletion is temporarily unavailable. Try again.");
    }
  };
}
