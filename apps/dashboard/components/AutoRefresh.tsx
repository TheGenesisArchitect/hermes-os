"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-fetches server-component data on an interval so the dashboard stays live. */
export function AutoRefresh({ ms = 10_000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), ms);
    return () => clearInterval(id);
  }, [router, ms]);
  return null;
}
