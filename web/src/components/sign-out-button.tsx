"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "../auth/client";

export function SignOutButton() {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [hasError, setHasError] = useState(false);

	async function signOut() {
		setBusy(true);
		setHasError(false);
		try {
			const result = await authClient.signOut();
			if (result.error) throw new Error("Sign-out failed.");
			router.replace("/");
			router.refresh();
		} catch {
			setHasError(true);
			setBusy(false);
		}
	}

	return (
		<div className="signout-control">
			<button
				className="button button-small"
				type="button"
				disabled={busy}
				onClick={() => void signOut()}
			>
				{busy ? "Signing out…" : "Sign out"}
			</button>
			<div aria-live="polite" aria-atomic="true">
				{hasError && (
					<p className="form-error">Sign-out failed. Please try again.</p>
				)}
			</div>
		</div>
	);
}
