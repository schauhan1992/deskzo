"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, ShieldCheck, Users } from "lucide-react";
import { createRole } from "@/actions/role";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

export type RoleListItem = { key: string; name: string; isSystem: boolean; active: boolean; people: number; description: string | null };

/**
 * The roles, searchable, each with how many people hold it — the left of Roles & permissions. Choosing
 * one opens it beside the list; "Create custom role" makes one holding nothing yet, to be filled in.
 */
export function RolesList({ roles, selected, mayManage, superAdmins }: { roles: RoleListItem[]; selected: string | null; mayManage: boolean; superAdmins: number }) {
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? roles.filter((r) => r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q)) : roles;
  }, [roles, search]);

  return (
    <div className="flex flex-col rounded-base border border-line bg-surface">
      <div className="border-b border-line p-3">
        <h2 className="text-sm font-semibold text-text">Roles</h2>
        <label className="relative mt-2 block">
          <span className="sr-only">Search roles</span>
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-subtle" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search roles…" className="h-8 pl-8 text-sm" />
        </label>
      </div>
      <ul className="max-h-[36rem] flex-1 overflow-y-auto p-2">
        {superAdmins > 0 && !search && (
          <li className="flex items-center gap-2.5 rounded-base px-2.5 py-2 text-sm">
            <ShieldCheck className="h-4 w-4 shrink-0 text-brand" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-text">Super admin</span>
              <span className="block text-xs text-subtle">{superAdmins} user · holds everything</span>
            </span>
            <Badge>System</Badge>
          </li>
        )}
        {shown.map((r) => (
          <li key={r.key}>
            <Link
              href={`/settings/access?tab=roles&role=${encodeURIComponent(r.key)}`}
              aria-current={selected === r.key ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-base px-2.5 py-2 text-sm ${selected === r.key ? "bg-brand/10 ring-1 ring-brand/30" : "hover:bg-surface-sunken"}`}
            >
              <Users className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-text">{r.name}</span>
                <span className="block text-xs text-subtle">
                  {r.people} {r.people === 1 ? "user" : "users"}
                  {!r.active && " · switched off"}
                </span>
              </span>
              {r.isSystem && <Badge>System</Badge>}
            </Link>
          </li>
        ))}
        {shown.length === 0 && <li className="px-2.5 py-6 text-center text-sm text-subtle">No role matches “{search}”.</li>}
      </ul>
      {mayManage && (
        <div className="border-t border-line p-3">
          <Button variant="secondary" size="sm" className="w-full" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Create custom role
          </Button>
        </div>
      )}
      {creating && <CreateRoleDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateRoleDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const create = () =>
    start(async () => {
      setError(null);
      const made = await createRole({ name, description });
      if (!made.ok) {
        setError(made.error);
        return;
      }
      onClose();
      router.push(`/settings/access?tab=roles&role=${encodeURIComponent(made.data.key)}&rtab=modules`);
      router.refresh();
    });
  return (
    <Dialog open onClose={onClose} title="Create a custom role">
      <div className="space-y-3">
        <p className="text-sm text-muted">A new role holds nothing but the menu sections until you give it permissions.</p>
        <div className="space-y-1">
          <Label htmlFor="new-role-name">Role name</Label>
          <Input id="new-role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Regional manager" autoComplete="off" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="new-role-description">Description</Label>
          <Textarea id="new-role-description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={create} disabled={pending || name.trim().length < 2}>
            {pending ? "Creating…" : "Create role"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
