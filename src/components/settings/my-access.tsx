"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Crown, Search, ShieldOff } from "lucide-react";
import type { effectivePermissionsFor } from "@/actions/permission";
import type { userPermissionOverrides } from "@/actions/access";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PERMISSION_GROUP_ORDER } from "@/lib/permissions";
import { formatDate } from "@/lib/utils";

type Resolved = NonNullable<Awaited<ReturnType<typeof effectivePermissionsFor>>>;
type Exception = Awaited<ReturnType<typeof userPermissionOverrides>>[number];

/**
 * Your own access, in your own words.
 *
 * Everything here is what the administrator's drawer already showed about you — the same resolver,
 * the same `why` strings — shown to the one person who could not see it.
 */

const TIER_TONE: Record<string, "red" | "amber" | "default"> = {
  critical: "red",
  sensitive: "amber",
  standard: "default",
};

export function MyAccess({ resolved, exceptions }: { resolved: Resolved; exceptions: Exception[] }) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const held = resolved.permissions.filter((p) => p.held);
  const trimmed = query.trim().toLowerCase();

  const shown = useMemo(() => {
    const base = showAll ? resolved.permissions : held;
    return trimmed ? base.filter((p) => p.label.toLowerCase().includes(trimmed) || p.key.includes(trimmed)) : base;
  }, [resolved.permissions, held, showAll, trimmed]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof shown>();
    for (const row of shown) {
      const list = map.get(row.group) ?? [];
      list.push(row);
      map.set(row.group, list);
    }
    return PERMISSION_GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, rows: map.get(g)! }));
  }, [shown]);

  return (
    <div className="animate-fade-rise space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">What I can do</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Everything this account is allowed to do, and where each one comes from. If something you need is missing,
          this is the page to quote when you ask for it.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">You hold</div>
          <div className="mt-1 text-lg font-semibold text-text">
            {resolved.user.isSuperAdmin ? "Everything" : `${held.length} of ${resolved.permissions.length}`}
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Your role</div>
          <div className="mt-1 flex items-center gap-2 text-lg font-semibold text-text">
            {resolved.user.role}
            {resolved.user.isSuperAdmin && (
              <Badge tone="amber">
                <Crown className="h-3 w-3" />
                Super admin
              </Badge>
            )}
          </div>
        </Card>
      </div>

      {exceptions.length > 0 && (
        <Card>
          <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
            <CalendarClock className="h-4 w-4 text-muted" />
            Given to you personally
          </CardHeader>
          <CardContent className="divide-y divide-line">
            {exceptions.map((e) => (
              <div key={e.permission} className="flex flex-wrap items-start justify-between gap-2 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {e.allowed ? (
                      <Badge tone="green">Granted</Badge>
                    ) : (
                      <Badge tone="red">
                        <ShieldOff className="h-3 w-3" />
                        Withheld
                      </Badge>
                    )}
                    <span className="text-sm text-text">{e.permission}</span>
                  </div>
                  {e.reason && <p className="mt-0.5 text-xs text-muted">{e.reason}</p>}
                </div>
                {e.expiresAt && (
                  <span className="shrink-0 text-xs text-warning">
                    {/* The line somebody needs before the cover ends, rather than after. */}
                    ends {formatDate(e.expiresAt)}
                  </span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search what you can do…"
            className="pl-8"
            aria-label="Search your permissions"
          />
        </div>
        <button
          type="button"
          className="text-sm font-medium text-brand hover:underline"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? "Only what I hold" : "Show everything, including what I don't have"}
        </button>
      </div>

      {grouped.map(({ group, rows }) => (
        <Card key={group}>
          <CardHeader className="text-sm font-medium text-text">{group}</CardHeader>
          <CardContent className="divide-y divide-line">
            {rows.map((p) => (
              <div key={p.key} className="py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={p.held ? "text-sm font-medium text-text" : "text-sm text-subtle line-through"}>
                    {p.label}
                  </span>
                  {p.tier !== "standard" && <Badge tone={TIER_TONE[p.tier] ?? "default"}>{p.tier}</Badge>}
                </div>
                {/* Straight from `describeSource` — the same sentence an administrator reads. */}
                <p className="mt-0.5 text-xs text-muted">{p.why}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      {shown.length === 0 && (
        <Card className="px-6 py-10 text-center text-sm text-muted">Nothing matches that search.</Card>
      )}
    </div>
  );
}
