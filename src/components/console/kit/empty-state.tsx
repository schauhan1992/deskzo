import type { ReactNode } from "react";
import Link from "next/link";
import { Inbox, SearchX } from "lucide-react";

/**
 * What a list shows instead of an empty table. Two different situations get two different messages:
 * "nothing yet" (`empty`) and "nothing matches" (`filtered`), which offers the way back — telling
 * somebody who filtered a list to empty that there are no workspaces is how a filter gets reported as
 * data loss.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
  variant = "empty",
  clearHref,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  variant?: "empty" | "filtered";
  clearHref?: string;
}) {
  const showClear = variant === "filtered" && Boolean(clearHref);
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <span aria-hidden="true" className="mb-3 grid h-10 w-10 place-items-center rounded-full bg-surface-sunken text-subtle">
        {icon ?? (variant === "filtered" ? <SearchX className="h-5 w-5" /> : <Inbox className="h-5 w-5" />)}
      </span>
      <p className="text-sm font-medium text-text">{title}</p>
      {body && <p className="mt-1 max-w-sm text-xs text-muted">{body}</p>}
      {(action || showClear) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action}
          {showClear && clearHref && (
            <Link
              href={clearHref}
              className="inline-flex h-8 items-center rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium text-text shadow-sm hover:bg-surface-sunken"
            >
              Clear filters
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
