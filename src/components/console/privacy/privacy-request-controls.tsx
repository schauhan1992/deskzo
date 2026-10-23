"use client";

import { useId, useState } from "react";
import type { PrivacyRequestStatus } from "@deskzo/control-client";
import { consoleUpdatePrivacyRequest } from "@/actions/platform/console-privacy";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { PRIVACY_LIMITS, PRIVACY_STATUSES } from "@/components/site/privacy-fields";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/input";

/**
 * One privacy request's status and notes on /privacy-requests (src/actions/platform/console-privacy.ts).
 * Only what changed is sent; the notes are the record of what was done — the identity check, what was
 * sent or erased, and when — for staff only, never the person.
 */
export function PrivacyRequestControls({ id, status, notes }: { id: string; status: PrivacyRequestStatus; notes: string | null }) {
  const action = useConsoleAction<{ ref: string; status: PrivacyRequestStatus }>();
  const [nextStatus, setNextStatus] = useState<PrivacyRequestStatus>(status);
  const [text, setText] = useState(notes ?? "");
  const field = useId();
  const statusChanged = nextStatus !== status;
  const notesChanged = text.trim() !== (notes ?? "").trim();

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!statusChanged && !notesChanged) return;
        action.run(() => consoleUpdatePrivacyRequest(id, { ...(statusChanged ? { status: nextStatus } : {}), ...(notesChanged ? { notes: text } : {}) }), {
          success: (d) => `${d.ref} saved.`,
        });
      }}
    >
      <div>
        <Label htmlFor={`${field}-status`}>Status</Label>
        <Select id={`${field}-status`} className="mt-1" value={nextStatus} onChange={(e) => setNextStatus(e.target.value as PrivacyRequestStatus)}>
          {PRIVACY_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor={`${field}-notes`}>Notes</Label>
        <Textarea
          id={`${field}-notes`}
          className="mt-1 min-h-24"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={PRIVACY_LIMITS.notes}
          placeholder="What was done, and when: identity confirmed, data sent, erased, passed to the company…"
        />
      </div>
      {action.error && (
        <p role="alert" className="text-xs text-danger">
          {action.error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={action.pending || (!statusChanged && !notesChanged)}>
        {action.pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
