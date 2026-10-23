"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { linkDocumentToLead, listPartyLeads, type PartyLead } from "@/actions/document-lead";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";

/**
 * "Link to lead" on a proposal's page (src/actions/document-lead.ts): the customer's leads, asked for when
 * opened, the open ones first. Choosing "No lead" unlinks it. What was made from the proposal follows.
 */
export function DocumentLeadLink({ documentId, companyId, currentId }: { documentId: string; companyId: string; currentId: string | null }) {
  const router = useRouter();
  const w = useWording();
  const [pending, startTransition] = useTransition();
  const [leads, setLeads] = useState<PartyLead[] | null>(null);
  const [chosen, setChosen] = useState(currentId ?? "");
  const [error, setError] = useState<string | null>(null);

  function open() {
    setError(null);
    startTransition(async () => {
      const rows = await listPartyLeads(companyId);
      setLeads(rows);
      // Nothing linked and one open lead: that's the likely one.
      const openRows = rows.filter((l) => l.open);
      if (!currentId && openRows.length === 1) setChosen(openRows[0]!.id);
    });
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await linkDocumentToLead({ documentId, leadId: chosen || null });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLeads(null);
      router.refresh();
    });
  }

  if (!leads) {
    return (
      <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={open}>
        {currentId ? "Change" : slot(w, "Link to lead", "lead", "Link to {one:lower}")}
      </Button>
    );
  }

  if (leads.length === 0) {
    return (
      <p className="text-xs text-subtle">
        {slot(w, "This customer has no leads you can see.", "lead", "This customer has no {many:lower} you can see.")}{" "}
        <button type="button" className="underline" onClick={() => setLeads(null)}>
          Close
        </button>
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <Select aria-label={slot(w, "Lead", "lead", "{one}")} value={chosen} onChange={(e) => setChosen(e.target.value)} disabled={pending}>
        <option value="">{slot(w, "No lead", "lead", "No {one:lower}")}</option>
        {leads.map((l) => (
          <option key={l.id} value={l.id}>
            {l.ref} · {l.title}
            {l.stage ? ` — ${l.stage}` : ""}
            {l.open ? "" : " (closed)"}
          </option>
        ))}
      </Select>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending || chosen === (currentId ?? "")} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setLeads(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
