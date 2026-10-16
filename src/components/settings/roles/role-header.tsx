"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { deleteRole, duplicateRole, setRoleActive, updateRole } from "@/actions/role";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { Switch } from "@/components/settings/access/switch";

/**
 * The top of an open role: its name and description (renaming changes nothing anybody holds), whether
 * it is switched on, and Duplicate and Delete — each refused by the server with its reason when it
 * can't be done (somebody still holds it, it's built in, the copy would hold more than you do).
 */
export function RoleHeader({
  role,
  mayManage,
}: {
  role: { key: string; name: string; description: string | null; isSystem: boolean; active: boolean; people: number };
  mayManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const toggle = (next: boolean) =>
    start(async () => {
      setNotice(null);
      const r = await setRoleActive(role.key, next);
      if (!r.ok) setNotice({ tone: "error", text: r.error });
      router.refresh();
    });

  const remove = () =>
    start(async () => {
      const r = await deleteRole(role.key);
      if (!r.ok) {
        setConfirmDelete(false);
        setNotice({ tone: "error", text: r.error });
        return;
      }
      router.push("/settings/roles");
      router.refresh();
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-xl font-semibold text-text">{role.name}</h2>
            {mayManage && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                aria-label={`Rename ${role.name}`}
                title="Rename"
                className="grid h-7 w-7 place-items-center rounded-base text-subtle transition-colors hover:bg-surface-sunken hover:text-text"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">{role.description || "No description yet."}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-text">
            <Switch label="Role switched on" checked={role.active} disabled={!mayManage || pending || (role.isSystem && role.active)} onChange={toggle} />
            {role.active ? "Active" : "Switched off"}
          </label>
          {mayManage && (
            <>
              <Button variant="secondary" onClick={() => setCopying(true)}>
                <Copy className="mr-1.5 h-4 w-4" aria-hidden />
                Duplicate
              </Button>
              <Button
                variant="secondary"
                className="border-danger/50 text-danger hover:bg-danger-bg"
                onClick={() => setConfirmDelete(true)}
                disabled={pending || role.isSystem}
                title={role.isSystem ? "One of the roles this application was built around — it can't be deleted." : undefined}
              >
                <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      {editing && <RenameDialog role={role} onClose={() => setEditing(false)} />}
      {copying && <DuplicateDialog role={role} onClose={() => setCopying(false)} />}
      {confirmDelete && (
        <Dialog open onClose={() => setConfirmDelete(false)} title={`Delete ${role.name}?`}>
          <p className="text-sm text-muted">
            {role.people > 0
              ? `${role.people} ${role.people === 1 ? "person holds" : "people hold"} it, so it can't be deleted. Move them to another role first.`
              : "Its permissions, reach and field access go with it. Its history stays."}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button variant="danger" size="sm" onClick={remove} disabled={pending || role.people > 0}>
              {pending ? "Deleting…" : "Delete role"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function RenameDialog({ role, onClose }: { role: { key: string; name: string; description: string | null }; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await updateRole({ key: role.key, name, description });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  return (
    <Dialog open onClose={onClose} title={`Rename ${role.name}`}>
      <div className="space-y-3">
        <p className="text-xs text-subtle">
          Stays <code className="font-mono">{role.key}</code> underneath, so renaming changes nothing anyone holds.
        </p>
        <div className="space-y-1">
          <Label htmlFor="rename-name">Name</Label>
          <Input id="rename-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rename-description">Description</Label>
          <Textarea id="rename-description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={pending || name.trim().length < 2}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function DuplicateDialog({ role, onClose }: { role: { key: string; name: string }; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(`${role.name} (copy)`);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const copy = () =>
    start(async () => {
      const r = await duplicateRole({ from: role.key, name });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.push(`/settings/roles?role=${encodeURIComponent(r.data.key)}`);
      router.refresh();
    });
  return (
    <Dialog open onClose={onClose} title={`Duplicate ${role.name}`}>
      <div className="space-y-3">
        <p className="text-sm text-muted">A new role starting with everything this one grants, reaches and masks. Nobody is moved to it.</p>
        <div className="space-y-1">
          <Label htmlFor="copy-name">New role&apos;s name</Label>
          <Input id="copy-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={copy} disabled={pending || name.trim().length < 2}>
            {pending ? "Copying…" : "Duplicate"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
