import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** A field's error under it, with the id its field's `aria-describedby` names (see `invalidProps`). */
export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={`${id}-error`} className="text-xs text-danger">
      {message}
    </p>
  );
}

/** One section of the form: a card with its title, and the fields one to a row on a phone, two from small screens up. */
export function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium text-text">{title}</h2>
      </CardHeader>
      <CardContent className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2", className)}>{children}</CardContent>
    </Card>
  );
}

/**
 * A folded section: a native `<details>`, so what is inside stays in the page's markup while it is
 * closed — the check suites read the form's static HTML — and it opens without any script. The line
 * beside the title says what it holds, so a closed section still shows that something is in it.
 *
 * Open or shut is the form's to say (`open`): it opens a section from outside when a submit finds an
 * error inside, before the field there is focused, and a field in a closed `<details>` can't be.
 *
 * The body is a size container, and the rows inside lay out by its width (`@sm:`, `@lg:`) rather than
 * the screen's: from `lg` up the folds sit in the narrower column beside the summary, so a wide screen
 * can give them less room than a tablet does, and a row keyed to the screen overflows the card.
 */
export function Fold({
  title,
  summary,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  summary?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details className="group" open={open} onToggle={(e) => onOpenChange(e.currentTarget.open)}>
      <summary
        className={cn(
          "flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-5 py-3.5 hover:bg-surface-sunken/60",
          "[&::-webkit-details-marker]:hidden",
          // The ring is drawn inside: these sit edge to edge in a card that clips to its rounded corners.
          "focus-visible:outline-offset-[-2px]",
        )}
      >
        <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle transition-transform duration-150 group-open:rotate-90" />
        <span className="text-sm font-medium text-text">{title}</span>
        {summary && <span className="min-w-0 text-xs text-muted">· {summary}</span>}
      </summary>
      <div className="@container space-y-5 border-t border-line px-5 py-4">{children}</div>
    </details>
  );
}

/** A label and its figure on one line of the order summary. */
export function SummaryRow({ label, value, className }: { label: ReactNode; value: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 text-muted", className)}>
      <span>{label}</span>
      <span className="text-right text-text tabular-nums">{value}</span>
    </div>
  );
}
