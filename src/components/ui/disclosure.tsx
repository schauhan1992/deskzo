import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * A line of explanation that folds away.
 *
 * For the standing caveat a page needs to state once — how something is stored, what a figure
 * counts — rather than for content. Left open, three lines of small grey text sit above every list
 * forever, pushing the thing people came for below the fold on a laptop; deleted, the caveat goes
 * with it. Folded, it is one line that anybody can open and nobody has to re-read.
 *
 * A native `<details>`: it works before hydration, it is searchable by the browser's own find, and
 * screen readers already know what it is.
 */
export function Disclosure({
  summary,
  children,
  className,
}: {
  summary: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`group mt-1 ${className ?? ""}`}>
      <summary className="flex cursor-pointer list-none items-center gap-1 text-sm text-muted marker:hidden hover:text-text">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        {summary}
      </summary>
      <p className="mt-1.5 max-w-3xl pl-[1.125rem] text-sm text-subtle">{children}</p>
    </details>
  );
}
