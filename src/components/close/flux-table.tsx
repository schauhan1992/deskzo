"use client";

import { Fragment, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Flag } from "lucide-react";
import type { getFlux } from "@/actions/close";
import { explainFlux } from "@/actions/close";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/input";
import { FLUX_NOTE_MAX } from "@/lib/close/catalogue";
import { changeText, dayLong, fluxReason, rupees, rupeesShort } from "@/components/close/format";

type FluxReport = NonNullable<Awaited<ReturnType<typeof getFlux>>>;
type FluxRow = FluxReport["rows"][number];

/**
 * Flux: every account this month against last month and the same month last year, the large moves
 * flagged, and a place to say why each one moved.
 *
 * The profit and loss compares the month's movement; the balance sheet compares closing balances. A
 * row is flagged when its change against last month clears both thresholds in the close settings —
 * and the month's "changes explained" task passes once every flagged row has its explanation.
 */
export function FluxTable({
  report,
  canExplain,
  closed,
  canChangeThresholds,
}: {
  report: FluxReport;
  canExplain: boolean;
  closed: boolean;
  canChangeThresholds: boolean;
}) {
  const [show, setShow] = useState<"flagged" | "all">(report.flagged > 0 ? "flagged" : "all");
  const withFigures = report.rows.filter(
    (r) => Math.abs(r.current) >= 0.005 || Math.abs(r.previous) >= 0.005 || Math.abs(r.lastYear) >= 0.005 || r.note,
  );
  const rows = show === "flagged" ? withFigures.filter((r) => r.flagged || r.note) : withFigures;
  const groups = [
    { key: "PL", title: "Profit & loss", hint: "the month's movement", rows: rows.filter((r) => r.statement === "PL") },
    { key: "BS", title: "Balance sheet", hint: "the closing balance", rows: rows.filter((r) => r.statement === "BS") },
  ].filter((g) => g.rows.length > 0);
  const { percent, amount } = report.thresholds;
  const showId = "flux-show";

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-text">
              <span className="font-medium">{report.flagged}</span> flagged ·{" "}
              <span className="font-medium">{report.explained}</span> explained
              {report.flagged > report.explained && (
                <span className="text-warning"> · {report.flagged - report.explained} still to explain</span>
              )}
            </p>
            <p className="text-xs text-subtle">
              Flagged when the change against last month is at least {percent.toLocaleString("en-IN")}% and at least{" "}
              {rupeesShort(amount)} — both.{" "}
              {canChangeThresholds ? (
                <Link href="/settings/revenue-close" className="text-brand hover:underline">
                  Change the thresholds
                </Link>
              ) : (
                "The thresholds are in the close settings."
              )}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={showId}>Show</Label>
            <Select id={showId} value={show} onChange={(e) => setShow(e.target.value as "flagged" | "all")} className="w-full sm:w-56">
              <option value="flagged">Flagged and explained</option>
              <option value="all">Every account with figures</option>
            </Select>
          </div>
        </CardContent>
      </Card>

      {groups.length === 0 ? (
        <Card className="px-6 py-10 text-center text-sm text-muted">
          {withFigures.length === 0
            ? `Nothing was posted in ${report.label}, the month before, or a year earlier — there is nothing to compare yet.`
            : `No account moved by both ${percent.toLocaleString("en-IN")}% and ${rupeesShort(amount)} in ${report.label}. Choose “Every account with figures” to see them all.`}
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.key} className="overflow-hidden p-0">
            <CardHeader className="text-sm font-medium text-text">
              {group.title} <span className="font-normal text-subtle">— {group.hint}</span>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-sm">
                <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5">Account</th>
                    <th scope="col" className="px-4 py-2.5 text-right">{report.label}</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Last month</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Change</th>
                    <th scope="col" className="px-4 py-2.5 text-right">A year earlier</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <Fragment key={row.accountId}>
                      <tr className={row.flagged || row.note ? "" : "border-b border-line"}>
                        <td className="px-4 py-2 align-top">
                          <span className="mr-2 whitespace-nowrap font-mono text-xs text-subtle">{row.code}</span>
                          <span className="text-text">{row.name}</span>
                          {!row.active && <span className="ml-1 text-xs text-subtle">(archived)</span>}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right align-top tabular-nums text-text">{rupees(row.current)}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-right align-top tabular-nums text-muted">{rupees(row.previous)}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-right align-top tabular-nums text-text">
                          {changeText(row.changePrev, row.changePrevPct)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right align-top tabular-nums text-muted">{rupees(row.lastYear)}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-right align-top tabular-nums text-muted">
                          {changeText(row.changeYear, row.changeYearPct)}
                        </td>
                      </tr>
                      {(row.flagged || row.note) && (
                        <tr className="border-b border-line">
                          <td colSpan={6} className="px-4 pb-3 pt-0">
                            <FluxExplanation monthKey={report.month} row={row} canExplain={canExplain && !closed} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

/** The flag, its reason, and the explanation — shown, or written by somebody who works the close. */
function FluxExplanation({ monthKey, row, canExplain }: { monthKey: string; row: FluxRow; canExplain: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(!row.note && canExplain);
  const [text, setText] = useState(row.note?.explanation ?? "");
  const [error, setError] = useState<string | null>(null);
  const fieldId = `flux-${row.accountId}`;

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await explainFlux(monthKey, row.accountId, text);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  return (
    // Held to the screen's width on a phone, so it wraps where it can be read rather than across the
    // whole scrolling table.
    <div className="max-w-[calc(100vw-5.5rem)] space-y-2 sm:max-w-3xl">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {row.flagged && (
          <Badge tone="amber">
            <Flag className="h-3 w-3" aria-hidden />
            Flagged
          </Badge>
        )}
        {row.flagged && <span className="text-muted">{fluxReason(row)}</span>}
        {row.note && (
          <Badge tone="green">
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            Explained
          </Badge>
        )}
      </div>
      {row.note && !editing && (
        <div className="space-y-0.5">
          <p className="whitespace-pre-wrap break-words text-sm text-text">{row.note.explanation}</p>
          <p className="text-xs text-subtle">
            — {row.note.byName}, {dayLong(row.note.at)}
            {canExplain && (
              <button type="button" onClick={() => setEditing(true)} className="ml-2 text-brand hover:underline">
                Edit
              </button>
            )}
          </p>
        </div>
      )}
      {!row.note && !canExplain && <p className="text-xs text-subtle">Not explained yet.</p>}
      {editing && canExplain && (
        <div className="space-y-1.5">
          <Label htmlFor={fieldId}>
            Why did {row.code} {row.name} move?
          </Label>
          <Textarea
            id={fieldId}
            value={text}
            maxLength={FLUX_NOTE_MAX}
            onChange={(e) => setText(e.target.value)}
            placeholder="Annual insurance renewed in September; the prepaid schedule spreads it from October"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={pending || !text.trim()} onClick={save}>
              {pending ? "Saving…" : "Save explanation"}
            </Button>
            {row.note && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
            <span className="text-xs text-subtle">
              {text.length.toLocaleString("en-IN")} / {FLUX_NOTE_MAX.toLocaleString("en-IN")}
            </span>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
