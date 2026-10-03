"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarHeart, Cake, ChevronDown, X } from "lucide-react";
import type { WishOccasion } from "@/lib/hr/wishes";
import { initialsOf, wishHeading, wishSummary } from "@/lib/hr/wish-words";
import { markWishesSeenAction, myWishesToday } from "@/actions/wishes";
import { Confetti } from "@/components/layout/celebration-splash";
import { useClock } from "@/components/time/clock-provider";
import { LAYER_CORNER } from "@/components/ui/layers";

/** How often, on somebody's own day, the card asks whether anybody else has wished them. */
const LISTEN_MS = 60_000;
const ACCENT = { BIRTHDAY: "#ec4899", ANNIVERSARY: "#8b5cf6" } as const;
const COLOURS = ["#ec4899", "#f59e0b", "#6366f1", "#10b981", "#06b6d4"];

/**
 * The wishes somebody has had today, in a card in the corner of the screen: on their birthday or work
 * anniversary, once anybody has wished them.
 *
 * It is not a modal and takes nothing from the page: no backdrop, no focus taken, no scroll locked,
 * and the animations run out on their own. Closing it marks the wishes seen, and a wish that arrives
 * later brings it back with the new name first. While the person is on their day it listens once a
 * minute, so a wish sent while they work finds them without a reload. Fifty wishes are one sentence
 * and a list, not fifty cards.
 *
 * The notification opens it with `?wishes=open`, closed or not. `readOnly` while an admin views as
 * the person: shown, never marked seen.
 */
export function WishesCorner({ initial, readOnly }: { initial: WishOccasion[]; readOnly: boolean }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const forced = searchParams.get("wishes") === "open";
  const [occasions, setOccasions] = useState(initial);
  const [closed, setClosed] = useState(false);
  // Opened from the notification: the list, not just the line.
  const [expanded, setExpanded] = useState(forced);

  // Listening only on the person's own day: on any other, there is nothing to hear.
  const onTheDay = occasions.length > 0;
  useEffect(() => {
    if (!onTheDay) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      myWishesToday()
        .then(setOccasions)
        .catch(() => {});
    }, LISTEN_MS);
    return () => window.clearInterval(timer);
  }, [onTheDay]);

  const unseen = occasions.reduce((n, o) => n + o.wishes.filter((w) => !w.seen).length, 0);
  const wished = occasions.filter((o) => o.wishes.length > 0);

  // Reopened by a new wish, or by the notification's link — decided while rendering, from what
  // changed since the last render, rather than in an effect after it.
  const [last, setLast] = useState({ unseen, forced });
  if (last.unseen !== unseen || last.forced !== forced) {
    setLast({ unseen, forced });
    if (unseen > last.unseen || (forced && !last.forced)) setClosed(false);
    if (forced && !last.forced) setExpanded(true);
  }

  if (wished.length === 0 || closed || (unseen === 0 && !forced)) return null;

  function close() {
    setClosed(true);
    setExpanded(false);
    setOccasions((all) => all.map((o) => ({ ...o, wishes: o.wishes.map((w) => ({ ...w, seen: true })) })));
    if (!readOnly) void markWishesSeenAction(occasions.map((o) => o.occasionKey));
    // The link that opened it is spent: the address should not keep saying "open".
    if (forced) {
      const rest = new URLSearchParams(searchParams.toString());
      rest.delete("wishes");
      router.replace(rest.size ? `${pathname}?${rest}` : pathname, { scroll: false });
    }
  }

  return (
    <div role="status" aria-live="polite" className={`fixed inset-x-4 bottom-4 sm:inset-x-auto sm:right-4 sm:w-[22rem] xl:right-16 ${LAYER_CORNER}`}>
      <div className="relative animate-wish-in overflow-hidden rounded-2xl border border-line bg-surface shadow-lg">
        {/* Thrown again whenever a new wish arrives: the key is how many are new. */}
        <Confetti key={`confetti-${unseen}`} accent={ACCENT[wished[0]!.kind]} pieces={26} short />
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="absolute right-2.5 top-2.5 z-10 rounded-base p-1.5 text-subtle transition-colors hover:bg-surface-sunken hover:text-text"
        >
          <X className="h-4 w-4" />
        </button>
        {wished.map((o, index) => (
          <OccasionWishes key={o.occasionKey} occasion={o} first={index === 0} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
        ))}
      </div>
    </div>
  );
}

function OccasionWishes({
  occasion,
  first,
  expanded,
  onToggle,
}: {
  occasion: WishOccasion;
  first: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const clock = useClock();
  const accent = ACCENT[occasion.kind];
  const Icon = occasion.kind === "BIRTHDAY" ? Cake : CalendarHeart;
  const fresh = occasion.wishes.filter((w) => !w.seen).length;
  const faces = occasion.wishes.slice(0, 5);
  const more = occasion.wishes.length - faces.length;

  return (
    <section className={first ? "" : "border-t border-line"}>
      <div className="relative overflow-hidden px-4 pb-3 pt-4" style={{ backgroundColor: `${accent}14` }}>
        {first &&
          COLOURS.map((colour, i) => (
            <span
              key={colour}
              aria-hidden
              className="wish-balloon"
              style={{ left: `${12 + i * 17}%`, backgroundColor: colour, color: colour, animationDelay: `${0.15 + i * 0.35}s` }}
            />
          ))}
        <div className="relative flex items-start gap-3 pr-6">
          <span className="grid h-10 w-10 shrink-0 animate-wish-bob place-items-center rounded-full" style={{ backgroundColor: `${accent}26`, color: accent }}>
            <Icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text">{wishHeading(occasion.kind, occasion.years)}</p>
            <p className="mt-0.5 text-sm text-muted">{wishSummary(occasion.wishes.map((w) => w.senderName), occasion.kind)}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex items-center">
          {faces.map((w, i) => (
            <span
              key={w.id}
              title={w.senderName}
              className="-ml-1.5 grid h-7 w-7 place-items-center rounded-full border-2 border-surface text-[10px] font-semibold text-white first:ml-0"
              style={{ backgroundColor: COLOURS[i % COLOURS.length], zIndex: faces.length - i }}
            >
              {initialsOf(w.senderName)}
            </span>
          ))}
          {more > 0 && <span className="ml-1.5 text-xs font-medium text-muted">+{more}</span>}
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="inline-flex items-center gap-1 rounded-base px-2 py-1 text-xs font-medium hover:bg-surface-sunken"
          style={{ color: accent }}
        >
          {expanded ? "Hide" : occasion.wishes.length === 1 ? "See who" : `See all ${occasion.wishes.length}`}
          {!expanded && fresh > 0 && fresh < occasion.wishes.length && <span className="text-subtle">· {fresh} new</span>}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
        </button>
      </div>

      {expanded && (
        <ul className="max-h-56 overflow-y-auto border-t border-line px-2 py-1.5">
          {occasion.wishes.map((w, i) => (
            <li key={w.id} className="flex items-center gap-2.5 rounded-base px-2 py-1.5">
              <span
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[9px] font-semibold text-white"
                style={{ backgroundColor: COLOURS[i % COLOURS.length] }}
              >
                {initialsOf(w.senderName)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-text">{w.senderName}</span>
              {!w.seen && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: accent }}>
                  <span className="sr-only">new</span>
                </span>
              )}
              <span className="shrink-0 text-xs text-subtle">{clock.time(w.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
