"use client";

import { useSearchParams } from "next/navigation";
import { Pager } from "./pager";

/**
 * The pager for a tab drawn inside another page (a partner's Commissions tab): the page that holds
 * it owns the address, so the links are built from the address as it is, with the tab pinned.
 */
export function LivePager({ path, tab, page, pageSize, total, noun, nouns }: { path: string; tab: string; page: number; pageSize: number; total: number; noun: string; nouns?: string }) {
  const searchParams = useSearchParams();
  const params: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) if (value && key !== "page") params[key] = value;
  params.tab = tab;
  return <Pager page={page} pageSize={pageSize} total={total} noun={noun} nouns={nouns} path={path} params={params} />;
}
