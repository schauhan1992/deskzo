import { useCallback, useEffect, useRef, useState } from "react";
import { apiPage, type Page } from "@/lib/api";

/**
 * A list from Deskzo, a page at a time (owner, 22 Oct 2026 — the app made native): the first page when the path
 * changes, the next as the person scrolls, all of it again on a pull. Online only — nothing is kept on the phone;
 * a list that couldn't load says why.
 *
 * `path` is the list's address with its filters (`/api/app/leads?view=mine&search=acme`); null loads nothing yet.
 */
export function useList<T extends { id: string }>(path: string | null) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The path a page was asked for: an answer for a path the person has since left is dropped.
  const current = useRef(path);

  const at = (p: string, n: number) => `${p}${p.includes("?") ? "&" : "?"}page=${n}`;

  const reload = useCallback(async () => {
    current.current = path;
    if (!path) return;
    setLoading(true);
    setProblem(null);
    try {
      const got = await apiPage<T>(at(path, 1));
      if (current.current !== path) return;
      setRows(got.data);
      setPage(got.page);
    } catch (e) {
      if (current.current !== path) return;
      setProblem(e instanceof Error ? e.message : "Couldn't load this list.");
    } finally {
      if (current.current === path) setLoading(false);
    }
  }, [path]);

  const loadMore = useCallback(async () => {
    if (!path || !page?.has_more || more || loading) return;
    setMore(true);
    try {
      const got = await apiPage<T>(at(path, page.page + 1));
      if (current.current !== path) return;
      // A row that moved up a page while scrolling isn't listed twice.
      setRows((now) => {
        const seen = new Set((now ?? []).map((r) => r.id));
        return [...(now ?? []), ...got.data.filter((r) => !seen.has(r.id))];
      });
      setPage(got.page);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't load more.");
    } finally {
      setMore(false);
    }
  }, [path, page, more, loading]);

  useEffect(() => {
    setRows(null);
    setPage(null);
    void reload();
  }, [reload]);

  return { rows, total: page?.total ?? null, loading, more, problem, reload, loadMore };
}

/** What the person typed, once they've paused — so a search isn't sent for every letter. */
export function useSettled(value: string, wait = 350): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), wait);
    return () => clearTimeout(t);
  }, [value, wait]);
  return settled;
}
