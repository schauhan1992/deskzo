"use client";

import { useState } from "react";
import { Ban, LoaderCircle } from "lucide-react";
import { cmsMarkLeadSpam, cmsUpdateLead } from "@/actions/cms/leads";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/input";
import { LEAD_STATUSES, LEAD_STATUS_LABELS, type LeadDetail, type SiteLeadStatus } from "@/lib/cms/types";

const NOTES_MAX = 4000;

const STATUS_HINT: Record<SiteLeadStatus, string> = {
  NEW: "Nobody has answered yet.",
  CONTACTED: "Someone has been in touch.",
  QUALIFIED: "A real prospect, worth following up.",
  CLOSED: "Dealt with — nothing more to do.",
  SPAM: "Not a real request.",
};

/**
 * Working a lead — for editors and admins: its status, the team's notes (replaced whole on save), and
 * "Mark as spam". Viewers and authors get the same facts read-only on the page instead.
 */
export function LeadWorkPanel({ lead }: { lead: LeadDetail }) {
  const [status, setStatus] = useState<SiteLeadStatus>(lead.status);
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [confirmSpam, setConfirmSpam] = useState(false);
  const statusAction = useCmsAction<LeadDetail>();
  const notesAction = useCmsAction<LeadDetail>();
  const spamAction = useCmsAction<LeadDetail>();
  const notesChanged = notes.trim() !== (lead.notes ?? "");

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="lead-status">Status</Label>
        <div className="flex flex-wrap items-center gap-2">
          <Select id="lead-status" value={status} onChange={(e) => setStatus(e.target.value as SiteLeadStatus)} className="w-44" aria-describedby="lead-status-hint">
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LEAD_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            size="sm"
            disabled={status === lead.status || statusAction.pending}
            onClick={() => statusAction.run(() => cmsUpdateLead(lead.id, { status }), { success: `Marked ${LEAD_STATUS_LABELS[status].toLowerCase()}.` })}
          >
            {statusAction.pending && <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
            Save status
          </Button>
        </div>
        <p id="lead-status-hint" className="text-xs text-subtle">
          {STATUS_HINT[status]}
        </p>
        <ActionNoticeRegion notice={statusAction.error ? { tone: "error", message: statusAction.error } : null} />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="lead-notes">Notes for the team</Label>
          <span className={notes.length > NOTES_MAX ? "text-[11px] text-danger tabular-nums" : "text-[11px] text-subtle tabular-nums"}>
            {notes.length.toLocaleString("en-IN")}/{NOTES_MAX.toLocaleString("en-IN")}
          </span>
        </div>
        <Textarea id="lead-notes" value={notes} rows={6} onChange={(e) => setNotes(e.target.value)} placeholder="Called on Monday; wants a demo for 20 people…" aria-describedby="lead-notes-hint" />
        <div className="flex items-center justify-between gap-2">
          <p id="lead-notes-hint" className="text-xs text-subtle">
            Only the CMS sees these. Saving replaces the notes whole.
          </p>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={!notesChanged || notes.length > NOTES_MAX || notesAction.pending}
            onClick={() => notesAction.run(() => cmsUpdateLead(lead.id, { notes: notes.trim() || null }), { success: notes.trim() ? "Notes saved." : "Notes cleared." })}
          >
            {notesAction.pending && <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
            Save notes
          </Button>
        </div>
        <ActionNoticeRegion notice={notesAction.error ? { tone: "error", message: notesAction.error } : null} />
      </div>

      {lead.status !== "SPAM" && (
        <div className="border-t border-line pt-4">
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmSpam(true)} className="text-danger hover:bg-danger-bg hover:text-danger">
            <Ban aria-hidden="true" className="h-4 w-4" />
            Mark as spam…
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmSpam}
        onClose={() => {
          setConfirmSpam(false);
          spamAction.reset();
        }}
        title="Mark this lead as spam"
        tone="danger"
        confirmLabel="Mark as spam"
        pending={spamAction.pending}
        error={spamAction.error}
        onConfirm={() =>
          spamAction.run(() => cmsMarkLeadSpam(lead.id), {
            success: "Marked as spam.",
            onDone: (next) => {
              setStatus(next.status);
              setConfirmSpam(false);
            },
          })
        }
      >
        <p>It moves to the Spam view and out of the inbox&apos;s counts. It can be moved back by changing its status.</p>
      </ConfirmDialog>
    </div>
  );
}
