"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Building2,
  CalendarDays,
  CheckSquare,
  Eye,
  FileText,
  FolderKanban,
  Globe,
  History,
  LifeBuoy,
  LogIn,
  Mail,
  MapPin,
  MessageSquare,
  Package,
  Phone,
  Receipt,
  ShoppingCart,
  StickyNote,
  TrendingUp,
  UserRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { companyActivity, leadActivity, peopleActivity, type ActivityQuery } from "@/actions/activity-feed";
import { ACTIVITY_GROUPS, type ActivityGroupKey, type ActivityItem, type ActivityPage } from "@/lib/activity/types";
import { Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Source = { kind: "company" | "lead" | "person"; id: string };

const ACTION_WORD: Record<string, string> = { CREATE: "Added", UPDATE: "Changed", DELETE: "Removed" };

const GROUP_ICON: Record<ActivityGroupKey, LucideIcon> = {
  company: Building2,
  contacts: UserRound,
  leads: TrendingUp,
  notes: StickyNote,
  calls: Phone,
  emails: Mail,
  orders: Package,
  documents: FileText,
  payments: Wallet,
  purchase: ShoppingCart,
  tickets: LifeBuoy,
  tasks: CheckSquare,
  meetings: CalendarDays,
  visits: MapPin,
  projects: FolderKanban,
  expenses: Receipt,
  feedback: MessageSquare,
  portal: Globe,
  signins: LogIn,
  other: History,
};

/**
 * An Activity feed (owner, 19 Oct 2026 — src/lib/activity/timeline.ts): what happened, who did it, and
 * when, newest first, as a timeline — filtered by kind, person and dates, an older page at a time.
 */
export function ActivityFeed({
  source,
  initial,
  groups,
  people,
  zone,
}: {
  source: Source;
  initial: ActivityPage;
  /** The kinds this viewer sees, for the filter. */
  groups: ActivityGroupKey[];
  /** For a record's feed: whose activity to show. */
  people?: { id: string; name: string }[];
  /** The workspace's time zone, for the times. */
  zone: string;
}) {
  const [items, setItems] = useState<ActivityItem[]>(initial.items);
  const [before, setBefore] = useState<string | null>(initial.before);
  const [more, setMore] = useState(initial.more);
  const [filters, setFilters] = useState<ActivityQuery>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = (query: ActivityQuery, append: boolean) => {
    setError(null);
    startTransition(async () => {
      const result =
        source.kind === "company" ? await companyActivity(source.id, query) : source.kind === "lead" ? await leadActivity(source.id, query) : await peopleActivity(source.id, query);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setItems((prev) => (append ? [...prev, ...result.data.items] : result.data.items));
      setBefore(result.data.before);
      setMore(result.data.more);
    });
  };

  const change = (next: ActivityQuery) => {
    const merged = { ...filters, ...next };
    setFilters(merged);
    load(merged, false);
  };

  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(iso));
  const groupLabel = (key: ActivityGroupKey) => ACTIVITY_GROUPS.find((g) => g.key === key)?.label ?? key;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Select aria-label="Kind" className="h-8 w-40 text-sm" value={filters.group ?? ""} disabled={pending} onChange={(e) => change({ group: e.target.value || null })}>
          <option value="">Everything</option>
          {ACTIVITY_GROUPS.filter((g) => groups.includes(g.key)).map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
            </option>
          ))}
        </Select>
        {people && people.length > 0 && (
          <Select aria-label="Who" className="h-8 w-40 text-sm" value={filters.personId ?? ""} disabled={pending} onChange={(e) => change({ personId: e.target.value || null })}>
            <option value="">Anybody</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        <label className="flex items-center gap-1 text-muted">
          From
          <input type="date" className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm text-text" value={filters.from ?? ""} disabled={pending} onChange={(e) => change({ from: e.target.value || null })} />
        </label>
        <label className="flex items-center gap-1 text-muted">
          to
          <input type="date" className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm text-text" value={filters.to ?? ""} disabled={pending} onChange={(e) => change({ to: e.target.value || null })} />
        </label>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {items.length === 0 ? (
        <p className="text-sm text-muted">{pending ? "Loading…" : "Nothing yet."}</p>
      ) : (
        <ol>
          {items.map((item, n) => {
            const Icon = GROUP_ICON[item.group] ?? History;
            return (
              <li key={item.id} className="relative flex gap-3 pb-5 last:pb-0">
                {/* The line joining one entry to the next. */}
                {n < items.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-4 top-9 w-px bg-line" />}
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-brand" title={groupLabel(item.group)}>
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1 pt-1 text-sm">
                  <p className="text-text">
                    {item.action && <span className="text-muted">{ACTION_WORD[item.action]} · </span>}
                    {item.title}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    by <span className="font-medium text-text">{item.who?.name ?? "Deskzo"}</span>
                    {item.asBy ? ` (${item.asBy}, viewing as them)` : ""} at {when(item.at)}
                  </p>
                  {item.detail && <p className="mt-1 whitespace-pre-line text-xs text-muted">{item.detail}</p>}
                  {item.changes.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {item.changes.map((c) => (
                        <li key={c.field} className="text-muted">
                          <span className="text-text">{c.label}</span>
                          {c.withheld ? (
                            " changed"
                          ) : (
                            <>
                              : {c.from || "—"} <span aria-hidden="true">→</span>
                              <span className="sr-only">changed to</span> {c.to || "—"}
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {item.href && (
                  <Link href={item.href} className="mt-1.5 shrink-0 text-brand hover:opacity-80" aria-label={`Open: ${item.title}`} title="Open">
                    <Eye className="size-4" aria-hidden="true" />
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {more && before && (
        <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => load({ ...filters, before }, true)}>
          {pending ? "Loading…" : "Show older"}
        </Button>
      )}
    </div>
  );
}
