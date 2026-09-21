/**
 * Page-size choices for list screens. Lives here rather than beside the query action because a
 * `"use server"` module can only export async functions — a plain constant there fails the build.
 */
export const PAGE_SIZES = [25, 50, 100, 200] as const;

export const DEFAULT_PAGE_SIZE = 50;

export function resolvePageSize(value?: string) {
  const size = Number(value);
  return PAGE_SIZES.includes(size as (typeof PAGE_SIZES)[number]) ? size : DEFAULT_PAGE_SIZE;
}

export function resolvePage(value?: string) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

/** What every paginated list query returns: the page's rows plus the unpaginated total. */
export type Paged<T> = { rows: T[]; total: number };

/** Prisma's `skip`/`take` for a resolved page, so no list query has to do the arithmetic itself. */
export function pageSlice(page: number, pageSize: number) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

export function totalPages(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Slices an already-fetched array. Used where the rows can't be paginated in SQL — a list whose
 * ordering or filtering is computed in JS after the query (renewal status, payment balances) has to
 * see every row before it can pick a page.
 */
export function pageOf<T>(rows: T[], page: number, pageSize: number): Paged<T> {
  const start = (page - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), total: rows.length };
}
