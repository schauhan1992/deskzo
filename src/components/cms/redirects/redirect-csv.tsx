"use client";

import { useId, useRef, useState, useTransition, type ChangeEvent } from "react";
import { CircleCheck, Download, LoaderCircle, Upload } from "lucide-react";
import { cmsExportRedirects, cmsImportRedirects, cmsPreviewRedirectImport } from "@/actions/cms/redirects";
import { useConsoleNotice } from "@/components/console/kit/notice";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { ActionNotice, ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import type { Tone } from "@/lib/console-shared/types";
import { REDIRECT_IMPORT_MAX_ROWS, type RedirectImportResult, type RedirectImportRow } from "@/lib/cms/types";

/**
 * Redirects in and out as CSV — columns from, to, status, match, note.
 *
 *   · Export: every redirect, built by the server (guarded against spreadsheet formulas) and handed to
 *     the browser as a file; there is no download address to share.
 *   · Import: choose a file (at most 1,000 rows), see what each row would do — create, update, leave
 *     unchanged, or refuse and why — then import. Refused rows are skipped; nothing is written until
 *     "Import". The server checks the whole file again then, loops and chains included.
 */

/** A byte-order mark, built from its code: Excel then reads the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);
const MAX_CHARS = 1_000_000;

function safeFilename(name: string): string {
  const base = String(name ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, 120);
  if (!base) return "redirects.csv";
  return /\.csv$/i.test(base) ? base : `${base}.csv`;
}

export function ExportRedirectsButton() {
  const { show } = useConsoleNotice();
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);

  const onClick = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    startTransition(async () => {
      try {
        const result = await cmsExportRedirects();
        if (!result.ok) {
          show("error", result.error);
          return;
        }
        if (result.data.rows === 0) {
          show("info", "Nothing to export — there are no redirects yet.");
          return;
        }
        const blob = new Blob([BOM + result.data.csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = safeFilename(result.data.filename);
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
        show("success", `Exported ${result.data.rows.toLocaleString("en-IN")} ${result.data.rows === 1 ? "redirect" : "redirects"}.`);
      } catch {
        show("error", "The export didn't finish. Try again.");
      } finally {
        inFlight.current = false;
      }
    });
  };

  return (
    <Button type="button" variant="secondary" size="sm" onClick={onClick} aria-disabled={pending || undefined} aria-busy={pending || undefined} className={pending ? "cursor-wait opacity-70" : undefined}>
      {pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Download aria-hidden="true" className="h-4 w-4" />}
      Export CSV
    </Button>
  );
}

export function ImportRedirectsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Upload aria-hidden="true" className="h-4 w-4" />
        Import CSV
      </Button>
      {open && <ImportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

const OUTCOMES: Record<RedirectImportRow["outcome"], { label: string; tone: Tone }> = {
  create: { label: "New", tone: "success" },
  update: { label: "Update", tone: "info" },
  unchanged: { label: "Unchanged", tone: "neutral" },
  refuse: { label: "Refused", tone: "danger" },
};

type Filter = "all" | RedirectImportRow["outcome"];

function ImportDialog({ onClose }: { onClose: () => void }) {
  const fileId = useId();
  const filterId = useId();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const preview = useCmsAction<RedirectImportResult>();
  const apply = useCmsAction<RedirectImportResult>();
  const [plan, setPlan] = useState<RedirectImportResult | null>(null);
  const [applied, setApplied] = useState<RedirectImportResult | null>(null);
  const busy = preview.pending || apply.pending;
  const close = () => {
    if (!busy) onClose();
  };

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const chosen = e.target.files?.[0];
    setPlan(null);
    setApplied(null);
    setReadError(null);
    setFilter("all");
    preview.reset();
    apply.reset();
    if (!chosen) {
      setFile(null);
      return;
    }
    if (chosen.size > MAX_CHARS * 4) {
      setFile(null);
      setReadError(`That file is too big: at most ${REDIRECT_IMPORT_MAX_ROWS.toLocaleString("en-IN")} redirects in one file.`);
      return;
    }
    let text: string;
    try {
      text = await chosen.text();
    } catch {
      setFile(null);
      setReadError("That file couldn't be read. Choose it again.");
      return;
    }
    if (text.length > MAX_CHARS) {
      setFile(null);
      setReadError(`That file is too big: at most ${REDIRECT_IMPORT_MAX_ROWS.toLocaleString("en-IN")} redirects in one file.`);
      return;
    }
    setFile({ name: chosen.name, text });
    preview.run(() => cmsPreviewRedirectImport(text), { refresh: false, onDone: setPlan });
  }

  const shownPlan = applied ?? plan;
  const toApply = plan ? plan.counts.create + plan.counts.update : 0;
  const rows = shownPlan ? shownPlan.rows.filter((r) => filter === "all" || r.outcome === filter) : [];

  return (
    <Dialog open onClose={close} title={applied ? "Redirects imported" : "Import redirects from CSV"} large>
      <div className="space-y-4 p-0.5">
        {!applied && (
          <>
            <div className="space-y-1 text-sm text-muted">
              <p>
                One redirect a row, with a header row naming the columns: <span className="font-mono text-text">from, to, status, match, note</span>. Only{" "}
                <span className="font-mono text-text">from</span> and <span className="font-mono text-text">to</span> are needed; status is 301 unless given, and match is{" "}
                <span className="font-mono text-text">exact</span> or <span className="font-mono text-text">prefix</span>.
              </p>
              <p className="text-xs">{`At most ${REDIRECT_IMPORT_MAX_ROWS.toLocaleString("en-IN")} rows. A row for an address that already has a redirect updates it. An export from here imports back unchanged.`}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={fileId}>CSV file</Label>
              <input
                id={fileId}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void onFile(e)}
                disabled={busy}
                className="block w-full text-sm text-muted file:mr-3 file:h-8 file:rounded-base file:border file:border-line-strong file:bg-surface file:px-3 file:text-[13px] file:font-medium file:text-text hover:file:bg-surface-sunken"
              />
            </div>
          </>
        )}

        {readError && <ActionNotice tone="error">{readError}</ActionNotice>}
        <ActionNoticeRegion notice={preview.error ? { tone: "error", message: preview.error } : apply.error ? { tone: "error", message: apply.error } : null} />
        {preview.pending && (
          <p className="inline-flex items-center gap-1.5 text-sm text-muted" aria-live="polite">
            <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
            Reading {file?.name ?? "the file"}…
          </p>
        )}

        {applied && (
          <p className="flex items-start gap-2 text-sm text-text">
            <CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <span>
              {`Imported from ${file?.name ?? "the file"}: ${applied.counts.create.toLocaleString("en-IN")} new, ${applied.counts.update.toLocaleString("en-IN")} updated.`}
              {applied.counts.refuse ? ` ${applied.counts.refuse.toLocaleString("en-IN")} refused rows were skipped.` : ""}
            </span>
          </p>
        )}

        {shownPlan && (
          <section aria-label={applied ? "What was imported" : "What importing would do"} className="space-y-3">
            <ul className="flex flex-wrap gap-2" aria-label="Rows by outcome">
              {(Object.keys(OUTCOMES) as RedirectImportRow["outcome"][]).map((key) => (
                <li key={key}>
                  <StatusPill tone={OUTCOMES[key].tone}>{`${OUTCOMES[key].label}: ${shownPlan.counts[key].toLocaleString("en-IN")}`}</StatusPill>
                </li>
              ))}
            </ul>
            {shownPlan.rows.length > 0 && (
              <div className="flex items-center gap-2">
                <Label htmlFor={filterId}>Show</Label>
                <Select id={filterId} value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="h-8 w-auto">
                  <option value="all">Every row ({shownPlan.rows.length.toLocaleString("en-IN")})</option>
                  {(Object.keys(OUTCOMES) as RedirectImportRow["outcome"][]).map((key) => (
                    <option key={key} value={key}>
                      {`${OUTCOMES[key].label} (${shownPlan.counts[key].toLocaleString("en-IN")})`}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {rows.length > 0 && (
              <div className="max-h-80 overflow-y-auto rounded-lg border border-line">
                <DataTable caption="Rows of the file" minWidth={640}>
                  <THead>
                    <Th numeric>Line</Th>
                    <Th>From</Th>
                    <Th>To</Th>
                    <Th>Outcome</Th>
                  </THead>
                  <TBody>
                    {rows.map((r) => (
                      <Tr key={r.line}>
                        <Td numeric muted className="align-top">
                          {r.line}
                        </Td>
                        <Td className="align-top">
                          <span className="font-mono text-xs break-all">{r.from || "—"}</span>
                        </Td>
                        <Td className="align-top">
                          <span className="font-mono text-xs break-all">{r.to || "—"}</span>
                          {r.outcome !== "refuse" && (r.status || r.match) && (
                            <span className="block text-[11px] text-subtle">{[r.status, r.match === "PREFIX" ? "everything under it" : null].filter(Boolean).join(" · ")}</span>
                          )}
                        </Td>
                        <Td className="align-top">
                          <StatusPill tone={OUTCOMES[r.outcome].tone}>{OUTCOMES[r.outcome].label}</StatusPill>
                          {r.reason && <p className="mt-1 max-w-xs text-xs text-danger">{r.reason}</p>}
                        </Td>
                      </Tr>
                    ))}
                  </TBody>
                </DataTable>
              </div>
            )}
          </section>
        )}

        <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
          {applied ? (
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="secondary" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!plan || toApply === 0 || preview.pending}
                aria-disabled={apply.pending || undefined}
                aria-busy={apply.pending || undefined}
                className={apply.pending ? "cursor-wait opacity-70" : undefined}
                onClick={() => {
                  if (!file || !plan || apply.pending) return;
                  apply.run(() => cmsImportRedirects(file.text), {
                    success: (r) => `Imported redirects: ${r.counts.create.toLocaleString("en-IN")} new, ${r.counts.update.toLocaleString("en-IN")} updated.`,
                    onDone: setApplied,
                  });
                }}
              >
                {apply.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
                {plan && toApply > 0 ? `Import ${toApply.toLocaleString("en-IN")} ${toApply === 1 ? "redirect" : "redirects"}` : "Import"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
