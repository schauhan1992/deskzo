import Link from "next/link";
import { AlertTriangle, ArrowUpRight, CheckCircle2 } from "lucide-react";
import type { CheckDetail, DetailItem } from "@/lib/close/checks";
import type { TieOutDetail } from "@/lib/close/tieout";
import { cn } from "@/lib/utils";
import { dayLong, rupees } from "@/components/close/format";

/**
 * What an automatic check found, written for people: the figures it counted and the records at fault,
 * each linked to where it is put right.
 *
 * The check stores its findings on the task (`autoDetail`, src/lib/close/checks.ts); this only reads
 * them. No hooks, so the checklist (a client component) and the checks' render tests share it.
 */

/** A check that couldn't run stores this instead. */
type CheckError = { key: string; summary: string; error: true };

export type AnyCheckDetail = CheckDetail | TieOutDetail | CheckError;

/** The detail a task carries, if it looks like one — `autoDetail` is JSON, so it is checked, not trusted. */
export function asCheckDetail(value: unknown): AnyCheckDetail | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== "string" || typeof v.summary !== "string") return null;
  return v as unknown as AnyCheckDetail;
}

function isError(d: AnyCheckDetail): d is CheckError {
  return (d as CheckError).error === true;
}

function isTieOut(d: AnyCheckDetail): d is TieOutDetail {
  return (d.key === "ar-ties" || d.key === "ap-ties") && typeof (d as TieOutDetail).difference === "number" && !!(d as TieOutDetail).causes;
}

/** The figures each check counts, in words. A figure whose key ends in "Amount" is rupees. */
const NUMBER_LABELS: Record<string, Record<string, string>> = {
  "bank-reconciled": { accounts: "Active bank accounts", unreconciled: "Not reconciled" },
  "invoices-issued": { drafts: "Draft invoices" },
  "revenue-recognised": { unpostedSchedules: "Schedules behind", unpostedAmount: "Not yet recognised", pendingApproval: "Waiting for approval" },
  "schedules-posted": {
    unpostedLines: "Months not posted",
    unpostedAmount: "Not yet posted",
    unreversedAccruals: "Accruals not reversed",
    missingReclass: "Opening reclasses missing",
  },
  "depreciation-run": { due: "Assets due a charge", charged: "Charged", missing: "Not charged", missingAmount: "Charge missing" },
  "expenses-posted": { unposted: "Claims not posted", unpostedAmount: "Not posted" },
  "delivered-not-invoiced": { waiting: "Milestones waiting", waitingAmount: "Waiting to be billed" },
  "flux-explained": { flagged: "Changes flagged", unexplained: "Not explained" },
};

function numberText(key: string, value: number): string {
  return /amount$/i.test(key) ? rupees(value) : value.toLocaleString("en-IN");
}

export function CheckDetailView({ detail, ok }: { detail: AnyCheckDetail; ok: boolean | null }) {
  if (isError(detail)) {
    return (
      <p className="flex items-start gap-2 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>{detail.summary} The task is left as it was — a check that couldn&apos;t run is not evidence either way.</span>
      </p>
    );
  }
  if (isTieOut(detail)) return <TieOutView detail={detail} ok={ok} />;

  const labels = NUMBER_LABELS[detail.key] ?? {};
  const numbers = Object.entries(detail.numbers ?? {}).filter(([k]) => labels[k]);
  return (
    <div className="space-y-3">
      <Summary text={detail.summary} ok={ok} asOf={detail.asOf} />
      {numbers.length > 0 && (
        <dl className="flex flex-wrap gap-2">
          {numbers.map(([k, v]) => (
            <div key={k} className="rounded-base border border-line bg-surface-sunken px-2.5 py-1.5">
              <dt className="text-[11px] uppercase tracking-wide text-subtle">{labels[k]}</dt>
              <dd className="text-sm font-medium tabular-nums text-text">{numberText(k, v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <ItemList items={detail.items ?? []} more={detail.more ?? 0} />
    </div>
  );
}

function Summary({ text, ok, asOf }: { text: string; ok: boolean | null; asOf?: string }) {
  return (
    <p className={cn("flex items-start gap-2 text-sm", ok ? "text-success" : ok === false ? "text-warning" : "text-muted")}>
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <span>
        {text}
        {asOf && <span className="ml-1 text-xs text-subtle">As at {dayLong(`${asOf}T00:00:00.000Z`)}.</span>}
      </span>
    </p>
  );
}

/** The records a check found at fault, each linked to where it is put right. */
function ItemList({ items, more }: { items: DetailItem[]; more: number }) {
  if (items.length === 0) return null;
  return (
    <ul className="divide-y divide-line rounded-base border border-line">
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
          {item.href ? (
            <Link href={item.href} className="inline-flex min-w-0 items-center gap-1 break-words text-brand hover:underline">
              {item.label}
              <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden />
            </Link>
          ) : (
            <span className="min-w-0 break-words text-text">{item.label}</span>
          )}
          {item.note && <span className="min-w-0 break-words text-xs text-muted">{item.note}</span>}
          {typeof item.amount === "number" && item.amount !== 0 && (
            <span className="ml-auto whitespace-nowrap tabular-nums text-text">{rupees(item.amount)}</span>
          )}
        </li>
      ))}
      {more > 0 && <li className="px-3 py-2 text-xs text-subtle">…and {more.toLocaleString("en-IN")} more.</li>}
    </ul>
  );
}

const CAUSES: { key: keyof TieOutDetail["causes"]; title: string; why: string }[] = [
  {
    key: "mismatchedDocuments",
    title: "Documents whose entry disagrees",
    why: "The ledger holds a different amount than the document's total at its rate, or no entry at all.",
  },
  {
    key: "manualJournals",
    title: "Manual journals on the account this month",
    why: "A hand-made entry moves the ledger without a document the ageing knows about.",
  },
  {
    key: "partylessLines",
    title: "Lines with no customer or vendor",
    why: "The ageing counts by party; a line with no party moves only the ledger.",
  },
  {
    key: "orphanPaymentEntries",
    title: "Payment entries whose payment was deleted",
    why: "The entry stayed in the ledger after its payment went.",
  },
  {
    key: "unappliedPayments",
    title: "Payments not set against any document",
    why: "Counted on both sides — listed so they get applied.",
  },
];

/** The receivables or payables tie-out: the two totals, the difference, and its likely causes. */
function TieOutView({ detail, ok }: { detail: TieOutDetail; ok: boolean | null }) {
  const book = detail.side === "AR" ? "Receivables" : "Payables";
  const account = detail.side === "AR" ? "Accounts Receivable" : "Accounts Payable";
  const off = Math.abs(detail.difference) > detail.tolerance;
  const causes = CAUSES.map((c) => ({ ...c, cause: detail.causes[c.key] })).filter(
    (c) => c.cause && (c.cause.count > 0 || ("items" in c.cause && c.cause.items.length > 0)),
  );
  return (
    <div className="space-y-3">
      <Summary text={detail.summary} ok={ok} asOf={detail.asOf} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[18rem] text-sm">
          <caption className="sr-only">
            {book} ageing against the {account} balance
          </caption>
          <tbody>
            <tr className="border-b border-line">
              <th scope="row" className="py-1.5 pr-4 text-left font-normal text-muted">
                {book} ageing, in rupees at each document&apos;s rate
              </th>
              <td className="py-1.5 text-right tabular-nums text-text">{rupees(detail.ageing)}</td>
            </tr>
            <tr className="border-b border-line">
              <th scope="row" className="py-1.5 pl-4 pr-4 text-left text-xs font-normal text-subtle">
                documents {rupees(detail.breakdown.documents)} · credit notes {rupees(detail.breakdown.creditNotes)} · unapplied payments{" "}
                {rupees(detail.breakdown.unappliedPayments)}
              </th>
              <td />
            </tr>
            <tr className="border-b border-line">
              <th scope="row" className="py-1.5 pr-4 text-left font-normal text-muted">
                {account} in the ledger
              </th>
              <td className="py-1.5 text-right tabular-nums text-text">{rupees(detail.ledger)}</td>
            </tr>
            <tr>
              <th scope="row" className="py-1.5 pr-4 text-left font-medium text-text">
                Difference
              </th>
              <td className={cn("py-1.5 text-right font-semibold tabular-nums", off ? "text-danger" : "text-success")}>
                {rupees(detail.difference)}
                <span className="ml-1 text-xs font-normal">{off ? "(out)" : `(within ${rupees(detail.tolerance)})`}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {causes.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-xs font-medium uppercase tracking-wide text-subtle">{off ? "Likely causes" : "Worth a look"}</h4>
          {causes.map(({ key, title, why, cause }) => (
            <div key={key} className="space-y-1.5">
              <p className="text-sm text-text">
                {title}: <span className="tabular-nums">{cause.count.toLocaleString("en-IN")}</span>
                {cause.amount !== 0 && <span className="tabular-nums text-muted"> · {rupees(cause.amount)}</span>}
              </p>
              <p className="text-xs text-subtle">{why}</p>
              {"items" in cause && <ItemList items={cause.items} more={Math.max(0, cause.count - cause.items.length)} />}
            </div>
          ))}
        </div>
      )}
      {detail.causes.manualJournalsBefore?.count > 0 && (
        <p className="text-xs text-subtle">
          Also {detail.causes.manualJournalsBefore.count.toLocaleString("en-IN")} manual journal
          {detail.causes.manualJournalsBefore.count === 1 ? "" : "s"} on the account before this month (
          {rupees(detail.causes.manualJournalsBefore.amount)}), which earlier tie-outs would have shown.
        </p>
      )}
    </div>
  );
}
