import type { ReactNode } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { compactNumber } from "@/lib/console-shared/format";
import { cn } from "@/lib/utils";

/**
 * The server-rendered half of a list's filters (spec §1.9): the bar that lays controls out, view
 * presets, the chips that say what is filtered, and hub tabs. Every item is a plain link the page
 * built from its parsed params, so each state has a URL and survives a reload or a shared link.
 * The controls that type and pick live in filter-controls.tsx.
 */

type LinkItem = { key: string; label: string; href: string; active: boolean; count?: number | null };

export function FilterBar({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div role="group" aria-label="Filters" className="mb-4 flex flex-wrap items-center gap-2">
      {children}
      {trailing && <div className="ml-auto flex flex-wrap items-center gap-2">{trailing}</div>}
    </div>
  );
}

function Count({ count, active }: { count: number; active: boolean }) {
  return (
    <span className={cn("ml-1.5 rounded-full px-1.5 text-[11px] tabular-nums", active ? "bg-brand-subtle text-brand" : "bg-surface-sunken text-muted")}>
      {compactNumber(count)}
    </span>
  );
}

/** Segmented presets with counts ("All 142 · Needs attention 3 · Trials 12"). */
export function ViewTabs({ label, items }: { label: string; items: LinkItem[] }) {
  return (
    <nav aria-label={label} className="inline-flex max-w-full overflow-x-auto rounded-base border border-line bg-surface-sunken p-0.5">
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          scroll={false}
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "inline-flex h-8 shrink-0 items-center rounded-[6px] px-3 text-[13px] font-medium whitespace-nowrap",
            item.active ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
          )}
        >
          {item.label}
          {typeof item.count === "number" && <Count count={item.count} active={item.active} />}
        </Link>
      ))}
    </nav>
  );
}

/** What the list is filtered by, each removable on its own, plus a way back to everything. */
export function FilterChips({ chips, clearHref }: { chips: { key: string; label: string; removeHref: string }[]; clearHref?: string }) {
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Active filters" className="mb-4 flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <li key={chip.key} className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-surface-sunken pr-1 pl-2 text-xs text-muted">
          <span className="max-w-64 truncate">{chip.label}</span>
          <Link
            href={chip.removeHref}
            scroll={false}
            aria-label={`Remove ${chip.label} filter`}
            title={`Remove ${chip.label} filter`}
            className="grid h-4 w-4 place-items-center rounded-full text-subtle hover:bg-surface hover:text-text"
          >
            <X aria-hidden="true" className="h-3 w-3" />
          </Link>
        </li>
      ))}
      {clearHref && (
        <li>
          <Link href={clearHref} scroll={false} className="rounded-base px-1 text-xs font-medium text-brand hover:underline">
            Clear filters
          </Link>
        </li>
      )}
    </ul>
  );
}

/**
 * Underlined tabs for a hub whose panels are separate loads (Billing: Overview · Invoices · …): real
 * links, so only the active panel's data is fetched. For panels that are all on the page, use
 * `ConsoleTabs`.
 */
export function UrlTabs({ label, items }: { label: string; items: LinkItem[] }) {
  return (
    // The rule under the tabs is an inset shadow, not a border the active tab overlaps with a -1px
    // margin: inside a sideways-scrolling strip that margin becomes a one-pixel vertical scroll.
    <nav aria-label={label} className="flex max-w-full gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--line)]">
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "inline-flex shrink-0 items-center border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
            item.active ? "border-brand text-text" : "border-transparent text-muted hover:border-line-strong hover:text-text",
          )}
        >
          {item.label}
          {typeof item.count === "number" && <Count count={item.count} active={item.active} />}
        </Link>
      ))}
    </nav>
  );
}
