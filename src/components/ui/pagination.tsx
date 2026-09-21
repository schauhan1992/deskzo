"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";

/**
 * Page controls driven by `page` and `pageSize` search params, so the current page survives a
 * reload or a shared link. Changing the page size returns to page 1 — staying on page 7 of a list
 * that just got four times shorter is never what someone means.
 */
export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  pageSizes,
  pageParam = "page",
  pageSizeParam = "pageSize",
  label,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  pageSizes: readonly number[];
  /** Overridden when a screen paginates two lists at once, so they don't share one page number. */
  pageParam?: string;
  pageSizeParam?: string;
  label?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function go(next: Record<string, string>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2 text-muted">
        <span>
          {total === 0 ? "No results" : `${first}–${last} of ${total}`}
          {label ? ` ${label}` : ""}
        </span>
        <Select
          value={String(pageSize)}
          onChange={(e) => go({ [pageSizeParam]: e.target.value, [pageParam]: "" })}
          className="h-8 w-28"
          aria-label="Items per page"
        >
          {pageSizes.map((size) => (
            <option key={size} value={size}>
              {size} / page
            </option>
          ))}
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => go({ [pageParam]: String(page - 1) })}
        >
          Previous
        </Button>
        <span className="text-muted">
          Page {page} of {totalPages}
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => go({ [pageParam]: String(page + 1) })}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
