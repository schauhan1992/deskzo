"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Eye, Download } from "lucide-react";
import type { ActivityRow } from "@/actions/activity";
import { exportActivity, type ActivityFilters } from "@/actions/activity";
import { activityKind, SEVERITY_TONE } from "@/lib/security/activity-kinds";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useClock } from "@/components/time/clock-provider";
import { csvFilename } from "@/lib/csv";
import { MONTH_NAMES, type Clock } from "@/lib/time/zone";

/**
 * The log itself.
 *
 * One row per event, expandable to the detail — address, agent, and whatever the call site put in
 * `metadata`. Collapsed by default because the summary sentence is written to be enough on its own;
 * the row underneath is for when it isn't.
 */

/** "02 Oct 26, 06:30:45 pm" on the workspace's clock — to the second, which a security log is read by. */
function when(value: Date | string, clock: Clock) {
  const p = clock.parts(new Date(value));
  const two = (n: number) => String(n).padStart(2, "0");
  const hour = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${two(p.day)} ${MONTH_NAMES[p.month]} ${two(p.year % 100)}, ${two(hour)}:${two(p.minute)}:${two(p.second)} ${p.hour < 12 ? "am" : "pm"}`;
}

function Detail({ row }: { row: ActivityRow }) {
  const entries: [string, string][] = [];
  if (row.path) entries.push(["Page", row.path]);
  if (row.ipAddress) entries.push(["Address", row.ipAddress]);
  if (row.userAgent) entries.push(["Browser", row.userAgent]);
  if (row.userEmail) entries.push(["Account", row.userEmail]);
  if (row.impersonatedBy) entries.push(["Really at the keyboard", row.impersonatedBy.name]);

  const meta = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : null;

  return (
    <tr className="border-b border-line bg-surface-sunken last:border-0">
      <td colSpan={5} className="px-4 py-3">
        <div className="grid grid-cols-1 gap-x-8 gap-y-1.5 text-xs sm:grid-cols-2">
          {entries.map(([label, value]) => (
            <div key={label} className="flex gap-2">
              <span className="w-40 shrink-0 text-subtle">{label}</span>
              <span className="min-w-0 break-words font-mono text-muted">{value}</span>
            </div>
          ))}
          {meta &&
            Object.entries(meta).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <span className="w-40 shrink-0 text-subtle">{key}</span>
                <span className="min-w-0 break-words font-mono text-muted">
                  {typeof value === "object" ? JSON.stringify(value) : String(value)}
                </span>
              </div>
            ))}
        </div>
        <p className="mt-2 text-xs text-subtle">{activityKind(row.kind).description}</p>
        {row.entityType && row.entityId && (
          // Per-record history without a per-record page: the same table, filtered to one subject.
          <Link
            href={`/activity?entityType=${encodeURIComponent(row.entityType)}&entityId=${encodeURIComponent(row.entityId)}`}
            className="mt-2 inline-block text-xs font-medium text-brand hover:underline"
          >
            Everything that happened to this {row.entityType.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()} →
          </Link>
        )}
      </td>
    </tr>
  );
}

export function ActivityTable({
  rows,
  filters,
  canExport,
  scoped,
}: {
  rows: ActivityRow[];
  filters: ActivityFilters;
  canExport: boolean;
  scoped: boolean;
}) {
  const clock = useClock();
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function download() {
    setExporting(true);
    setExportError(null);
    const result = await exportActivity(filters);
    setExporting(false);
    if (!result.ok) {
      setExportError(result.error);
      return;
    }
    const blob = new Blob([result.data.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = csvFilename("activity-log", new Date(), clock);
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      {scoped && (
        <p className="rounded-md bg-info-bg px-3 py-2 text-sm text-info">
          You are seeing your own activity. Seeing everyone&rsquo;s needs the &ldquo;See everyone&rsquo;s activity
          log&rdquo; permission — which is deliberately narrow, because who looked at which customer is easy to misuse.
        </p>
      )}

      {canExport && (
        <div className="flex items-center justify-end gap-3">
          {exportError && <p className="text-sm text-danger">{exportError}</p>}
          <Button type="button" variant="secondary" size="sm" onClick={download} disabled={exporting}>
            <Download className="h-3.5 w-3.5" />
            {exporting ? "Preparing…" : "Export these rows"}
          </Button>
        </div>
      )}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="w-8 px-4 py-2.5" />
                <th className="px-4 py-2.5">When</th>
                <th className="px-4 py-2.5">Who</th>
                <th className="px-4 py-2.5">What happened</th>
                <th className="px-4 py-2.5">Event</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const definition = activityKind(row.kind);
                const expanded = open === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr
                      className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-sunken"
                      onClick={() => setOpen(expanded ? null : row.id)}
                    >
                      <td className="px-4 py-2.5 text-subtle">
                        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted">
                        {when(row.createdAt, clock)}
                      </td>
                      <td className="px-4 py-2.5">
                        {row.userId ? (
                          <Link
                            href={`/activity?userId=${row.userId}`}
                            className="font-medium text-text hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {row.userName ?? row.user?.name ?? "—"}
                          </Link>
                        ) : (
                          // A row with no user is not a gap — it is a blocked crawler or a sign-in
                          // against an address that is not an account, and that is the finding.
                          <span className="text-subtle">{row.userName ?? "Not signed in"}</span>
                        )}
                        {row.impersonatedBy && (
                          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-warning">
                            <Eye className="h-3 w-3" />
                            via {row.impersonatedBy.name}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-text">{row.summary}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={SEVERITY_TONE[row.severity]}>{definition.label}</Badge>
                      </td>
                    </tr>
                    {expanded && <Detail row={row} />}
                  </Fragment>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-subtle">
                    Nothing matches these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
