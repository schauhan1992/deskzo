import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { plural } from "@/lib/console-shared/format";
import { cn } from "@/lib/utils";

const STEP = "inline-flex h-8 items-center gap-1 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium shadow-sm";

/**
 * Previous / Next for the portal's offset lists (customers, deal registrations — fifty a page, set by
 * the loaders), in the console kit's `CursorPager` style: links the page built, so a page has an
 * address and survives a reload. A missing direction is shown switched off rather than left out, so
 * the pair never jumps sideways. Nothing at all for an empty list — its empty state says enough.
 *
 * Server-safe: no hooks, no directive.
 */
export function PagePager({
  page,
  pageSize,
  total,
  noun,
  nouns,
  previousHref,
  nextHref,
}: {
  page: number;
  pageSize: number;
  total: number;
  noun: string;
  nouns?: string;
  previousHref: string | null;
  nextHref: string | null;
}) {
  if (total <= 0) return null;
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const first = Math.min(total, (page - 1) * pageSize + 1);
  const last = Math.min(total, page * pageSize);
  const count = plural(total, noun, nouns);
  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted tabular-nums">{pages > 1 ? `${first.toLocaleString("en-IN")}–${last.toLocaleString("en-IN")} of ${count} · page ${page} of ${pages}` : count}</span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          {previousHref ? (
            <Link href={previousHref} className={cn(STEP, "text-text hover:bg-surface-sunken")}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Previous
            </Link>
          ) : (
            <span aria-disabled="true" className={cn(STEP, "text-subtle opacity-60")}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Previous
            </span>
          )}
          {nextHref ? (
            <Link href={nextHref} className={cn(STEP, "text-text hover:bg-surface-sunken")}>
              Next
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          ) : (
            <span aria-disabled="true" className={cn(STEP, "text-subtle opacity-60")}>
              Next
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </span>
          )}
        </div>
      )}
    </nav>
  );
}
