import Link from "next/link";
import type { getCreditProfile } from "@/actions/credit";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { CreditBadge } from "@/components/credit/credit-badge";
import { CreditLimitForm } from "@/components/credit/credit-limit-form";
import { paymentTermsLabels } from "@/lib/gst";
import { GRACE_DAYS, LOOKBACK_DAYS, MIN_HISTORY } from "@/lib/credit/engine";
import { formatCurrency, formatDate } from "@/lib/utils";

type Profile = NonNullable<Awaited<ReturnType<typeof getCreditProfile>>>;

const TONE_DOT = { good: "bg-success", bad: "bg-danger", neutral: "bg-line-strong" } as const;
const KIND_LABEL = { TERMS: "Terms", LIMIT: "Limit", ORDER: "Order" } as const;

/**
 * A customer's credit, as the engine sees it and why — the Credit tab.
 *
 * Laid out in the order a credit decision is made: the verdict and its reasons, what they owe and
 * how that sits against their limit, then the bills the verdict came from, then what people have
 * already decided against it. Nothing here is a black box; every number traces to a row below it.
 */
export function CompanyCredit({ companyId, profile }: { companyId: string; profile: Profile }) {
  const used = profile.limit > 0 ? Math.min(100, Math.round((profile.outstanding / profile.limit) * 100)) : null;
  const m = profile.metrics;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 @3xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
            <span className="flex items-center gap-2">
              Credit rating <CreditBadge rating={profile.rating} score={profile.score} />
            </span>
            <span className="text-xs font-normal text-muted">
              Suggested terms: <span className="font-medium text-text">{paymentTermsLabels[profile.recommendedTerms]}</span>
            </span>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <ul className="space-y-1.5">
              {profile.reasons.map((r, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[r.tone]}`} aria-hidden />
                  <span className="text-text">{r.text}</span>
                </li>
              ))}
            </ul>
            <div
              className={`rounded-md border px-3 py-2 text-xs ${profile.termsBeyond ? "border-warning bg-warning-bg text-warning" : "border-line text-muted"}`}
            >
              Standing terms: <span className="font-medium">{paymentTermsLabels[profile.defaultTerms]}</span>
              {profile.termsBeyond
                ? ` — longer than their record now supports. New orders on these terms need a credit override at approval.`
                : " — within what their record supports."}
            </div>
            <p className="text-xs text-subtle">
              Rated on the last {Math.round(LOOKBACK_DAYS / 365)} years of invoices and billed orders. Paid within {GRACE_DAYS} days
              of the due date counts as on time; {MIN_HISTORY} paid bills are needed before credit is suggested.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium text-text">Credit limit</CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-2xl font-semibold text-text">{formatCurrency(profile.limit)}</span>
              <span className="text-xs text-muted">
                {profile.limitSource === "manual"
                  ? `set by hand${profile.isReseller ? " (reseller profile)" : ""} · suggested ${formatCurrency(profile.suggestedLimit)}`
                  : "suggested from their payment history"}
              </span>
            </div>
            <div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
                <div
                  className={`h-full ${used !== null && used >= 100 ? "bg-danger" : used !== null && used >= 80 ? "bg-warning" : "bg-brand"}`}
                  style={{ width: `${used ?? (profile.outstanding > 0 ? 100 : 0)}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-muted">
                Owes {formatCurrency(profile.outstanding)}
                {profile.limit > 0 ? ` of ${formatCurrency(profile.limit)} (${used}%)` : " — no credit extended"}
                {profile.overdue > 0 && (
                  <span className="text-danger">
                    {" "}
                    · {formatCurrency(profile.overdue)} overdue, oldest {profile.oldestOverdueDays} days
                  </span>
                )}
              </p>
            </div>
            <p className="text-xs text-subtle">
              An order on credit terms that would take them over this needs a credit override when it is approved. Orders paid in
              advance never count against it.
            </p>
            {profile.canOverride && (
              <CreditLimitForm companyId={companyId} manualLimit={profile.manualLimit} suggestedLimit={profile.suggestedLimit} />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
        {[
          ["Paid on time", m.paidBills ? `${m.onTimeBills} of ${m.paidBills}` : "—"],
          ["Average days late", m.averageDaysLate === null ? "—" : String(Math.round(m.averageDaysLate))],
          ["Worst in 12 months", m.worstDaysLate === null ? "—" : `${m.worstDaysLate} days`],
          ["Largest balance cleared", formatCurrency(m.largestBalanceCleared)],
          ["Paid to date", formatCurrency(m.paidTotal)],
          ["Customer since", m.firstBillOn ? formatDate(m.firstBillOn) : "—"],
          ["Bills on record", String(m.bills)],
          ["Owes now", formatCurrency(profile.outstanding)],
        ].map(([label, value]) => (
          <Card key={label} className="p-3">
            <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
            <div className="mt-1 text-base font-semibold text-text">{value}</div>
          </Card>
        ))}
      </div>

      <Card className="overflow-x-auto p-0">
        <div className="border-b border-line px-5 py-3 text-sm font-medium text-text">What the rating is based on</div>
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Bill</th>
              <th className="px-4 py-2.5">Billed</th>
              <th className="px-4 py-2.5">Due</th>
              <th className="px-4 py-2.5 text-right">Amount</th>
              <th className="px-4 py-2.5">Paid</th>
              <th className="px-4 py-2.5 text-right">Days late</th>
            </tr>
          </thead>
          <tbody>
            {profile.bills.map((b) => (
              <tr key={b.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5">
                  <Link href={b.kind === "INVOICE" ? `/documents/${b.id}` : `/orders/${b.id}`} className="font-mono text-xs text-text hover:underline">
                    {b.ref}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-muted">{formatDate(b.issuedOn)}</td>
                <td className="px-4 py-2.5 text-muted">{formatDate(b.dueOn)}</td>
                <td className="px-4 py-2.5 text-right text-text">{formatCurrency(b.amount)}</td>
                <td className="px-4 py-2.5 text-muted">
                  {b.paidOn ? formatDate(b.paidOn) : <span className="text-text">{formatCurrency(b.outstanding)} owed</span>}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {b.paidOn ? (
                    <span className={b.daysLate && b.daysLate > GRACE_DAYS ? "text-warning" : "text-success"}>{b.daysLate ? b.daysLate : "On time"}</span>
                  ) : b.overdueDays > 0 ? (
                    <span className="text-danger">{b.overdueDays} overdue</span>
                  ) : (
                    <span className="text-muted">Not yet due</span>
                  )}
                </td>
              </tr>
            ))}
            {profile.bills.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-subtle">
                  Nothing billed yet — no issued invoices and no approved orders.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Credit decisions</CardHeader>
        <CardContent className="text-sm">
          {profile.decisions.length === 0 ? (
            <p className="text-subtle">Nobody has given this customer more credit than suggested.</p>
          ) : (
            <ul className="space-y-3">
              {profile.decisions.map((d) => (
                <li key={d.id} className="border-l-2 border-line pl-3">
                  <p className="text-text">
                    <span className="mr-1.5 rounded bg-surface-sunken px-1.5 py-0.5 text-[11px] text-muted">{KIND_LABEL[d.kind]}</span>
                    {d.detail}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">&ldquo;{d.reason}&rdquo;</p>
                  <p className="mt-0.5 text-[11px] text-subtle">
                    {d.decidedBy.name} · {formatDate(d.createdAt)} · rated {d.rating.toLowerCase()}
                    {d.score !== null ? ` (${d.score})` : ""} at the time
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
