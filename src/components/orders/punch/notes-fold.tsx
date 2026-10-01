"use client";

import { useWatch } from "react-hook-form";
import { Label, Select, Textarea } from "@/components/ui/input";
import { Fold } from "./parts";
import type { ProposalOption, PunchForm } from "./types";

/** Free notes on the order, and the proposal it came from — offered only when the customer has one. */
export function NotesFold({
  form,
  proposals,
  open,
  hasError,
  onOpenChange,
}: {
  form: PunchForm;
  proposals: ProposalOption[];
  open: boolean | undefined;
  hasError: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { control, register } = form;
  const [notes, proposalId] = useWatch({ control, name: ["notes", "proposalId"] });
  const hasNotes = !!notes?.trim();
  // A proposal on file is worth a mention while the section is shut: it is the one thing in here that
  // somebody would otherwise not know to look for.
  const proposalLine = proposalId
    ? "Proposal linked"
    : proposals.length > 0
      ? `${proposals.length} proposal${proposals.length === 1 ? "" : "s"} on file`
      : null;
  const summary = [hasNotes ? "Has notes" : null, proposalLine].filter(Boolean).join(" · ");

  return (
    <Fold title="Notes" summary={summary} open={open ?? (hasNotes || !!proposalId || hasError)} onOpenChange={onOpenChange}>
      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" {...register("notes")} />
      </div>
      {proposals.length > 0 && (
        <div className="space-y-1.5 sm:max-w-md">
          <Label htmlFor="proposalId">Linked proposal</Label>
          <Select id="proposalId" {...register("proposalId")}>
            <option value="">No proposal</option>
            {proposals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.lead.title} — {p.status}
              </option>
            ))}
          </Select>
        </div>
      )}
    </Fold>
  );
}
