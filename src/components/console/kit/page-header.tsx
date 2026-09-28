import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatIstTime } from "@/lib/india-time";
import { PageNotice } from "./notice";
import { AutoRefresh, RefreshButton } from "./refresh";

export type Crumb = { label: string; href?: string };

/**
 * The top of every console page: breadcrumbs or an eyebrow, the title with its status chips, the
 * page's actions, one factual subtitle line with how fresh the figures are, and the page's outcome
 * region (`PageNotice`) — so "Workspace reopened." always appears in the same place.
 *
 * `asOf` is the loaders' clock, printed rather than implied: a board read at 10:02 says so, and the
 * refresh button next to it is how you get 10:05.
 */
export function PageHeader({
  title,
  eyebrow,
  crumbs,
  chips,
  subtitle,
  actions,
  asOf,
  autoRefreshSeconds,
  live,
  notice,
}: {
  title: string;
  eyebrow?: string;
  crumbs?: Crumb[];
  chips?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  asOf?: Date | null;
  autoRefreshSeconds?: number;
  live?: boolean;
  notice?: boolean;
}) {
  const hasMeta = Boolean(subtitle || asOf || autoRefreshSeconds);
  return (
    <header className="mb-6">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-2">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted">
            {crumbs.map((crumb, i) => {
              const current = i === crumbs.length - 1;
              return (
                <li key={`${i}-${crumb.label}`} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 text-subtle" />}
                  {crumb.href && !current ? (
                    <Link href={crumb.href} className="truncate rounded-base hover:text-text">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current={current ? "page" : undefined} className={current ? "truncate text-text" : "truncate"}>
                      {crumb.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      {eyebrow && <p className="mb-1 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">{eyebrow}</p>}

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight break-words text-text">{title}</h1>
            {chips && <div className="flex flex-wrap items-center gap-1.5">{chips}</div>}
          </div>
          {hasMeta && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              {subtitle && <div className="min-w-0">{subtitle}</div>}
              {asOf && (
                <span className="inline-flex items-center gap-0.5 text-xs text-subtle">
                  {`Updated ${formatIstTime(asOf)} IST`}
                  <RefreshButton />
                </span>
              )}
              {autoRefreshSeconds ? <AutoRefresh seconds={autoRefreshSeconds} live={live} /> : null}
            </div>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>

      {notice !== false && <PageNotice />}
    </header>
  );
}
