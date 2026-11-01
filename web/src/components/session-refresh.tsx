"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { authClient } from "../auth/client";
import { sanitizeNextPath } from "../auth/redirect";

// Renew through HTTP so the browser receives the session's Set-Cookie header.
// Server rendering remains read-only; this runs only on mount and navigation.
export function SessionRefresh() {
	const pathname = usePathname();
	const router = useRouter();

	useEffect(() => {
		let active = true;

		async function refresh() {
			try {
				const result = await authClient.getSession();
				if (!active) return;
				if (result.error?.status === 401 || (!result.error && !result.data?.user)) {
					const next = sanitizeNextPath(pathname);
					router.replace(`/login?next=${encodeURIComponent(next)}`);
					router.refresh();
				}
			} catch {
				// A temporary request failure does not reveal dependency details.
			}
		}

		void refresh();
		return () => {
			active = false;
		};
	}, [pathname, router]);

	return null;
}
