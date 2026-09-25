"use client";

import { Fragment, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import type { FormAttendance } from "@prisma/client";
import { exportFormResponses, markAttendance } from "@/actions/forms";
import { formatAnswer, isReserved, questionsOf, type FormField } from "@/lib/marketing/form-fields";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionNotice } from "@/components/ui/action-notice";
import { cn } from "@/lib/utils";

export type ResponseRow = {
  id: string;
  /** Written out on the server, in India time. */
  answeredAt: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  company: { id: string; name: string } | null;
  lead: { id: string; title: string } | null;
  attending: boolean | null;
  attendance: FormAttendance | null;
  viaInvite: boolean;
  recordedBy: { name: string } | null;
  attendanceMarkedBy: { name: string } | null;
  answers: Record<string, string>;
  retired: { key: string; value: string }[];
};

/**
 * What people answered, one row each, opening to every answer.
 *
 * Only the first few custom questions are columns: a requirement assessment has fifteen, and a table
 * fifteen columns wide is one nobody reads on a laptop, let alone a phone. The row opens to all of
 * them, and the export has every one.
 *
 * On an event the row also carries the register — came, didn't — for whoever is at the door.
 */
export function ResponseTable({
  formId,
  fields,
  rows,
  event,
}: {
  formId: string;
  fields: FormField[];
  rows: ResponseRow[];
  event: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const custom = questionsOf(fields).filter((f) => !isReserved(f.key));
  const columns = custom.slice(0, event ? 1 : 2);

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const mark = (id: string, value: FormAttendance | null) => {
    setError(null);
    startTransition(async () => {
      const result = await markAttendance(id, value);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  };

  const download = () => {
    setError(null);
    startTransition(async () => {
      const result = await exportFormResponses(formId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // A byte-order mark so Excel reads the rupee sign and the names as UTF-8, not as mojibake.
      const blob = new Blob([String.fromCharCode(0xfeff), result.data.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.data.filename;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={download} disabled={pending}>
          <Download className="h-3.5 w-3.5" />
          Export all to CSV
        </Button>
      </div>
      {error && <ActionNotice tone="error">{error}</ActionNotice>}

      {rows.length === 0 ? (
        <Card className="px-4 py-12 text-center text-sm text-subtle">No answers match that.</Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="w-8 px-3 py-2" />
                <th className="px-3 py-2 font-medium">Who</th>
                {event && <th className="px-3 py-2 font-medium">RSVP</th>}
                {event && <th className="px-3 py-2 font-medium">On the day</th>}
                {columns.map((f) => (
                  <th key={f.key} className="px-3 py-2 font-medium">
                    {f.label}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Answered</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const expanded = open.has(row.id);
                return (
                  <Fragment key={row.id}>
                    <tr className={cn("border-b border-line align-top", expanded && "bg-surface-sunken/60")}>
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={expanded ? "Hide answers" : "Show every answer"}
                          onClick={() => toggle(row.id)}
                          className="rounded p-0.5 text-muted hover:text-text"
                        >
                          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-text">{row.name ?? "—"}</div>
                        <div className="text-xs text-muted">
                          {row.company ? (
                            <Link href={`/companies/${row.company.id}`} className="hover:underline">
                              {row.company.name}
                            </Link>
                          ) : (
                            (row.companyName ?? "")
                          )}
                          {row.email && <span className="text-subtle"> · {row.email}</span>}
                        </div>
                      </td>
                      {event && (
                        <td className="px-3 py-2.5">
                          {row.attending === false ? <Badge tone="amber">Can&apos;t make it</Badge> : <Badge tone="green">Coming</Badge>}
                        </td>
                      )}
                      {event && (
                        <td className="px-3 py-2.5">
                          {row.attending === false ? (
                            <span className="text-xs text-subtle">—</span>
                          ) : (
                            <div className="flex gap-1">
                              {(
                                [
                                  ["ATTENDED", "Came"],
                                  ["NO_SHOW", "No-show"],
                                ] as const
                              ).map(([value, label]) => (
                                <button
                                  key={value}
                                  type="button"
                                  disabled={pending}
                                  aria-pressed={row.attendance === value}
                                  onClick={() => mark(row.id, row.attendance === value ? null : value)}
                                  className={cn(
                                    "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                                    row.attendance === value
                                      ? value === "ATTENDED"
                                        ? "border-transparent bg-success-bg text-success"
                                        : "border-transparent bg-danger-bg text-danger"
                                      : "border-line text-muted hover:bg-surface-sunken",
                                  )}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      )}
                      {columns.map((f) => (
                        <td key={f.key} className="max-w-[16rem] truncate px-3 py-2.5 text-muted" title={formatAnswer(f, row.answers[f.key])}>
                          {formatAnswer(f, row.answers[f.key]) || <span className="text-subtle">—</span>}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-3 py-2.5 text-right text-xs text-muted">
                        {row.answeredAt}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-line bg-surface-sunken/60">
                        <td />
                        <td colSpan={2 + (event ? 2 : 0) + columns.length - 1} className="px-3 pb-4 pt-1">
                          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                            {row.phone && <Answer label="Phone" value={row.phone} />}
                            {custom.map((f) => (
                              <Answer key={f.key} label={f.label} value={formatAnswer(f, row.answers[f.key])} />
                            ))}
                            {row.retired.map((r) => (
                              <Answer key={r.key} label={`${r.key} (no longer asked)`} value={r.value} />
                            ))}
                          </dl>
                          <p className="mt-3 text-[11px] text-subtle">
                            {row.recordedBy
                              ? `Recorded by ${row.recordedBy.name}.`
                              : row.viaInvite
                                ? "Answered from their invitation."
                                : "Answered on the public link."}
                            {row.attendanceMarkedBy && ` Attendance marked by ${row.attendanceMarkedBy.name}.`}
                            {row.lead && (
                              <>
                                {" "}
                                Lead:{" "}
                                <Link href={`/leads/${row.lead.id}`} className="underline">
                                  {row.lead.title}
                                </Link>
                              </>
                            )}
                          </p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Answer({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-subtle">{label}</dt>
      <dd className={cn("whitespace-pre-line break-words text-sm", value ? "text-text" : "text-subtle")}>{value || "Not answered"}</dd>
    </div>
  );
}
