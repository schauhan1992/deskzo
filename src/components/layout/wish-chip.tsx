"use client";

import { useState, useTransition, type CSSProperties } from "react";
import { Check, type LucideIcon } from "lucide-react";
import type { Moment } from "@/lib/hr/celebrations";
import { wishButtonLabel } from "@/lib/hr/wish-words";
import { sendWishAction } from "@/actions/wishes";

/**
 * A colleague's birthday or work anniversary in the greeting strip, as a button: a click sends them a
 * wish, and the chip says so from then on. Once: the server keeps one wish per person per occasion,
 * so a second click (or a second tab) changes nothing.
 */
export function WishChip({ moment, icon: Icon, accent }: { moment: Moment; icon: LucideIcon; accent: string }) {
  const wish = moment.wish!;
  const [sent, setSent] = useState(wish.sent);
  const [burst, setBurst] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const label = wishButtonLabel(wish.firstName, wish.kind, sent);

  function send() {
    if (sent || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await sendWishAction(moment.key);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSent(true);
      if (result.data.status === "sent") setBurst((n) => n + 1);
    });
  }

  return (
    <span className="relative inline-flex items-center gap-2">
      <button
        type="button"
        onClick={send}
        aria-disabled={sent || pending}
        aria-label={`${moment.title}. ${label}`}
        title={label}
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-[transform,box-shadow] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
          sent ? "cursor-default" : "hover:-translate-y-px hover:shadow-sm"
        } ${pending ? "cursor-wait" : ""}`}
        style={{ backgroundColor: `${accent}1a`, color: accent, outlineColor: accent }}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        {moment.title}
        {sent ? (
          <span className="inline-flex animate-scale-in items-center gap-0.5 font-semibold">
            <Check className="h-3 w-3" aria-hidden="true" />
            Wished
          </span>
        ) : (
          <span className="rounded-full px-1.5 text-[10px] font-semibold leading-4 text-white" style={{ backgroundColor: accent }}>
            {pending ? "Sending…" : "Wish"}
          </span>
        )}
      </button>
      {burst > 0 && <WishBurst key={burst} accent={accent} />}
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * A ring of sparks thrown out from the chip, once. Directions come from the spark's index, not
 * `Math.random`, so it draws the same every time and in every browser.
 */
const SPARK_COLOURS = ["#f59e0b", "#10b981", "#6366f1", "#ec4899", "#06b6d4"];

function WishBurst({ accent }: { accent: string }) {
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0">
      {Array.from({ length: 12 }, (_, i) => {
        const angle = (i / 12) * Math.PI * 2;
        const reach = 34 + (i % 3) * 10;
        const size = 4 + (i % 3);
        return (
          <span
            key={i}
            className="wish-spark"
            style={
              {
                width: size,
                height: size,
                backgroundColor: i % 4 === 0 ? accent : SPARK_COLOURS[i % SPARK_COLOURS.length],
                "--dx": `${Math.round(Math.cos(angle) * reach * 1.6)}px`,
                "--dy": `${Math.round(Math.sin(angle) * reach)}px`,
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
}
