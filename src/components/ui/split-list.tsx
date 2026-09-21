import Link from "next/link";
import { SELECTED_PARAM } from "@/lib/view-mode";

/**
 * The split view's frame: a narrow list of records on the left, the open one on the right.
 *
 * It takes whatever height is left rather than subtracting a guess at what's above it: a list with
 * three rows of filters has far less room than one with a bare heading, and a fixed `100vh - Nrem`
 * would be wrong on most of them. `SplitListPage` makes the page a viewport-height column; this
 * grid is the part that flexes. `min-h-0` is what lets a flex or grid child scroll instead of
 * growing to fit its content.
 */
export function SplitListShell({
  countLabel,
  listPane,
  children,
  /** Widened for lists whose rows carry more than a name and a number. */
  listWidth = "340px",
}: {
  countLabel: string;
  listPane: React.ReactNode;
  children: React.ReactNode;
  listWidth?: string;
}) {
  return (
    <div
      className="mt-5 grid grid-cols-1 gap-0 overflow-hidden rounded-xl border border-line bg-surface lg:max-h-[calc(100vh-7.5rem)] lg:min-h-0 lg:flex-1 lg:grid-cols-[var(--split-list-width)_1fr]"
      style={{ ["--split-list-width" as string]: listWidth }}
    >
      <aside className="max-h-72 overflow-y-auto border-b border-line lg:max-h-none lg:min-h-0 lg:border-b-0 lg:border-r">
        <div className="sticky top-0 z-10 border-b border-line bg-surface-sunken px-4 py-2.5 text-xs uppercase tracking-wide text-subtle">
          {countLabel}
        </div>
        {listPane}
      </aside>
      <section className="p-5 lg:min-h-0 lg:overflow-y-auto">{children}</section>
    </div>
  );
}

/**
 * Wraps a list page whose split view should fill the window: the heading and filters keep their
 * natural height and `SplitListShell` takes the rest.
 *
 * `7.5rem` is the only fixed figure here, and it's the app shell rather than the page — the 56px
 * header plus `main`'s 32px of padding top and bottom.
 */
export function SplitListPage({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div className={active ? "flex flex-col lg:h-[calc(100vh-7.5rem)]" : undefined}>{children}</div>;
}

/** Shown in the detail pane when a list has nothing to open. */
export function SplitListEmpty({ message }: { message: string }) {
  return <p className="py-16 text-center text-sm text-subtle">{message}</p>;
}

/**
 * A row in the narrow pane. Deliberately not a table: at a third of the width there's no room to
 * line columns up, so each row leads with the two things people scan for and stacks the rest.
 */
export function SplitRow({
  href,
  active,
  title,
  trailing,
  subtitle,
  badges,
}: {
  href: string;
  active: boolean;
  title: React.ReactNode;
  /** The figure or date that belongs on the title's line, right-aligned. */
  trailing?: React.ReactNode;
  subtitle?: React.ReactNode;
  badges?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={`block px-4 py-3 transition-colors ${active ? "bg-brand-subtle" : "hover:bg-surface-sunken"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className={`truncate text-sm font-medium ${active ? "text-brand" : "text-text"}`}>{title}</span>
        {trailing && <span className="shrink-0 text-sm text-text">{trailing}</span>}
      </div>
      {subtitle && <div className="mt-0.5 truncate text-xs text-subtle">{subtitle}</div>}
      {badges && <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{badges}</div>}
    </Link>
  );
}

/**
 * The query a link inside an embedded detail has to carry: everything the list is currently showing,
 * plus which record is open. Without it, clicking a tab inside the detail pane would land back on an
 * unfiltered list with nothing selected.
 *
 * `tab` is dropped because whatever renders the tabs sets it itself.
 */
export function splitLinkParams(params: Record<string, string | undefined>, selected: string) {
  const rest = { ...params };
  delete rest.tab;
  return { ...rest, [SELECTED_PARAM]: selected };
}

/**
 * Which record the split view should open: the one asked for, as long as it's on this page of
 * results, otherwise the first. A stale link or a filter that has since excluded the record falls
 * back to something real rather than an empty pane beside a list that doesn't contain it.
 */
export function resolveSelected<T extends { id: string }>(rows: T[], requested: string | undefined) {
  if (requested && rows.some((r) => r.id === requested)) return requested;
  return rows[0]?.id ?? null;
}
