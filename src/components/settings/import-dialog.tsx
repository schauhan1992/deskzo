"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, AlertTriangle, Check, FileDown, X } from "lucide-react";
import { previewImport, commitImport, importTemplate } from "@/actions/data-import";
import type { ImportPlan } from "@/lib/portability/import";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/**
 * Pick a file, see exactly what would happen, then decide.
 *
 * The preview is the feature. Anybody can write a loop that reads a spreadsheet into a database;
 * what makes an import safe to hand to somebody is that they can see, before committing, which rows
 * are new, which existing records change, precisely what those changes are, and which rows are
 * unusable and why. The Import button stays out of reach until that has been looked at.
 */

const ACTION_TONE = {
  create: "green",
  update: "amber",
  skip: "default",
  error: "red",
} as const;

export function ImportDialog({ areaKey, areaLabel }: { areaKey: string; areaLabel: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: number; updated: number; skipped: number; failed: { line: number; error: string }[] } | null>(null);

  const reset = () => {
    setFile(null);
    setPlan(null);
    setError(null);
    setDone(null);
  };

  const choose = (f: File) => {
    reset();
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1] ?? "";
      setFile({ name: f.name, base64 });
      startTransition(async () => {
        const result = await previewImport({ area: areaKey, filename: f.name, base64 });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setPlan(result.data);
      });
    };
    reader.onerror = () => setError("That file couldn't be read.");
    reader.readAsDataURL(f);
  };

  const commit = () => {
    if (!file) return;
    setError(null);
    startTransition(async () => {
      const result = await commitImport({ area: areaKey, filename: file.name, base64: file.base64 });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(result.data);
      setPlan(null);
      router.refresh();
    });
  };

  const template = () => {
    startTransition(async () => {
      const result = await importTemplate(areaKey);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const url = URL.createObjectURL(new Blob([result.data.csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.data.filename;
      link.click();
      URL.revokeObjectURL(url);
    });
  };

  const changed = plan?.rows.filter((r) => r.action !== "skip") ?? [];

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Upload className="h-3.5 w-3.5" />
        Import
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title={`Import ${areaLabel.toLowerCase()}`}
      >
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

          {done ? (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium text-success">
                <Check className="h-4 w-4" />
                {done.created} created, {done.updated} updated, {done.skipped} already matched.
              </p>
              {done.failed.length > 0 && (
                <Card className="border-danger/40 bg-danger-bg px-3 py-2">
                  <p className="text-sm font-medium text-danger">{done.failed.length} row(s) could not be written</p>
                  <ul className="mt-1 space-y-0.5 text-xs text-danger">
                    {done.failed.slice(0, 10).map((f) => (
                      <li key={f.line}>Row {f.line}: {f.error}</li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-xs text-danger">
                    The rest went in. Fix these rows and import the file again — matching is by key, so nothing
                    duplicates.
                  </p>
                </Card>
              )}
              <Button
                size="sm"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Done
              </Button>
            </div>
          ) : !plan ? (
            <div className="space-y-3">
              <p className="text-sm text-muted">
                A CSV or Excel file. Nothing is written until you have seen what it would do.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={isPending} onClick={() => fileRef.current?.click()}>
                  <Upload className="h-3.5 w-3.5" />
                  {isPending ? "Reading…" : "Choose a file"}
                </Button>
                <Button size="sm" variant="ghost" disabled={isPending} onClick={template}>
                  <FileDown className="h-3.5 w-3.5" />
                  Download the template
                </Button>
              </div>
              <p className="text-xs text-subtle">
                A file exported from here can be edited and handed straight back — the cover sheet is ignored.
                Records are matched on their key, so importing the same file twice changes nothing the second time.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="green">{plan.creates} new</Badge>
                <Badge tone="amber">{plan.updates} changed</Badge>
                <Badge tone="default">{plan.skips} already match</Badge>
                {plan.errors > 0 && <Badge tone="red">{plan.errors} unusable</Badge>}
                <span className="text-muted">from {plan.totalRows} rows in {file?.name}</span>
              </div>

              {plan.unknownColumns.length > 0 && (
                <p className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Ignoring columns this import doesn&rsquo;t recognise: {plan.unknownColumns.join(", ")}. If one of
                    those holds data you wanted, the headings may not match the template.
                  </span>
                </p>
              )}

              {changed.length === 0 ? (
                <p className="rounded-md bg-surface-sunken px-3 py-4 text-center text-sm text-subtle">
                  Every row already matches what is stored. Importing would change nothing.
                </p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-md border border-line">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                      <tr>
                        <th className="px-3 py-2">Row</th>
                        <th className="px-3 py-2">What</th>
                        <th className="px-3 py-2">Record</th>
                        <th className="px-3 py-2">Changes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changed.slice(0, 200).map((r) => (
                        <tr key={r.line} className="border-b border-line last:border-0 align-top">
                          <td className="px-3 py-2 font-mono text-xs text-subtle">{r.line}</td>
                          <td className="px-3 py-2">
                            <Badge tone={ACTION_TONE[r.action]}>{r.action}</Badge>
                          </td>
                          <td className="px-3 py-2 text-text">{r.label || "—"}</td>
                          <td className="px-3 py-2 text-xs text-muted">
                            {r.error ? (
                              <span className="text-danger">{r.error}</span>
                            ) : (
                              r.changes.map((c) => (
                                <div key={c.field}>
                                  <span className="text-subtle">{c.field}:</span> {c.from} → <strong className="text-text">{c.to}</strong>
                                </div>
                              ))
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {changed.length > 200 && (
                    <p className="border-t border-line px-3 py-1.5 text-xs text-subtle">
                      Showing the first 200 of {changed.length}. All of them will be imported.
                    </p>
                  )}
                </div>
              )}

              {plan.updates > 0 && (
                <p className="text-xs text-warning">
                  {plan.updates} existing record(s) will be overwritten with the values above. There is no undo.
                </p>
              )}

              <div className="flex gap-2">
                <Button size="sm" disabled={isPending || changed.length === 0 || plan.creates + plan.updates === 0} onClick={commit}>
                  {isPending ? "Importing…" : `Import ${plan.creates + plan.updates} row(s)`}
                </Button>
                <Button size="sm" variant="ghost" onClick={reset} disabled={isPending}>
                  <X className="h-3.5 w-3.5" />
                  Choose a different file
                </Button>
              </div>
            </div>
          )}
        </div>
      </Dialog>

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) choose(f);
          e.target.value = "";
        }}
      />
    </>
  );
}
