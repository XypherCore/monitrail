"use client";

import { useState } from "react";
import { authClient } from "../auth/client";

type Provider = "github" | "google";

export function LoginButtons({
  nextPath,
  initialError,
  inviteOnly,
}: {
  nextPath: string;
  initialError: "invite" | "account_conflict" | "oauth" | null;
  inviteOnly: boolean;
}) {
  const [busy, setBusy] = useState<Provider | null>(null);
  const [hasError, setHasError] = useState(initialError);
  const [inviteCode, setInviteCode] = useState("");

  async function signIn(provider: Provider) {
    setBusy(provider);
    setHasError(null);
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: nextPath,
        inviteCode,
      });
      if (result.error) {
        setHasError("oauth");
      }
    } catch {
      setHasError("oauth");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {inviteOnly && (
        <div className="invite-field">
          <label htmlFor="invite-code">Invitation code</label>
          <input
            id="invite-code"
            type="password"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            autoComplete="off"
            maxLength={256}
            disabled={busy !== null}
            aria-describedby="invite-help"
          />
          <p className="login-note" id="invite-help">
            First-time sign-ins need an invitation. Returning users can leave this blank.
          </p>
        </div>
      )}
      <div className="provider-buttons" aria-busy={busy !== null}>
        <button
          className="button provider-button"
          type="button"
          disabled={busy !== null}
          onClick={() => void signIn("github")}
        >
          <span className="provider-symbol" aria-hidden="true">
            GH
          </span>
          {busy === "github" ? "Opening GitHub…" : "Continue with GitHub"}
        </button>
        <button
          className="button provider-button"
          type="button"
          disabled={busy !== null}
          onClick={() => void signIn("google")}
        >
          <span className="provider-symbol" aria-hidden="true">
            G
          </span>
          {busy === "google" ? "Opening Google…" : "Continue with Google"}
        </button>
      </div>
      <div aria-live="polite" aria-atomic="true">
        {hasError && (
          <p className="form-error">
            {hasError === "account_conflict"
              ? "Sign in with the provider you used before."
              : hasError === "invite"
                ? "Enter a valid unused invitation code and try again."
                : "We couldn’t complete sign-in. Please try again."}
          </p>
        )}
      </div>
    </div>
  );
}
