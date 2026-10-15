"use client";

import { useState, type FormEvent } from "react";
import { consoleSaveDocumentMailLimits } from "@/actions/platform/console-mail";
import { Panel } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/**
 * Settings › Mail: how much a workspace may send through Deskzo's own mail (owner, 15 Oct 2026) — the
 * documents emailed on a workspace's behalf when it has no mail of its own, from Deskzo's address.
 * Counted in recipients over the workspace's day. 0 closes Deskzo's mail to documents.
 */
export function DocumentMailLimitsPanel({
  limits,
  defaults,
  max,
  canEdit,
}: {
  limits: { personDaily: number; workspaceDaily: number };
  defaults: { personDaily: number; workspaceDaily: number };
  max: number;
  canEdit: boolean;
}) {
  const [person, setPerson] = useState(String(limits.personDaily));
  const [workspace, setWorkspace] = useState(String(limits.workspaceDaily));
  const save = useConsoleAction<{ personDaily: number; workspaceDaily: number }>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.run(() => consoleSaveDocumentMailLimits({ personDaily: person, workspaceDaily: workspace }), { success: "Limits saved." });
  };

  return (
    <Panel
      title="Documents sent for workspaces"
      description={`Invoices and quotes a workspace emails through Deskzo's mail, when it has no mail of its own, go out from Deskzo's address — so they carry Deskzo's sending reputation. Each day, counted in recipients over the workspace's own day. 0 stops Deskzo sending documents. Defaults: ${defaults.personDaily} a person, ${defaults.workspaceDaily} a workspace.`}
    >
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="doc-limit-person">A person, a day</Label>
          <Input id="doc-limit-person" type="number" min={0} max={max} step={1} value={person} onChange={(e) => setPerson(e.target.value)} disabled={!canEdit || save.pending} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-limit-workspace">A workspace, a day</Label>
          <Input id="doc-limit-workspace" type="number" min={0} max={max} step={1} value={workspace} onChange={(e) => setWorkspace(e.target.value)} disabled={!canEdit || save.pending} />
        </div>
        {canEdit && (
          <Button type="submit" disabled={save.pending}>
            {save.pending ? "Saving…" : "Save"}
          </Button>
        )}
      </form>
      {save.error && <p className="mt-2 text-sm text-danger">{save.error}</p>}
    </Panel>
  );
}
