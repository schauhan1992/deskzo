import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { plural } from "@/lib/console-shared/format";
import { cn } from "@/lib/utils";

const STEP = "inline-flex h-8 items-center gap-1 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium shadow-sm";

/**
 * Previous / Next as links for the partner lists (the loaders read fifty a page). The page builds
 * each page's address (`hrefFor`), so a list whose paging key is prefixed — the 360's activity uses
 * `apage` beside the commissions tab's `page` — pages without touching the other. Server-safe.
 */
export function LinkPager({
  page,
  pageSize,
  total,
  noun,
  nouns,
  hrefFor,
}: {
  page: number;
  pageSize: number;
  total: number;
  noun: string;
  nouns?: string;
  hrefFor: (page: number) => string;
}) {
  if (total === 0) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted tabular-nums">{pages > 1 ? `${first}–${last} of ${plural(total, noun, nouns)}` : plural(total, noun, nouns)}</span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} scroll={false} className={cn(STEP, "text-text hover:bg-surface-sunken")}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Previous
            </Link>
          ) : (
            <span aria-disabled="true" className={cn(STEP, "text-subtle opacity-60")}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Previous
            </span>
          )}
          <span className="text-muted tabular-nums">{`Page ${page} of ${pages}`}</span>
          {page < pages ? (
            <Link href={hrefFor(page + 1)} scroll={false} className={cn(STEP, "text-text hover:bg-surface-sunken")}>
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
