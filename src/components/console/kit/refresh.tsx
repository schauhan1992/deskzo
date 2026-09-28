"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { StatusPill } from "./status";

/** Re-runs the page's loaders; the icon turns until the fresh render has landed. */
export function RefreshButton({ label = "Refresh" }: { label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <IconButton
      icon={RotateCw}
      label={label}
      onClick={() => startTransition(() => router.refresh())}
      className={pending ? "[&_svg]:animate-spin" : undefined}
    />
  );
}

/**
 * Keeps a live board current: refreshes every `seconds` while the tab is visible, and once on coming
 * back to a tab that has missed a refresh. A hidden tab never polls — thirty open consoles would
 * otherwise run every board's loaders around the clock for nobody.
 */
export function AutoRefresh({ seconds, live = true }: { seconds: number; live?: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!live) return;
    const every = Math.max(5, Number.isFinite(seconds) ? seconds : 60) * 1000;
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      last = Date.now();
      router.refresh();
    };
    const handle = window.setInterval(refresh, every);
    const onVisibility = () => {
      if (Date.now() - last >= every) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(handle);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [live, seconds, router]);

  if (!live) return null;
  return (
    <StatusPill tone="success" title={`Refreshes every ${seconds} seconds while this tab is open`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current" />
      Live
    </StatusPill>
  );
}
