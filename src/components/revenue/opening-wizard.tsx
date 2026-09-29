"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { openingCandidates, postOpening, previewOpening } from "@/actions/revenue";
import type { OpeningCandidate, OpeningPreviewLine } from "@/lib/revenue/opening";
import { addMonths, dayLabel, lastDay, monthLabel } from "@/lib/revenue/periods";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { periodText } from "@/components/revenue/labels";

/** What somebody has said about one candidate line: whether it is in, and the period it covered. */
export type OpeningChoice = { on: boolean; from: string; to: string };
type Preview = { asAt: string; lines: OpeningPreviewLine[]; total: number };
type Posted = { entryNumber: string; schedules: number; total: number };

const STEPS = ["Month end", "Lines and periods", "Preview", "Posted"] as const;

/**
 * "Open deferred revenue as at <month end>" (spec §3.7, D4).
 *
 * Invoices issued before the add-on booked all their revenue to Sales, and nothing restates them on
 * its own. This walks somebody through doing it once, deliberately: pick an open month end, tick the
 * service and subscription lines that were really for a period and say what period, see what is still
 * unearned at that date, and post it — one adjusting entry, Dr Sales / Cr Deferred Revenue, and a
 * schedule per line that recognises the rest from the following month. Those schedules were made by
 * hand, so a second person approves them before they recognise anything (D2).
 */
export function OpeningWizard({ openMonths }: { openMonths: string[] }) {
  const router = useRouter();
  const monthId = useId();
  const [step, setStep] = useState(0);
  const [asAt, setAsAt] = useState(openMonths[0] ?? "");
  const [candidates, setCandidates] = useState<OpeningCandidate[]>([]);
  const [choices, setChoices] = useState<Record<string, OpeningChoice>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [posted, setPosted] = useState<Posted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const chosen = Object.entries(choices).filter(([, c]) => c.on);

  function listInvoices() {
    setError(null);
    startTransition(async () => {
      const result = await openingCandidates({ asAt });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCandidates(result.data);
      setChoices(
        Object.fromEntries(result.data.flatMap((doc) => doc.lines.map((l) => [l.lineId, { on: false, from: l.from ?? "", to: l.to ?? "" }]))),
      );
      setStep(1);
    });
  }

  function showPreview() {
    setError(null);
    const missing = chosen.find(([, c]) => !c.from || !c.to);
    if (missing) {
      setError("Enter the service period — both dates — for every line you ticked.");
      return;
    }
    const backwards = chosen.find(([, c]) => c.to < c.from);
    if (backwards) {
      setError("A service period can't end before it starts.");
      return;
    }
    startTransition(async () => {
      const result = await previewOpening({ asAt, lines: chosen.map(([lineId, c]) => ({ lineId, from: c.from, to: c.to })) });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result.data);
      setStep(2);
    });
  }

  function post() {
    setError(null);
    startTransition(async () => {
      const result = await postOpening({ asAt, lines: chosen.map(([lineId, c]) => ({ lineId, from: c.from, to: c.to })) });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPosted(result.data);
      setStep(3);
      router.refresh();
    });
  }

  function startOver() {
    setStep(0);
    setCandidates([]);
    setChoices({});
    setPreview(null);
    setPosted(null);
    setError(null);
  }

  return (
    <Card>
      <CardHeader className="space-y-2">
        <h2 className="text-sm font-medium text-text">Open deferred revenue</h2>
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Steps">
          {STEPS.map((label, i) => (
            <li key={label} aria-current={i === step ? "step" : undefined} className={i === step ? "font-semibold text-text" : i < step ? "text-success" : "text-subtle"}>
              {i + 1}. {label}
            </li>
          ))}
        </ol>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p role="alert" className="rounded-lg border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        {step === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Invoices issued before Revenue &amp; Close booked all their revenue to Sales. For each service or subscription
              line that was really for a period, the part not yet earned at a month end can be moved to Deferred Revenue
              and recognised from the next month. Nothing is changed until you post it, and the schedules it makes wait
              for a second person to approve them.
            </p>
            {openMonths.length === 0 ? (
              <p className="text-sm text-warning">
                Every recent month end is closed, so there is nowhere to open deferred revenue. Reopen the month on Close
                the Books first.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1.5">
                  <label htmlFor={monthId} className="text-[13px] font-medium text-muted">
                    As at the end of
                  </label>
                  <Select id={monthId} value={asAt} onChange={(e) => setAsAt(e.target.value)} className="w-40">
                    {openMonths.map((m) => (
                      <option key={m} value={m}>
                        {monthLabel(m)}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button type="button" disabled={pending || !asAt} onClick={listInvoices}>
                  {pending ? "Looking…" : "List the invoices"}
                </Button>
              </div>
            )}
            <p className="text-xs text-subtle">Only month ends that have passed and whose books are still open are offered.</p>
          </div>
        )}

        {step === 1 && (
          <>
            <OpeningLinesStep
              asAt={asAt}
              candidates={candidates}
              choices={choices}
              onChange={(lineId, next) => setChoices((all) => ({ ...all, [lineId]: { ...all[lineId]!, ...next } }))}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={pending || chosen.length === 0} onClick={showPreview}>
                {pending ? "Working it out…" : `Preview ${chosen.length} line${chosen.length === 1 ? "" : "s"}`}
              </Button>
              <Button type="button" variant="secondary" onClick={startOver}>
                Back
              </Button>
            </div>
          </>
        )}

        {step === 2 && preview && (
          <>
            <OpeningPreviewStep preview={preview} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={pending || preview.lines.some((l) => l.problem) || preview.total <= 0} onClick={post}>
                {pending ? "Posting…" : `Post ${formatCurrency(preview.total)} as at ${dayLabel(lastDay(preview.asAt))}`}
              </Button>
              <Button type="button" variant="secondary" disabled={pending} onClick={() => setStep(1)}>
                Back to the lines
              </Button>
            </div>
          </>
        )}

        {step === 3 && posted && (
          <>
            <OpeningPostedStep asAt={asAt} posted={posted} />
            <Button type="button" variant="secondary" onClick={startOver}>
              Open another month
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Step 2: the candidate invoices, a tick per line, and the period each line covered (prefilled where the line has one). */
export function OpeningLinesStep({
  asAt,
  candidates,
  choices,
  onChange,
}: {
  asAt: string;
  candidates: OpeningCandidate[];
  choices: Record<string, OpeningChoice>;
  onChange: (lineId: string, next: Partial<OpeningChoice>) => void;
}) {
  if (candidates.length === 0) {
    return (
      <p className="rounded-lg border border-line bg-surface-sunken px-3 py-3 text-sm text-muted">
        No issued invoice from the 24 months to {dayLabel(lastDay(asAt))} has a service or subscription line without a
        schedule, so there is nothing to open. Choose an earlier month end, or check the items on those invoices are
        typed as services or subscriptions.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Tick the lines that were for a period of service, and enter that period. The part of it after{" "}
        {dayLabel(lastDay(asAt))} is what will move to Deferred Revenue.
      </p>
      {candidates.map((doc) => (
        <div key={doc.documentId} className="rounded-base border border-line">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-sunken px-3 py-2 text-sm">
            <Link href={`/documents/${doc.documentId}`} className="font-mono text-xs text-brand hover:underline">
              {doc.docNumber}
            </Link>
            <span className="text-text">{doc.companyName}</span>
            <span className="text-xs text-muted">Issued {dayLabel(doc.issueDate)}</span>
            {doc.currency !== "INR" && <Badge tone="blue">{doc.currency}, shown in rupees</Badge>}
          </div>
          <ul className="divide-y divide-line">
            {doc.lines.map((line) => {
              const choice = choices[line.lineId] ?? { on: false, from: line.from ?? "", to: line.to ?? "" };
              return (
                <li key={line.lineId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
                  <label className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={choice.on}
                      onChange={(e) => onChange(line.lineId, { on: e.target.checked })}
                    />
                    <span className="min-w-0">
                      <span className="block text-text">{line.name}</span>
                      <span className="block text-xs text-muted">
                        {formatCurrency(line.amount)}
                        {line.itemType ? ` · ${line.itemType === "SUBSCRIPTION" ? "Subscription" : "Service"}` : ""}
                        {line.from && line.to ? ` · on the invoice: ${periodText(line.from, line.to)}` : ""}
                      </span>
                    </span>
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="date"
                      aria-label={`Service period start — ${line.name}, ${doc.docNumber}`}
                      className="h-8 w-auto"
                      value={choice.from}
                      disabled={!choice.on}
                      onChange={(e) => onChange(line.lineId, { from: e.target.value })}
                    />
                    <span className="text-xs text-subtle">to</span>
                    <Input
                      type="date"
                      aria-label={`Service period end — ${line.name}, ${doc.docNumber}`}
                      className="h-8 w-auto"
                      value={choice.to}
                      disabled={!choice.on}
                      onChange={(e) => onChange(line.lineId, { to: e.target.value })}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Step 3: what each line would open with — the unearned part and its months — and the total, or why a line can't be opened. */
export function OpeningPreviewStep({ preview }: { preview: Preview }) {
  const problems = preview.lines.filter((l) => l.problem).length;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        As at {dayLabel(lastDay(preview.asAt))}: one entry, Dr Sales / Cr Deferred Revenue, for the total below, and a
        schedule per line recognising it from {monthLabel(addMonths(preview.asAt, 1))}. The schedules then wait for
        somebody else with Revenue &amp; Close management to approve them.
      </p>
      <div className="overflow-x-auto rounded-base border border-line">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">Opening deferred revenue preview</caption>
          <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-3 py-2">Invoice line</th>
              <th scope="col" className="px-3 py-2">Service period</th>
              <th scope="col" className="px-3 py-2 text-right">Line</th>
              <th scope="col" className="px-3 py-2 text-right">Unearned</th>
              <th scope="col" className="px-3 py-2 text-right">Months</th>
            </tr>
          </thead>
          <tbody>
            {preview.lines.map((l) => (
              <tr key={l.lineId} className="border-t border-line align-top">
                <td className="px-3 py-1.5">
                  <div className="text-text">{l.name ?? "—"}</div>
                  <div className="font-mono text-xs text-subtle">{l.docNumber ?? ""}</div>
                  {l.problem && <div className="text-xs font-medium text-danger">{l.problem}</div>}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-muted">{periodText(l.from, l.to)}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-muted">{formatCurrency(l.amount)}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-text">{l.problem ? "—" : formatCurrency(l.unearned)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted">{l.problem ? "—" : l.months.length}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong">
              <td colSpan={3} className="px-3 py-2 font-semibold text-text">
                Total to defer
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums text-text">{formatCurrency(preview.total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {problems > 0 && (
        <p className="text-sm text-danger">
          {problems} line{problems === 1 ? "" : "s"} can&apos;t be opened as entered. Go back and correct the period, or untick
          {problems === 1 ? " it" : " them"}: nothing is posted while any line is refused.
        </p>
      )}
    </div>
  );
}

/** Step 4: what was posted, and where the schedules are waiting. */
export function OpeningPostedStep({ asAt, posted }: { asAt: string; posted: Posted }) {
  return (
    <div role="status" className="space-y-2 rounded-lg border border-success/40 bg-success-bg px-3 py-3 text-sm text-success">
      <p className="font-medium">
        Opened {formatCurrency(posted.total)} of deferred revenue as at {dayLabel(lastDay(asAt))} in{" "}
        <Link href={`/accounting/journal?q=${encodeURIComponent(posted.entryNumber)}`} className="font-mono underline">
          {posted.entryNumber}
        </Link>
        .
      </p>
      <p>
        {posted.schedules} schedule{posted.schedules === 1 ? " waits" : "s wait"} for approval by somebody else with Revenue
        &amp; Close management, and recognise{posted.schedules === 1 ? "s" : ""} nothing until then.{" "}
        <Link href="/accounting/revenue?tab=review" className="font-medium underline">
          Review queue
        </Link>
      </p>
    </div>
  );
}
