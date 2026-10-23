import { cn } from "@/lib/utils";
import { DESKZO_BLUE, DESKZO_MARK, DESKZO_WORDMARK } from "@/lib/brand/deskzo-logo";

/**
 * Deskzo's own logo (src/lib/brand/deskzo-logo.ts) — for Deskzo's surfaces only: deskzo.com, signup and
 * sign-in, the console, the partner portal. A workspace shows its own logo (src/lib/branding.ts).
 *
 * `tone`: "auto" is Deskzo blue on a light page and white on a dark one (`--deskzo-logo`, globals.css);
 * "blue" and "white" fix it; "current" takes the text colour.
 */
type Tone = "auto" | "blue" | "white" | "current";

const fillOf = (tone: Tone) => (tone === "blue" ? DESKZO_BLUE : tone === "white" ? "#FFFFFF" : tone === "current" ? "currentColor" : "var(--deskzo-logo)");

/** The wordmark — "Deskzo" as the logo draws it. Sized by its height: `className="h-6"`. */
export function DeskzoWordmark({ className, tone = "auto", title = "Deskzo" }: { className?: string; tone?: Tone; title?: string }) {
  return (
    <svg viewBox={DESKZO_WORDMARK.viewBox} role="img" aria-label={title} className={cn("h-6 w-auto shrink-0", className)}>
      <path fill={fillOf(tone)} fillRule="evenodd" d={DESKZO_WORDMARK.path} />
    </svg>
  );
}

/** The D on its own, no tile. */
export function DeskzoMark({ className, tone = "auto", title = "Deskzo" }: { className?: string; tone?: Tone; title?: string }) {
  return (
    <svg viewBox={DESKZO_MARK.viewBox} role="img" aria-label={title} className={cn("h-6 w-auto shrink-0", className)}>
      <path fill={fillOf(tone)} fillRule="evenodd" d={DESKZO_MARK.path} />
    </svg>
  );
}

/** The app icon: the D in Deskzo blue on a white tile with 22% corners, as the icon file draws it. */
export function DeskzoIcon({ className, title = "Deskzo" }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 1341 1341" role="img" aria-label={title} className={cn("h-8 w-8 shrink-0", className)}>
      <rect width="1341" height="1341" rx="295" fill="#FFFFFF" />
      <g transform="translate(376 330) scale(0.5) translate(-24 -22)">
        <path fill={DESKZO_BLUE} fillRule="evenodd" d={DESKZO_MARK.path} />
      </g>
    </svg>
  );
}
