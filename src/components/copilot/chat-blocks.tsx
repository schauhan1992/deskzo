"use client";

import { useState, useTransition } from "react";
import { CheckSquare, Search, StickyNote } from "lucide-react";
import { ReportChart } from "@/components/reports/report-chart";
import { Button } from "@/components/ui/button";
import { confirmCopilotProposal, cancelCopilotProposal } from "@/actions/copilot";
import type { ActivityBlock, ProposalBlock, ReportBlock } from "@/lib/copilot/types";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

export function ActivityLine({ block }: { block: ActivityBlock }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-subtle">
      <Search className="h-3 w-3 shrink-0" aria-hidden="true" />
      {block.label}
    </p>
  );
}

/** A report, drawn the way the Reports page draws it. No download: the copilot doesn't export. */
export function ReportCard({ block }: { block: ReportBlock }) {
  const { result } = block;
  const format = (n: number) => (result.unit === "currency" ? inr.format(n) : result.unit === "days" ? `${n.toFixed(1)} d` : n.toLocaleString("en-IN"));
  const crossTab = result.columns.length > 1;
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? result.rows : result.rows.slice(0, 10);
  return (
    <div className="space-y-2 rounded-base border border-line bg-surface p-3">
      <div>
        <p className="text-[13px] font-semibold text-text">{block.title}</p>
        <p className="text-[11px] text-subtle">
          {block.measureLabel} · {block.averaged ? "average" : "total"} {format(result.grandTotal)} · {result.rowCount.toLocaleString("en-IN")} records
          {result.truncated ? " · capped, so a floor" : ""}
        </p>
      </div>
      {result.rows.length > 0 && (
        <div className="overflow-hidden rounded border border-line">
          <ReportChart result={result} type={crossTab ? "stacked" : "bar"} format={format} averaged={block.averaged} />
        </div>
      )}
      <table className="w-full text-[12px]">
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-line first:border-t-0">
              <td className="py-1 pr-2 text-text">{row.label}</td>
              <td className="py-1 text-right tabular-nums text-text">{format(row.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length > 10 && (
        <button type="button" className="text-[11px] text-muted underline underline-offset-2" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${result.rows.length}`}
        </button>
      )}
      <p className="text-[10px] text-subtle">{result.scopeNote}</p>
    </div>
  );
}

/** A task or note the copilot drafted — nothing exists until this is pressed. */
export function ProposalCard({ block, onChange }: { block: ProposalBlock; onChange: (next: ProposalBlock) => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const noun = block.kind === "TASK" ? "task" : "note";
  const status = block.status ?? "PENDING";

  function act(confirm: boolean) {
    setError(null);
    startTransition(async () => {
      const r = confirm ? await confirmCopilotProposal(block.id) : await cancelCopilotProposal(block.id);
      if (!r.ok) {
        setError(r.error);
        if (confirm) onChange({ ...block, status: "FAILED", error: r.error });
        return;
      }
      onChange({ ...block, status: confirm ? "DONE" : "CANCELLED" });
    });
  }

  return (
    <div className="space-y-2 rounded-base border border-brand/30 bg-brand-subtle/40 p-3">
      <p className="flex items-start gap-2 text-[13px] text-text">
        {block.kind === "TASK" ? <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" /> : <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />}
        <span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{block.kind === "TASK" ? "New task" : "New note"}</span>
          <br />
          {block.summary}
        </span>
      </p>
      {status === "PENDING" ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={pending} onClick={() => act(true)}>
            {pending ? "Saving…" : block.kind === "TASK" ? "Create task" : "Save note"}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <p className={`text-[12px] ${status === "DONE" ? "text-success" : status === "FAILED" ? "text-danger" : "text-subtle"}`}>
          {status === "DONE" ? `✓ ${noun === "task" ? "Task created" : "Note saved"}` : status === "FAILED" ? `Couldn't save: ${block.error ?? error ?? ""}` : "Cancelled"}
        </p>
      )}
      {error && status === "PENDING" && <p className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
