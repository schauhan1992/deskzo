"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { importAutomationWorkflow, previewWorkflowImport } from "@/actions/automate";
import type { ImportPreview } from "@/lib/automate/transfer";

const MAX_BYTES = 512 * 1024;

/**
 * Import a workflow file (Deskzo Automate, Phase 5). Before anything is made it says what the file's
 * workflow starts from, what it does, every outside place it would send to, what was cleared because
 * it named another workspace's records, and what is left to choose. It lands as a draft.
 */
export function ImportWorkflowButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setText(null);
    setPreview(null);
    setError(null);
  };
  const read = async (file: File | undefined) => {
    reset();
    if (!file) return;
    if (file.size > MAX_BYTES) return setError("That file is over 512 KB — too big to be a workflow.");
    const content = await file.text();
    setBusy(true);
    const result = await previewWorkflowImport(content);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setText(content);
    setPreview(result.data);
  };
  const confirm = async () => {
    if (!text) return;
    setBusy(true);
    const made = await importAutomationWorkflow(text);
    setBusy(false);
    if (!made.ok) return setError(made.error);
    router.push(made.data.path);
  };

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Upload className="h-3.5 w-3.5" /> Import
      </Button>
      <Dialog open={open} onClose={() => !busy && setOpen(false)} title="Import a workflow">
        <div className="space-y-3 text-sm">
          <p className="text-muted">Choose a workflow file exported from Deskzo Automate. It comes in as a draft: nothing runs until you publish it.</p>
          <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => void read(e.target.files?.[0])} className="block w-full text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-base file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-text hover:file:bg-surface-sunken" />
          {error && <p className="text-danger">{error}</p>}
          {preview && (
            <div className="space-y-3 rounded-base border border-line p-3">
              <div>
                <p className="font-medium text-text">{preview.name}</p>
                {preview.description && <p className="text-muted">{preview.description}</p>}
                <p className="mt-1 text-xs text-subtle">Starts when: {preview.trigger}</p>
                <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-subtle">
                  {preview.steps.map((s, i) => (
                    <li key={`${i}-${s}`}>{s}</li>
                  ))}
                </ol>
              </div>
              <div>
                <p className="font-medium text-text">Sends outside Deskzo</p>
                {preview.calls.length ? (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
                    {preview.calls.map((c) => (
                      <li key={c} className="break-all">
                        {c}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted">Nowhere.</p>
                )}
              </div>
              {preview.cleared.length > 0 && (
                <div>
                  <p className="font-medium text-text">Cleared — they named another workspace&apos;s people or records</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
                    {preview.cleared.map((c, i) => (
                      <li key={`${i}-${c.label}`}>{c.label}</li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.blanks.length + preview.others.length > 0 && (
                <p className="rounded-base bg-warning-bg px-3 py-2 text-xs text-warning">
                  {preview.blanks.length + preview.others.length} thing{preview.blanks.length + preview.others.length === 1 ? "" : "s"} to choose or fix in the builder before it can be published.
                </p>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || !preview} onClick={confirm}>
              Import as a draft
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
