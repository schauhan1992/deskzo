"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, ShieldCheck, UsersRound } from "lucide-react";
import { createRole } from "@/actions/role";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { cn } from "@/lib/utils";
import { rolePath } from "@/lib/staff/staff-paths";

export type RoleListItem = { key: string; name: string; isSystem: boolean; active: boolean; people: number; description: string | null };

/**
 * The roles, searchable, each with how many people hold it — the left of Roles & Permissions. Choosing
 * one opens it beside the list; "Create custom role" makes one holding nothing yet, to be filled in.
 * The super admin and Admin are the system's own; every other role can be changed.
 */
export function RolesList({ roles, selected, mayManage, superAdmins }: { roles: RoleListItem[]; selected: string | null; mayManage: boolean; superAdmins: number }) {
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? roles.filter((r) => r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q)) : roles;
  }, [roles, search]);

  return (
    <Card className="flex flex-col">
      <div className="border-b border-line px-4 pb-3 pt-4">
        <h2 className="text-base font-semibold text-text">Roles</h2>
        <label className="relative mt-3 block">
          <span className="sr-only">Search roles</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search roles…" className="h-9 pl-8 text-sm" />
        </label>
      </div>
      <ul className="max-h-[44rem] flex-1 space-y-0.5 overflow-y-auto p-2">
        {superAdmins > 0 && !search && (
          <li className="flex items-center gap-3 rounded-base px-2.5 py-2.5">
            <RoleTile icon="super" active={false} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-text">Super Admin</span>
              <span className="block text-xs text-subtle">
                {superAdmins} {superAdmins === 1 ? "user" : "users"}
              </span>
            </span>
            <Badge>System</Badge>
          </li>
        )}
        {shown.map((r) => {
          const on = selected === r.key;
          return (
            <li key={r.key}>
              <Link
                href={rolePath(r.key)}
                aria-current={on ? "page" : undefined}
                className={cn("flex items-center gap-3 rounded-base px-2.5 py-2.5 transition-colors", on ? "bg-brand/10" : "hover:bg-surface-sunken")}
              >
                <RoleTile icon="role" active={on} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-sm font-medium", on ? "text-brand" : "text-text")}>{r.name}</span>
                  <span className="block text-xs text-subtle">
                    {r.people} {r.people === 1 ? "user" : "users"}
                    {!r.active && " · switched off"}
                  </span>
                </span>
                {r.key === "ADMIN" && <Badge>System</Badge>}
              </Link>
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-2.5 py-6 text-center text-sm text-subtle">No role matches “{search}”.</li>}
      </ul>
      {mayManage && (
        <div className="border-t border-line p-3">
          <Button variant="secondary" className="w-full" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden />
            Create custom role
          </Button>
        </div>
      )}
      {creating && <CreateRoleDialog onClose={() => setCreating(false)} />}
    </Card>
  );
}

function RoleTile({ icon, active }: { icon: "super" | "role"; active: boolean }) {
  const Icon = icon === "super" ? ShieldCheck : UsersRound;
  return (
    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-base border", active ? "border-brand/30 bg-brand/10 text-brand" : "border-line bg-surface-sunken text-muted")}>
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}

/** "Create role", at the top of the page: the same dialog as the list's own button. */
export function CreateRoleButton() {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Button onClick={() => setCreating(true)}>
        <Plus className="mr-1.5 h-4 w-4" aria-hidden />
        Create role
      </Button>
      {creating && <CreateRoleDialog onClose={() => setCreating(false)} />}
    </>
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
      router.push(rolePath(made.data.key));
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
