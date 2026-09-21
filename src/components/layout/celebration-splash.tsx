"use client";

import { useEffect, useState } from "react";
import { Cake, PartyPopper, Sparkles, Trophy, X, Gift, Megaphone, CalendarHeart } from "lucide-react";
import type { Moment, MomentTone } from "@/lib/hr/celebrations";
import { dismissMoment } from "@/actions/celebration";
import { Button } from "@/components/ui/button";

const ICONS: Record<MomentTone, typeof Cake> = {
  birthday: Cake,
  anniversary: CalendarHeart,
  festival: Sparkles,
  achievement: Trophy,
  milestone: PartyPopper,
  welcome: Gift,
  announcement: Megaphone,
};

/** A default tint per occasion, overridden by whatever the author picked. */
const ACCENTS: Record<MomentTone, string> = {
  birthday: "#ec4899",
  anniversary: "#8b5cf6",
  festival: "#f59e0b",
  achievement: "#10b981",
  milestone: "#3b82f6",
  welcome: "#06b6d4",
  announcement: "#6366f1",
};

/**
 * The greeting that takes over the screen, and the strip that does not.
 *
 * Two rules decide which is which, and they matter more than anything else here: an occasion only
 * interrupts somebody when it is *theirs* or when a person deliberately wrote it for today. A
 * colleague's birthday goes in the strip. Getting this wrong turns a nice feature into a modal
 * people click past without reading, which is worse than not having it.
 *
 * Dismissal is recorded on the server, so closing it on a laptop also closes it on a phone, and it
 * happens the moment the splash opens rather than on the close button — otherwise somebody who
 * navigates away without clicking gets the same greeting on the next page load.
 */
export function CelebrationSplash({ moments }: { moments: Moment[] }) {
  const splashes = moments.filter((m) => m.splash);
  const [index, setIndex] = useState(0);
  const current = splashes[index];

  // Recorded on open, not on close. Somebody who reads it and navigates away has still seen it.
  useEffect(() => {
    if (!current) return;
    void dismissMoment(current.key);
  }, [current]);

  useEffect(() => {
    if (!current) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIndex((i) => i + 1);
    }
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [current]);

  if (!current) return null;
  return (
    <SplashCard
      moment={current}
      remaining={splashes.length - index - 1}
      onClose={() => setIndex((i) => i + 1)}
    />
  );
}

function SplashCard({ moment, remaining, onClose }: { moment: Moment; remaining: number; onClose: () => void }) {
  const Icon = ICONS[moment.tone];
  const accent = moment.accent || ACCENTS[moment.tone];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-md animate-scale-in overflow-hidden rounded-2xl border border-line bg-surface shadow-lg">
        {/* The tint is applied inline because it is per-occasion data, not a theme token — a
            celebration posted with a colour has to render in that colour. */}
        <div className="relative px-6 pb-6 pt-10 text-center" style={{ backgroundColor: `${accent}1a` }}>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 rounded-base p-1.5 text-subtle transition-colors hover:bg-surface hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>

          {moment.imageDataUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element -- a data URL, already in the payload */
            <img
              src={moment.imageDataUrl}
              alt=""
              className="mx-auto mb-4 max-h-40 w-auto rounded-xl object-contain"
            />
          ) : (
            <span
              className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full"
              style={{ backgroundColor: `${accent}33`, color: accent }}
            >
              <Icon className="h-8 w-8" />
            </span>
          )}

          <h2 className="text-xl font-semibold text-text">{moment.title}</h2>
          {moment.message && <p className="mt-2 text-sm text-muted">{moment.message}</p>}

          {/* Only when it is about somebody other than the person reading it — telling you your own
              name is noise. */}
          {moment.subject && !moment.aboutViewer && (
            <p className="mt-3 text-sm font-medium" style={{ color: accent }}>
              {moment.subject.name}
              {moment.subject.designation && (
                <span className="block text-xs font-normal text-subtle">{moment.subject.designation}</span>
              )}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <span className="text-xs text-subtle">
            {remaining > 0 ? `${remaining} more` : "Have a good day"}
          </span>
          <Button size="sm" onClick={onClose}>
            {remaining > 0 ? "Next" : "Thanks"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The quiet line above the dashboard: the greeting, plus whose birthday it is.
 *
 * Never interrupts, and is not dismissed — it is simply what is true today, and it disappears
 * tomorrow on its own.
 */
export function GreetingStrip({ greeting, moments }: { greeting: string; moments: Moment[] }) {
  // Only the quiet ones: anything that earned a splash has already had its moment.
  const quiet = moments.filter((m) => !m.splash);
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="text-lg font-semibold text-text">{greeting}</h2>
      {quiet.map((m) => {
        const Icon = ICONS[m.tone];
        const accent = m.accent || ACCENTS[m.tone];
        return (
          <span
            key={m.key}
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ backgroundColor: `${accent}1a`, color: accent }}
            title={m.message ?? undefined}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {m.title}
          </span>
        );
      })}
    </div>
  );
}
