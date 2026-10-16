"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import type { AccessLevel } from "@prisma/client";
import { ArrowRight, Info } from "lucide-react";
import { effectiveAccessOf } from "@/actions/person-access";
import type { AccessAction, AccessRecord } from "@/lib/authz/access";
import { ACCESS_MODULES, actionRowsOf } from "@/lib/staff/access-modules";
import { explainModule, moduleStandingOf, rowAllowed, type AccessFacts } from "@/lib/staff/access-explain";
import { LEVEL_WORDS } from "@/lib/authz/level-order";
import { Badge, Card } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { ModuleIcon } from "@/components/settings/access/module-icon";
import { cn } from "@/lib/utils";

export type FactsData = { holds: string[]; levels: Record<string, AccessLevel> };

const STANDING_BADGE = {
  full: { tone: "green", text: "Full access" },
  limited: { tone: "amber", text: "Limited" },
  none: { tone: "red", text: "No access" },
} as const;

/**
 * Permission preview — beside a role's modules: what the role reaches, module by module, or what one of
 * its people does once their own exceptions are counted; each permission the open module holds; and
 * the access explained in a sentence. The role's own answers come from the editor beside it, so the
 * preview follows every change as it is made.
 */
export function PermissionPreview({
  records,
  roleFacts,
  people,
  active,
  onSelect,
  roleSummaryHref,
}: {
  records: { key: AccessRecord; label: string; actions: AccessAction[] }[];
  roleFacts: FactsData;
  people: { id: string; name: string; roleName: string }[];
  active: string;
  onSelect: (moduleKey: string) => void;
  roleSummaryHref: string;
}) {
  const [userId, setUserId] = useState("");
  const [userFacts, setUserFacts] = useState<FactsData | null>(null);
  const [tab, setTab] = useState<"modules" | "permissions">("modules");
  const [loading, start] = useTransition();

  useEffect(() => {
    if (!userId) return;
    let live = true;
    start(async () => {
      const data = await effectiveAccessOf({ userId });
      if (live) setUserFacts(data);
    });
    return () => {
      live = false;
    };
  }, [userId]);

  const data = userId && userFacts ? userFacts : roleFacts;
  const facts: AccessFacts = useMemo(() => {
    const held = new Set(data.holds);
    return { holds: (k) => held.has(k), level: (r, a) => data.levels[`${r}:${a}`] ?? "NONE" };
  }, [data]);
  const explained = explainModule(active, records, facts);
  const rows = actionRowsOf(active, records);

  return (
    <Card className="min-w-0 self-start">
      <div className="space-y-3 border-b border-line px-4 pb-3 pt-4">
        <div>
          <h3 className="text-sm font-semibold text-text">Permission preview</h3>
          <p className="mt-0.5 text-xs text-muted">See what this role can access</p>
        </div>
        <div className="space-y-1">
          <label htmlFor="preview-user" className="text-xs text-muted">
            Select a user (optional)
          </label>
          <Select id="preview-user" value={userId} onChange={(e) => setUserId(e.target.value)} className="h-9 w-full text-sm">
            <option value="">The role itself</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.roleName})
              </option>
            ))}
          </Select>
        </div>
        <div role="tablist" className="flex gap-3 whitespace-nowrap border-b border-line text-[13px]">
          {(
            [
              ["modules", "Module view"],
              ["permissions", "Effective permissions"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn("-mb-px border-b-2 pb-2 transition-colors", tab === key ? "border-brand font-medium text-brand" : "border-transparent text-muted hover:text-text")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={cn("px-2 py-2", loading && "opacity-60")}>
        {tab === "modules" ? (
          <ul className="space-y-0.5">
            {ACCESS_MODULES.map((m) => {
              const standing = STANDING_BADGE[moduleStandingOf(m.key, facts)];
              return (
                <li key={m.key}>
                  <button
                    type="button"
                    onClick={() => onSelect(m.key)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-base px-2.5 py-2 text-left text-sm transition-colors",
                      active === m.key ? "bg-brand/10 text-text" : "text-text hover:bg-surface-sunken",
                    )}
                  >
                    <ModuleIcon icon={m.icon} className={cn("h-4 w-4 shrink-0", active === m.key ? "text-brand" : "text-muted")} />
                    <span className="min-w-0 flex-1 truncate">{m.label}</span>
                    <Badge tone={standing.tone}>{standing.text}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="space-y-1 px-2 py-1 text-sm">
            {rows.length === 0 && <li className="py-3 text-subtle">Nothing to grant in this module.</li>}
            {rows.map((row) => {
              const allowed = rowAllowed(row, facts);
              return (
                <li key={row.id} className="flex items-center justify-between gap-2 border-b border-line py-1.5 last:border-0">
                  <span className={cn("min-w-0 truncate", allowed ? "text-text" : "text-subtle line-through decoration-line-strong")}>{row.label}</span>
                  <span className="shrink-0 text-xs text-muted">{allowed ? (row.kind === "record" ? LEVEL_WORDS[facts.level(row.record, row.action)] : "Allowed") : "—"}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="m-3 mt-1 rounded-base border border-info/20 bg-info-bg p-3">
        <p className="flex items-center gap-1.5 text-sm font-medium text-text">
          <Info className="h-4 w-4 shrink-0 text-info" aria-hidden />
          Access explanation
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{explained.sentence}</p>
        <Link
          href={userId ? `/settings/users?user=${encodeURIComponent(userId)}&tab=permissions` : roleSummaryHref}
          className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline"
        >
          View detailed explanation
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </Card>
  );
}
