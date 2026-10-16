"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { userPath } from "@/lib/staff/staff-paths";
import { cn } from "@/lib/utils";

export type DirectoryRow = {
  id: string;
  name: string;
  roleName: string;
  role: string;
  departmentId: string | null;
  departmentName: string | null;
  active: boolean;
  setupPending: boolean;
  isSuperAdmin: boolean;
  photoUpdatedAt: string | null;
  /** Permissions granted or denied to them alone. */
  exceptions: number;
  lapsingSoon: boolean;
};

/**
 * The left of Users: everybody who can sign in, or could — All, Active, Inactive — searchable and
 * filtered by department and role, or narrowed to whoever has exceptions to their role (what the old
 * Exceptions tab listed). Choosing somebody opens them beside the list, on the tab already open.
 */
export function UsersDirectory({
  rows,
  selected,
  tab,
  departments,
  roles,
  mayAdd,
}: {
  rows: DirectoryRow[];
  selected: string | null;
  tab: string;
  departments: { id: string; name: string }[];
  roles: { key: string; name: string }[];
  mayAdd: boolean;
}) {
  const [status, setStatus] = useState<"all" | "active" | "inactive">("all");
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [role, setRole] = useState("");
  const [onlyExceptions, setOnlyExceptions] = useState(false);

  const counts = { all: rows.length, active: rows.filter((r) => r.active).length, inactive: rows.filter((r) => !r.active).length };
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (status === "all" || (status === "active" ? r.active : !r.active)) &&
        (!department || r.departmentId === department) &&
        (!role || r.role === role) &&
        (!onlyExceptions || r.exceptions > 0) &&
        (!q || r.name.toLowerCase().includes(q) || r.roleName.toLowerCase().includes(q) || (r.departmentName ?? "").toLowerCase().includes(q)),
    );
  }, [rows, status, department, role, search, onlyExceptions]);
  const withExceptions = rows.filter((r) => r.exceptions > 0).length;

  return (
    <Card className="flex flex-col">
      <div className="px-4 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-text">Users</h1>
            <p className="mt-0.5 text-sm text-muted">Manage users and configure individual permissions.</p>
          </div>
          {mayAdd && (
            <Link
              href="/settings/users/new"
              aria-label="Add a user"
              title="Add a user"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-base bg-brand text-brand-contrast shadow-sm transition-[filter] hover:brightness-110"
            >
              <Plus className="h-4 w-4" aria-hidden />
            </Link>
          )}
        </div>
        <div role="tablist" className="mt-4 flex gap-1 border-b border-line text-sm">
          {(
            [
              ["all", "All"],
              ["active", "Active"],
              ["inactive", "Inactive"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={status === key}
              onClick={() => setStatus(key)}
              className={cn("-mb-px whitespace-nowrap border-b-2 px-2.5 pb-2 transition-colors", status === key ? "border-brand font-medium text-brand" : "border-transparent text-muted hover:text-text")}
            >
              {label} ({counts[key]})
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2 p-4 pb-2">
        <label className="relative block">
          <span className="sr-only">Search users</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search users…" className="h-9 pl-8 text-sm" />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <Select value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Filter by department" className="h-9 min-w-0 pl-2.5 pr-7 text-xs">
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Filter by role" className="h-9 min-w-0 pl-2.5 pr-7 text-xs">
            <option value="">All roles</option>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </Select>
        </div>
        {withExceptions > 0 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={onlyExceptions} onChange={(e) => setOnlyExceptions(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--color-brand)]" />
            Only people with exceptions to their role ({withExceptions})
          </label>
        )}
      </div>
      <ul className="max-h-[46rem] flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {shown.map((r) => {
          const on = selected === r.id;
          return (
            <li key={r.id}>
              <Link
                href={userPath(r.id, tab === "permissions" ? undefined : tab)}
                aria-current={on ? "page" : undefined}
                className={cn("flex items-center gap-3 rounded-base border-l-2 px-2.5 py-2 transition-colors", on ? "border-brand bg-brand/10" : "border-transparent hover:bg-surface-sunken")}
              >
                <Avatar user={{ id: r.id, name: r.name, photoUpdatedAt: r.photoUpdatedAt }} size="md" />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-sm font-medium", !r.active ? "text-subtle" : "text-text")}>{r.name}</span>
                  <span className="block truncate text-xs text-subtle">
                    {r.isSuperAdmin ? "Super Admin" : r.roleName}
                    {r.departmentName ? ` • ${r.departmentName}` : ""}
                    {r.setupPending ? " • invited" : !r.active ? " • inactive" : ""}
                  </span>
                </span>
                {r.lapsingSoon && (
                  <span title="An exception to their role ends within a week" className="h-2 w-2 shrink-0 rounded-full bg-warning">
                    <span className="sr-only">An exception to their role ends within a week</span>
                  </span>
                )}
              </Link>
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-2.5 py-6 text-center text-sm text-subtle">Nobody matches.</li>}
      </ul>
    </Card>
  );
}
