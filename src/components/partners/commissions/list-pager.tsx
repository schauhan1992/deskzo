import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { plural } from "@/lib/console-shared/format";
import { withParams, type RawParams } from "@/lib/console-shared/params";
import { cn } from "@/lib/utils";

const STEP = "inline-flex h-8 items-center gap-1 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium shadow-sm";

/**
 * Previous / Next for a fixed-size list (the commissions list, 100 a page), as links that keep the
 * page's filters — "1–100 of 342 entries · page 1 of 4". A missing direction is shown switched off
 * rather than left out, so the pair never jumps sideways. Server-safe.
 */
export function ListPager({ path, params, page, pageSize, total, noun, nounPlural }: { path: string; params: RawParams; page: number; pageSize: number; total: number; noun: string; nounPlural?: string }) {
  if (total === 0) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const href = (n: number) => withParams(path, params, { page: n > 1 ? n : null });
  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted tabular-nums">
        {pages > 1 ? `${first.toLocaleString("en-IN")}–${last.toLocaleString("en-IN")} of ${plural(total, noun, nounPlural)} · page ${page} of ${pages}` : plural(total, noun, nounPlural)}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={href(page - 1)} className={cn(STEP, "text-text hover:bg-surface-sunken")}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Previous
            </Link>
          ) : (
            <span aria-disabled="true" className={cn(STEP, "text-subtle opacity-60")}>
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Previous
            </span>
          )}
          {page < pages ? (
            <Link href={href(page + 1)} className={cn(STEP, "text-text hover:bg-surface-sunken")}>
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
