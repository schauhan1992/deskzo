"use client";

import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { exportUnmaskEventsCsv, type UnmaskLogFilters, type UnmaskLogRow } from "@/actions/unmask-log";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionNotice } from "@/components/ui/action-notice";
import { useClock } from "@/components/time/clock-provider";
import { csvFilename } from "@/lib/csv";
import { SENSITIVE_FIELDS } from "@/lib/authz/field-policy";

const RESULT: Record<UnmaskLogRow["result"], { label: string; tone: "green" | "default" | "amber" | "red" }> = {
  ALLOWED: { label: "Unmasked", tone: "green" },
  REPEAT: { label: "Opened again", tone: "default" },
  QUOTA_EXHAUSTED: { label: "Limit reached", tone: "amber" },
  DENIED: { label: "Refused", tone: "red" },
};

const FIELD_LABELS = new Map(SENSITIVE_FIELDS.map((f) => [f.key, f.label]));
const fieldLabel = (key: string) => FIELD_LABELS.get(key) ?? (key.startsWith("custom:") ? key.slice("custom:".length) : key);

/** The log's rows, and the export of everything the filters match. */
export function UnmaskLogTable({ rows, filters, total }: { rows: UnmaskLogRow[]; filters: UnmaskLogFilters; total: number }) {
  const clock = useClock();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  const exportCsv = () =>
    start(async () => {
      setNotice(null);
      const result = await exportUnmaskEventsCsv(filters);
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      const blob = new Blob([result.data.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = csvFilename("unmasking-logs", new Date(), clock);
      a.click();
      URL.revokeObjectURL(url);
      if (result.data.capped) setNotice({ tone: "info", text: `The file holds the newest ${result.data.rows.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")} — narrow the dates for the rest.` });
    });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <p className="text-sm text-muted">{total === 1 ? "1 attempt" : `${total.toLocaleString("en-IN")} attempts`}</p>
        <Button variant="secondary" size="sm" onClick={exportCsv} disabled={pending || total === 0}>
          <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {pending ? "Exporting…" : "Export CSV"}
        </Button>
      </div>
      {notice && (
        <div className="px-4 pt-3">
          <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">When</th>
              <th className="px-4 py-2.5">Who</th>
              <th className="px-4 py-2.5">Lead</th>
              <th className="px-4 py-2.5">Fields</th>
              <th className="px-4 py-2.5">Result</th>
              <th className="px-4 py-2.5">Used today</th>
              <th className="px-4 py-2.5">Address</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line align-top last:border-0">
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                  {clock.dateTime(new Date(r.at))}
                  <span className="block text-[11px] text-subtle">Business day {r.businessDate}</span>
                </td>
                <td className="px-4 py-2.5 text-text">
                  {r.userName}
                  {r.impersonatedBy && <span className="block text-[11px] text-subtle">viewed as by {r.impersonatedBy}</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted">{r.leadRef ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted">{r.fields.map(fieldLabel).join(", ") || "—"}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={RESULT[r.result].tone}>{RESULT[r.result].label}</Badge>
                  {r.reason && <span className="mt-1 block text-[11px] text-subtle">{r.reason}</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                  {r.usedToday === null ? "—" : r.dailyLimit === null ? `${r.usedToday}` : `${r.usedToday} / ${r.dailyLimit}`}
                  {r.consumed && <span className="block text-[11px] text-subtle">used a unit</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-subtle">
                  {r.ip ?? "—"}
                  {r.requestId && <span className="block font-mono">{r.requestId.slice(0, 8)}</span>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-subtle">
                  No unmasking attempts match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
