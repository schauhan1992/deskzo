"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, Pencil, Plus, Trash2, Users } from "lucide-react";
import { createRole, deleteRole, updateRole, type RoleRow } from "@/actions/role";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { IconButton, RowActions } from "@/components/ui/icon-button";

/**
 * Making a role, rather than filling one in.
 *
 * The matrix below this decides what a role can do. This decides which roles there are — which used
 * to be a question only a migration could answer, so in practice it was answered by giving somebody
 * the nearest role and three personal exceptions. An exception is for the individual case; a role
 * everybody needs the same three exceptions on is a role that should have existed.
 *
 * ## Why the name is editable and the key is not
 *
 * The key is a foreign key in three tables and is what the permission resolver and every built-in
 * preset compare against. It is generated from the name once, at creation, and then left alone.
 * The name is a label and nothing is keyed on it, so renaming is free — which is why the dialog
 * shows the key, greyed, rather than hiding it: somebody who renames "Accounts" to "Finance" should
 * be able to see that the thing underneath did not move.
 */
export function RoleManager({ roles, mayManage }: { roles: RoleRow[]; mayManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const openCreate = () => {
    setError(null);
    setName("");
    setDescription("");
    setCreating(true);
  };

  const openEdit = (role: RoleRow) => {
    setError(null);
    setName(role.name);
    setDescription(role.description ?? "");
    setEditing(role);
  };

  const close = () => {
    setCreating(false);
    setEditing(null);
    setError(null);
  };

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = editing
        ? await updateRole({ key: editing.key, name, description })
        : await createRole({ name, description });
      if (!result.ok) setError(result.error);
      else {
        close();
        router.refresh();
      }
    });
  };

  const remove = (role: RoleRow) => {
    setError(null);
    startTransition(async () => {
      const result = await deleteRole(role.key);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-text">Roles</div>
          <div className="mt-0.5 text-xs text-muted">
            {roles.length} roles. Each is a column in the matrix below — a new one starts holding nothing.
          </div>
        </div>
        {mayManage && (
          <Button size="sm" onClick={openCreate} disabled={pending}>
            <Plus className="h-3.5 w-3.5" />
            New role
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-2">
        {error && !creating && !editing && <p className="text-sm text-danger">{error}</p>}

        <ul className="divide-y divide-line">
          {roles.map((role) => (
            <li key={role.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text">{role.name}</span>
                  {role.isSystem && (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-subtle"
                      title="Built in. Rename it and change what it grants freely — it cannot be deleted, because the application names it by key."
                    >
                      <Lock aria-hidden className="h-3 w-3" />
                      built in
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                  <span className="font-mono text-subtle">{role.key}</span>
                  <span className="inline-flex items-center gap-1">
                    <Users aria-hidden className="h-3 w-3" />
                    {role.headcount === 1 ? "1 person" : `${role.headcount} people`}
                  </span>
                  {role.description && <span className="truncate">· {role.description}</span>}
                </div>
              </div>

              {mayManage && (
                <RowActions>
                  <IconButton icon={Pencil} label={`Rename ${role.name}`} onClick={() => openEdit(role)} disabled={pending} />
                  {/* Offered only where it could succeed. A built-in role, or one somebody holds,
                      is refused by the action and by the foreign key underneath it — a button whose
                      only outcome is an error message teaches people to ignore error messages. */}
                  {!role.isSystem && role.headcount === 0 && (
                    <IconButton
                      icon={Trash2}
                      label={`Delete ${role.name}`}
                      tone="danger"
                      onClick={() => remove(role)}
                      disabled={pending}
                    />
                  )}
                </RowActions>
              )}
            </li>
          ))}
        </ul>
      </CardContent>

      <Dialog open={creating || editing !== null} onClose={close} title={editing ? "Rename role" : "New role"}>
        <div className="space-y-4">
          <div>
            <label htmlFor="role-name" className="text-xs font-medium text-text">
              Name
            </label>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Regional Manager"
              className="mt-1"
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-subtle">
              {editing ? (
                <>
                  Renaming is safe — nothing is keyed on the name. This role stays{" "}
                  <code className="font-mono">{editing.key}</code> underneath, so every permission and every person
                  holding it is unaffected.
                </>
              ) : (
                <>
                  The key is generated from this once and never changes, so pick a name you can live with as{" "}
                  <code className="font-mono">{keyPreview(name) || "…"}</code>. You can rename it freely afterwards.
                </>
              )}
            </p>
          </div>

          <div>
            <label htmlFor="role-description" className="text-xs font-medium text-text">
              Description <span className="font-normal text-subtle">(optional)</span>
            </label>
            <Input
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Runs a territory and owns its pipeline"
              className="mt-1"
              autoComplete="off"
            />
          </div>

          {!editing && (
            <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">
              A new role holds <strong>nothing</strong>. Tick what it needs in the matrix below, or apply a preset and
              adjust — arriving with a guess at what you meant would be worse than arriving empty.
            </p>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={pending || name.trim().length < 2}>
              {pending ? "Saving…" : editing ? "Save" : "Create role"}
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

/**
 * The same transformation the server does, so the field can show what it is about to produce.
 *
 * Duplicated deliberately rather than shared: the server's copy is the one that decides, and this
 * one only has to be close enough to stop somebody being surprised. Importing the action's helper
 * would pull the whole module — Prisma included — into this bundle.
 */
function keyPreview(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 40);
}
