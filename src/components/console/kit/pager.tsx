import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const STEP = "inline-flex h-8 items-center gap-1 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium shadow-sm";

/**
 * Newer / Older for keyset lists (the audit log), where there is no "page 7 of 40" to show: the
 * loader hands back the cursors, the page builds the links. A missing direction is shown disabled
 * rather than left out, so the pair never jumps sideways between pages.
 */
export function CursorPager({ newerHref, olderHref, summary }: { newerHref: string | null; olderHref: string | null; summary?: string }) {
  if (!newerHref && !olderHref && !summary) return null;
  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted">{summary}</span>
      {(newerHref || olderHref) && (
        <div className="flex items-center gap-2">
          {newerHref ? (
            <Link href={newerHref} className={cn(STEP, "text-text hover:bg-surface-sunken")}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Newer
            </Link>
          ) : (
            <span aria-disabled="true" className={cn(STEP, "text-subtle opacity-60")}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Newer
            </span>
          )}
          {olderHref ? (
            <Link href={olderHref} className={cn(STEP, "text-text hover:bg-surface-sunken")}>
              Older
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          ) : (
            <span aria-disabled="true" className={cn(STEP, "text-subtle opacity-60")}>
              Older
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </span>
          )}
        </div>
      )}
    </nav>
  );
}
