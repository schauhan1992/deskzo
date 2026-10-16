"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, Mail, Phone, RotateCcw, Save } from "lucide-react";
import { resetPersonToRole } from "@/actions/person-access";
import { startViewingAs } from "@/actions/impersonation";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { useDraft } from "@/components/settings/people/person-draft";

/**
 * The top of one person's page: who they are, and Reset to role defaults, View as user and Save
 * changes — the last saving everything changed below at once, with one reason and end date for the
 * exceptions it makes.
 */
export function UserHeader({
  person,
  exceptions,
  canReset,
  canViewAs,
}: {
  person: { id: string; name: string; email: string; phone: string | null; active: boolean; setupPending: boolean; isSuperAdmin: boolean; roleName: string; department: string | null; photoUpdatedAt: string | null };
  exceptions: number;
  canReset: boolean;
  canViewAs: boolean;
}) {
  const router = useRouter();
  const { pending, saveAll, discardAll } = useDraft();
  const [confirmReset, setConfirmReset] = useState(false);
  // The count as the dialog opened, so the title holds still while each editor saves in turn.
  const [saving, setSaving] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, start] = useTransition();

  const reset = () =>
    start(async () => {
      const r = await resetPersonToRole(person.id);
      setConfirmReset(false);
      discardAll();
      setNotice(r.ok ? { tone: "success", text: r.data.removed ? `Removed ${r.data.removed} exception${r.data.removed === 1 ? "" : "s"}. ${person.name} now has what their role gives.` : "Nothing to reset — they already follow their role." } : { tone: "error", text: r.error });
      router.refresh();
    });

  const viewAs = () =>
    start(async () => {
      const r = await startViewingAs(person.id);
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      router.push("/dashboard");
      router.refresh();
    });

  const save = () =>
    start(async () => {
      const error = await saveAll({ reason: reason.trim() || undefined, expiresAt: until || null });
      setSaving(null);
      setNotice(error ? { tone: "error", text: error } : { tone: "success", text: "Saved." });
      if (!error) {
        setReason("");
        setUntil("");
      }
      router.refresh();
    });

  const status = person.isSuperAdmin ? { tone: "brand" as const, text: "Super admin" } : !person.active ? { tone: "default" as const, text: "Inactive" } : person.setupPending ? { tone: "amber" as const, text: "Invited" } : { tone: "green" as const, text: "Active" };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar user={{ id: person.id, name: person.name, photoUpdatedAt: person.photoUpdatedAt }} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-text">{person.name}</h2>
              <Badge tone={status.tone}>{status.text}</Badge>
            </div>
            <p className="mt-0.5 text-sm text-muted">
              {person.roleName}
              {person.department ? ` • ${person.department}` : ""}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              <span className="inline-flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" aria-hidden />
                {person.email}
              </span>
              {person.phone && (
                <span className="inline-flex items-center gap-1.5">
                  <Phone className="h-3.5 w-3.5" aria-hidden />
                  {person.phone}
                </span>
              )}
              <span className="text-xs text-subtle">{exceptions ? `${exceptions} exception${exceptions === 1 ? "" : "s"} to their role` : "Follows their role exactly"}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canReset && (
            <Button variant="secondary" onClick={() => setConfirmReset(true)} disabled={busy}>
              <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden />
              Reset to role defaults
            </Button>
          )}
          {canViewAs && (
            <Button variant="secondary" onClick={viewAs} disabled={busy}>
              <Eye className="mr-1.5 h-4 w-4" aria-hidden />
              View as user
            </Button>
          )}
          <Button onClick={() => setSaving(pending)} disabled={busy || pending === 0}>
            <Save className="mr-1.5 h-4 w-4" aria-hidden />
            {pending ? `Save changes (${pending})` : "Save changes"}
          </Button>
        </div>
      </div>
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}

      {saving !== null && (
        <Dialog open onClose={() => !busy && setSaving(null)} title={`Save ${saving} change${saving === 1 ? "" : "s"} for ${person.name}`}>
          <div className="space-y-3">
            <p className="text-sm text-muted">Exceptions to their role are written to the permission history with this reason. An end date makes them temporary.</p>
            <div className="space-y-1">
              <Label htmlFor="save-reason">Reason (optional)</Label>
              <Input id="save-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Covering collections this week" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="save-until">Until (optional)</Label>
              <Input id="save-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="w-48" />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  discardAll();
                  setSaving(null);
                }}
                disabled={busy}
              >
                Discard changes
              </Button>
              <Button size="sm" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {confirmReset && (
        <Dialog open onClose={() => setConfirmReset(false)} title={`Reset ${person.name} to their role?`}>
          <p className="text-sm text-muted">
            {exceptions
              ? `Their ${exceptions} exception${exceptions === 1 ? "" : "s"} — permissions, record access, field access and their daily limit — will be removed. Their role, and everybody else, stay as they are.`
              : "They have no exceptions; nothing will change."}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={reset} disabled={busy}>
              {busy ? "Resetting…" : "Reset to role defaults"}
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
