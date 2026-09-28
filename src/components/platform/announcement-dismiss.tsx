"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";

/**
 * Dismissing a platform announcement, in this browser.
 *
 * The ids dismissed are kept in localStorage, which is per origin — and each workspace is its own
 * origin — so a dismissal is per workspace and per device, and nothing is sent anywhere. It is read
 * through `useSyncExternalStore` with "nothing dismissed" as the server snapshot, so the server's
 * render and the hydrating one agree, and React hides a dismissed banner once it is mounted.
 *
 * A browser that refuses storage (a private window, blocked site data) still hides the banner when
 * asked — for as long as the page stays open.
 */

const STORAGE_KEY = "wroffy-dismissed-announcements";
/** `storage` fires only in other tabs, so this tab tells itself. */
const CHANGED = "wroffy:announcement-dismissed";
/** Old ids are dropped past this many; an announcement lives 90 days at most. */
const KEEP = 50;

/** Dismissed this page view, for when storage can't be written. */
const dismissedHere = new Set<string>();

function stored(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

function dismiss(id: string) {
  dismissedHere.add(id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...stored().filter((v) => v !== id), id].slice(-KEEP)));
  } catch {
    // Storage refused: hidden until the page is left, which is the best that can be done.
  }
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * Its children — the banner — unless this browser has dismissed announcement `id`. One that isn't
 * dismissible (every CRITICAL one) always shows, even if it was dismissed before it was made so.
 */
export function DismissibleAnnouncement({ id, dismissible, children }: { id: string; dismissible: boolean; children: ReactNode }) {
  const dismissed = useSyncExternalStore(
    subscribe,
    () => dismissedHere.has(id) || stored().includes(id),
    () => false,
  );
  if (dismissible && dismissed) return null;
  return <>{children}</>;
}

/** The ✕ on a dismissible banner; the server passes it as the banner's `dismissAction`. */
export function DismissAnnouncementButton({ id }: { id: string }) {
  return (
    <IconButton
      icon={X}
      label="Dismiss announcement"
      onClick={() => dismiss(id)}
      className="text-current opacity-80 hover:bg-surface/60 hover:text-current hover:opacity-100"
    />
  );
}
