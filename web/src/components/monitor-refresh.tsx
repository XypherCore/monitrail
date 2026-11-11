"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const REFRESH_MS = 60_000;

export function MonitorRefresh() {
  const router = useRouter();

  useEffect(() => {
    let refreshedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    function schedule() {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      timer = setTimeout(refresh, Math.max(0, REFRESH_MS - (Date.now() - refreshedAt)));
    }

    function refresh() {
      if (document.visibilityState !== "visible") return;
      refreshedAt = Date.now();
      router.refresh();
      schedule();
    }

    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [router]);

  return null;
}
