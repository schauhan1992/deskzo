"use client";

import { useMemo, useState } from "react";
import { Crown, Search } from "lucide-react";
import type { accessRoster } from "@/actions/permission";
import { UserAccessDrawer } from "@/components/settings/user-access-drawer";
import { Badge, Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";

type Row = Awaited<ReturnType<typeof accessRoster>>[number];

/**
 * Who is here, and how much they can do.
 *
 * The old list gave a name, a role badge and a button. "Holds 47 of 74" is the line that makes an
 * access review start in the right place: it is the difference between a sales executive and
 * somebody who has quietly accumulated a manager's reach, and it was previously only discoverable
 * by opening every drawer in turn.
 */
export function AccessRoster({
  rows,
  mayManage,
}: {
  rows: Row[];
  mayManage: boolean;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const [filter, setFilter] = useState<"all" | "exceptions" | "deactivated">("all");

  const roles = useMemo(() => [...new Set(rows.map((r) => r.role))].sort(), [rows]);

  const shown = rows.filter((r) => {
    const q = query.trim().toLowerCase();
    if (q && !`${r.name} ${r.email}`.toLowerCase().includes(q)) return false;
    if (role && r.role !== role) return false;
    if (filter === "exceptions" && r.exceptions === 0) return false;
    // Deactivated people are hidden by default rather than dropped: an access review has to be able
    // to find the account somebody left behind.
    if (filter !== "deactivated" && !r.active) return false;
    if (filter === "deactivated" && r.active) return false;
    return true;
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or email…"
            className="pl-8"
            aria-label="Search people"
          />
        </div>
        <Select value={role} onChange={(e) => setRole(e.target.value)} className="w-40" aria-label="Filter by role">
          <option value="">All roles</option>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
        <Select
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
          className="w-52"
          aria-label="Filter the roster"
        >
          <option value="all">Everyone active</option>
          <option value="exceptions">Only people with exceptions</option>
          <option value="deactivated">Deactivated accounts</option>
        </Select>
        <span className="ml-auto text-sm text-subtle">
          {shown.length} of {rows.length}
        </span>
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Person</th>
              <th className="px-4 py-2.5">Role</th>
              <th className="px-4 py-2.5">Department</th>
              <th className="px-4 py-2.5">Reports to</th>
              <th className="px-4 py-2.5">Holds</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-text">{r.name}</span>
                    {r.isSuperAdmin && (
                      <Badge tone="amber">
                        <Crown className="h-3 w-3" />
                        Super admin
                      </Badge>
                    )}
                    {!r.active && <Badge tone="red">Deactivated</Badge>}
                    {/* No password chosen yet: they can't sign in until they use their setup email. */}
                    {r.setupPending && <Badge tone="blue">Invitation pending</Badge>}
                  </div>
                  <span className="text-xs text-subtle">{r.email}</span>
                </td>
                <td className="px-4 py-2.5">
                  <Badge>{r.role}</Badge>
                </td>
                <td className="px-4 py-2.5 text-muted">{r.department ?? <span className="text-subtle">—</span>}</td>
                <td className="px-4 py-2.5 text-muted">
                  {/*
                    On the roster because it is an access fact, not an HR one: a manager holds
                    everything their reports hold.
                  */}
                  {r.managerName ?? <span className="text-subtle">nobody</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <span className="tabular-nums text-text">
                    {r.isSuperAdmin ? "everything" : `${r.holds} of ${r.total}`}
                  </span>
                  {r.exceptions > 0 && (
                    <Badge tone={r.lapsingSoon ? "amber" : "default"} className="ml-2">
                      {r.exceptions} exception{r.exceptions === 1 ? "" : "s"}
                      {r.lapsingSoon ? " · ending soon" : ""}
                    </Badge>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  <UserAccessDrawer userId={r.id} userName={r.name} mayManage={mayManage} />
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted">
                  Nobody matches those filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
