"use client";

import { useId, useState, type FormEvent } from "react";
import { LoaderCircle, Pencil } from "lucide-react";
import { consoleUpdatePartner } from "@/actions/platform/console-partners";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/input";

/**
 * Staff's notes about a partner — never shown to the partner. Every staff member reads them;
 * MANAGERS edit them in place (`consoleUpdatePartner` with `notes` alone). Printed as text, line
 * breaks kept.
 */

const MAX = 5000;

export function PartnerNotes({ partnerId, notes, canEdit }: { partnerId: string; notes: string | null; canEdit: boolean }) {
  const id = useId();
  const action = useConsoleAction<unknown>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");

  function start() {
    action.reset();
    setDraft(notes ?? "");
    setEditing(true);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (action.pending) return;
    const text = draft.trim();
    action.run(() => consoleUpdatePartner(partnerId, { notes: text ? text : null }), { success: text ? "Notes saved." : "Notes cleared.", onDone: () => setEditing(false) });
  }

  if (editing) {
    const fieldId = `${id}-notes`;
    return (
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor={fieldId}>Staff notes</Label>
          <Textarea id={fieldId} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={MAX} rows={5} readOnly={action.pending} autoFocus />
          <p className="text-xs text-subtle tabular-nums">{`${draft.length} / ${MAX} · never shown to the partner`}</p>
        </div>
        <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={action.pending}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={action.pending || draft.trim() === (notes ?? "").trim()} aria-busy={action.pending || undefined}>
            {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Save notes
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      {notes ? <p className="text-sm whitespace-pre-wrap break-words text-text">{notes}</p> : <p className="text-sm text-muted">No notes yet.</p>}
      {canEdit && (
        <Button type="button" size="sm" variant="secondary" onClick={start}>
          <Pencil aria-hidden="true" className="h-4 w-4" />
          {notes ? "Edit notes" : "Add notes"}
        </Button>
      )}
    </div>
  );
}
