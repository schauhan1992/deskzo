import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A row action reduced to its icon.
 *
 * Text actions repeated down every row of a table — Payments, Edit, Delete on each of forty lines —
 * are a wall of blue words that makes the data harder to read than the actions are to find. Icons
 * give the column back to the record.
 *
 * The cost is that an icon is not self-explanatory, so this component makes the label impossible to
 * omit rather than optional:
 *
 *   - `label` is required and becomes both `aria-label` and the hover tooltip. Without it an
 *     icon-only button is simply invisible to a screen reader, which is the usual way this change
 *     quietly breaks accessibility.
 *   - The hit area stays 28px square regardless of the icon inside it, so the target does not
 *     shrink with the glyph — a 14px icon with a 14px hit area is unusable on a laptop trackpad
 *     and worse on a touchscreen.
 *
 * `tone="danger"` is for the irreversible ones. It is the only colour in the set, which is what
 * makes it read as a warning rather than as decoration.
 */

type Tone = "default" | "danger";

const toneClasses: Record<Tone, string> = {
  default: "text-subtle hover:bg-surface-sunken hover:text-brand",
  danger: "text-subtle hover:bg-danger-bg hover:text-danger",
};

export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
    icon: LucideIcon;
    label: string;
    tone?: Tone;
  }
>(({ icon: Icon, label, tone = "default", className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    title={label}
    aria-label={label}
    className={cn(
      "inline-grid h-7 w-7 shrink-0 place-items-center rounded-base",
      "transition-colors duration-150 active:scale-95",
      "disabled:pointer-events-none disabled:opacity-40",
      toneClasses[tone],
      className,
    )}
    {...props}
  >
    <Icon className="h-4 w-4" />
  </button>
));
IconButton.displayName = "IconButton";

/**
 * The container for a row's actions.
 *
 * Exists so every table lays them out identically — right-aligned, tight, and not wrapping. A
 * column of actions that shifts by two pixels between tables is the kind of thing nobody reports
 * and everybody notices.
 */
export function RowActions({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex items-center justify-end gap-0.5", className)}>{children}</div>;
}
