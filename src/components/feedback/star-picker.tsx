"use client";

import { Star } from "lucide-react";
import { MAX_RATING, MIN_RATING, ratingLabels } from "@/lib/feedback/rating";
import { cn } from "@/lib/utils";

/**
 * Five stars, as radio buttons.
 *
 * Radios rather than clickable divs because most of these links are opened on a phone from a
 * WhatsApp message, and a customer using a screen reader or a keyboard should be able to answer
 * as easily as anybody else. The label under the stars is there because a star count means
 * different things to different people — "4" reads as a complaint to some and a compliment to
 * others, and naming it removes the guess.
 */
export function StarPicker({
  name,
  value,
  onChange,
  size = "lg",
}: {
  name: string;
  value: number | null;
  onChange: (rating: number) => void;
  size?: "lg" | "sm";
}) {
  const stars = Array.from({ length: MAX_RATING - MIN_RATING + 1 }, (_, i) => MIN_RATING + i);
  const box = size === "lg" ? "h-10 w-10" : "h-7 w-7";

  return (
    <div>
      <fieldset className="flex flex-wrap items-center gap-1">
        <legend className="sr-only">Rating out of {MAX_RATING}</legend>
        {stars.map((star) => {
          const on = value !== null && star <= value;
          return (
            <label
              key={star}
              className={cn(
                "flex cursor-pointer items-center justify-center rounded-lg transition-colors",
                box,
                "hover:bg-surface-sunken focus-within:ring-2 focus-within:ring-brand",
              )}
            >
              <input
                type="radio"
                name={name}
                value={star}
                checked={value === star}
                onChange={() => onChange(star)}
                className="sr-only"
              />
              <span className="sr-only">
                {star} — {ratingLabels[star]}
              </span>
              <Star
                className={cn(
                  size === "lg" ? "h-8 w-8" : "h-5 w-5",
                  on ? "fill-warning text-warning" : "text-line",
                )}
                aria-hidden
              />
            </label>
          );
        })}
      </fieldset>
      <p className={cn("mt-1 text-sm", value === null ? "text-subtle" : "text-text")}>
        {value === null ? "Tap a star" : ratingLabels[value]}
      </p>
    </div>
  );
}
