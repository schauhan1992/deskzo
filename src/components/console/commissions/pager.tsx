import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { plural } from "@/lib/console-shared/format";
import { cn } from "@/lib/utils";
import { hrefWith } from "./format";

const STEP = "inline-flex h-8 items-center gap-1 rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium shadow-sm";

/**
 * Previous / Next for the commission lists, as links that keep the tab and its filters (the loaders
 * read fifty a page). Server-safe; `LivePager` wraps it for a tab that does not know its URL.
 */
export function Pager({
  page,
  pageSize,
  total,
  noun,
  nouns,
  path,
  params,
}: {
  page: number;
  pageSize: number;
  total: number;
  noun: string;
  /** The plural, when adding an s is wrong ("entries"). */
  nouns?: string;
  path: string;
  params: Record<string, string>;
}) {
  if (total === 0) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const href = (n: number) => hrefWith(path, params, { page: n > 1 ? n : null });
  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted tabular-nums">{pages > 1 ? `${first}–${last} of ${plural(total, noun, nouns)}` : plural(total, noun, nouns)}</span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={href(page - 1)} scroll={false} className={cn(STEP, "text-text hover:bg-surface-sunken")}>
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
            <Link href={href(page + 1)} scroll={false} className={cn(STEP, "text-text hover:bg-surface-sunken")}>
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
