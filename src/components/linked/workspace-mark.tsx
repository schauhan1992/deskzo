"use client";

import { useState, useSyncExternalStore } from "react";
import { initialsOf } from "@/components/ui/avatar";

const SIZES = {
  sm: "h-7 w-7 text-[11px]",
  md: "h-9 w-9 text-xs",
} as const;

const noSubscribe = () => () => {};

/**
 * A workspace as a small square: its logo, else its initials on the brand tint — the linked sign-in
 * switcher's rows and Profile's list (spec §2.1, §2.4).
 *
 * Decorative: the workspace's name is always written beside it, so the tile is hidden from assistive
 * technology rather than announced a second time.
 *
 * `src` is this workspace's logo as a data URL, or another workspace's `<origin>/api/brand/mark`, which
 * answers 404 when that workspace has no logo. Either way a failure falls back to the initials, from
 * the image's own error event.
 */
export function WorkspaceMark({
  name,
  initials,
  src,
  size = "sm",
}: {
  name: string;
  initials: string;
  src: string | null;
  size?: "sm" | "md";
}) {
  // An address is drawn only once hydrated: an image that fails before React is listening never
  // reports its error, and would leave an empty tile where the initials belong. A data URL has no
  // server to fail on, so it is drawn at once — the header's own mark must not flicker on every load.
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  // The source that failed rather than a flag, so a different one is tried afresh without an effect.
  const [failed, setFailed] = useState<string | null>(null);
  const image = src && failed !== src && (isClient || src.startsWith("data:")) ? src : null;

  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 select-none place-items-center overflow-hidden rounded-lg font-semibold ${SIZES[size]} ${
        image ? "border border-line bg-surface" : "bg-brand-subtle text-brand"
      }`}
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- another workspace's address or a data URL, and the fallback needs the element's own error event
        <img
          src={image}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(image)}
          className="h-full w-full object-contain"
        />
      ) : (
        (initials.trim() || initialsOf(name)).slice(0, 3)
      )}
    </span>
  );
}
