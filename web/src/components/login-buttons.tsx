"use client";

import { useState } from "react";
import { authClient } from "../auth/client";

type Provider = "github" | "google";

export function LoginButtons({
	nextPath,
	initialError,
}: {
	nextPath: string;
	initialError: boolean;
}) {
	const [busy, setBusy] = useState<Provider | null>(null);
	const [hasError, setHasError] = useState(initialError);

	async function signIn(provider: Provider) {
		setBusy(provider);
		setHasError(false);
		try {
			const result = await authClient.signIn.social({
				provider,
				callbackURL: nextPath,
				errorCallbackURL: `/login?error=oauth&next=${encodeURIComponent(nextPath)}`,
			});
			if (result.error) {
				setHasError(true);
			}
		} catch {
			setHasError(true);
		} finally {
			setBusy(null);
		}
	}

	return (
		<div>
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
						We couldn’t complete sign-in. Please try again.
					</p>
				)}
			</div>
		</div>
	);
}
