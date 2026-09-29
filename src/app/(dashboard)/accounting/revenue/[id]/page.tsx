import Link from "next/link";
import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getSchedule } from "@/actions/revenue";
import { schedulePeople } from "@/actions/revenue-screens";
import { monthLabel } from "@/lib/revenue/periods";
import { formatCurrency } from "@/lib/utils";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Amount } from "@/components/accounting/report-chrome";
import { ScheduleActions } from "@/components/revenue/schedule-actions";
import { KIND_LABELS, STATUS_LABELS, STATUS_TONES, istDay, periodText } from "@/components/revenue/labels";

/**
 * One revenue schedule (spec §3.8): the invoice line it recognises, its months — posted or planned,
 * each with the entry that posted it — the credit notes that took from it, who made and approved it,
 * and, for a manager, approve, edit and cancel.
 */
export default async function RevenueSchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const enabled = await isModuleEnabled("revenue_close");
  if (!enabled) return <ModuleDisabledNotice moduleKey="revenue_close" />;

  const viewer = await currentUser();
  if (!viewer || !((await can(viewer.id, "revenue.viewReports")) || (await can(viewer.id, "revenue.manage")))) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        You don&rsquo;t have permission to see revenue recognition. It needs &ldquo;View revenue recognition&rdquo;; ask an
        admin if your work needs it.
      </Card>
    );
  }

  const { id } = await params;
  // Out of scope and not there give the same answer, so a guessed id learns nothing.
  const [schedule, people] = await Promise.all([getSchedule(id), schedulePeople(id)]);
  if (!schedule) notFound();

  const postedTotal = schedule.months.filter((m) => m.posted).reduce((t, m) => t + m.amount, 0);
  const plannedTotal = schedule.months.filter((m) => !m.posted).reduce((t, m) => t + m.amount, 0);
  const verdict = schedule.viewer.mayApprove;

  return (
    <div className="animate-fade-rise min-w-0 space-y-4">
      <Link href="/accounting/revenue" className="text-sm text-muted hover:text-text">
        ← Revenue
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">{schedule.lineName ?? schedule.itemName ?? "Revenue schedule"}</h1>
            <Badge tone={STATUS_TONES[schedule.status]}>{STATUS_LABELS[schedule.status]}</Badge>
            {schedule.opening && <Badge>Opening</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">
            <Link href={`/companies/${schedule.companyId}`} className="hover:underline">
              {schedule.companyName}
            </Link>
            {schedule.document && (
              <>
                {" · "}
                <Link href={`/documents/${schedule.document.id}`} className="font-mono text-xs text-brand hover:underline">
                  {schedule.document.docNumber}
                </Link>
                {` issued ${istDay(schedule.document.issueDate)}`}
              </>
            )}
          </p>
          <p className="text-sm text-subtle">
            {KIND_LABELS[schedule.kind]} · {periodText(schedule.startDate, schedule.endDate)}
            {schedule.kind === "RATABLE" ? (schedule.spreadEvenly ? " · evenly by month" : " · by day") : ""}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold tabular-nums text-text">{formatCurrency(schedule.amount)}</div>
          <div className="text-xs text-subtle">in rupees</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Recognised" value={schedule.recognised} />
        <Figure label="Remaining" value={schedule.remaining} />
        <Figure label="Credited" value={schedule.credited} />
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Next</div>
          <div className="mt-1 text-lg font-semibold text-text">{schedule.nextMonth ? monthLabel(schedule.nextMonth) : "—"}</div>
        </Card>
      </div>

      <Card>
        <CardContent className="space-y-1 text-sm">
          <p className="text-muted">
            Made {people?.madeBy ?? `by ${schedule.createdByName}`} on {istDay(schedule.createdAt)}.
          </p>
          {schedule.approvedAt ? (
            <p className="text-muted">
              Approved {people?.approvedBy ?? (schedule.approvedByName ? `by ${schedule.approvedByName}` : "")} on {istDay(schedule.approvedAt)}
              {people?.approvedOwn ? " — their own schedule, as super admin." : "."}
            </p>
          ) : schedule.status === "PENDING_APPROVAL" ? (
            <p className="text-warning">
              Waiting for approval by somebody other than its maker, with Revenue &amp; Close management. It recognises nothing
              until then.
            </p>
          ) : (
            <p className="text-subtle">Made from the invoice&apos;s own service period, so it started active without approval.</p>
          )}
          {schedule.billingMilestone && (
            <p className="text-muted">
              Earned when{" "}
              <span className="text-text">{schedule.billingMilestone.deliveryMilestone?.name ?? "its delivery milestone"}</span> is done
              (billing stage &ldquo;{schedule.billingMilestone.label}&rdquo;)
              {schedule.billingMilestone.deliveryMilestone?.completedAt
                ? ` — completed ${istDay(schedule.billingMilestone.deliveryMilestone.completedAt)}.`
                : " — not done yet."}
            </p>
          )}
          {schedule.note && <p className="whitespace-pre-line text-muted">Note: {schedule.note}</p>}
        </CardContent>
      </Card>

      {schedule.viewer.mayManage && (
        <Card>
          <CardContent>
            <ScheduleActions
              schedule={{
                id: schedule.id,
                kind: schedule.kind,
                status: schedule.status,
                startDate: schedule.startDate,
                endDate: schedule.endDate,
                amount: schedule.amount,
                spreadEvenly: schedule.spreadEvenly,
                note: schedule.note,
                remaining: schedule.remaining,
              }}
              mayApprove={verdict.may}
              approveOwn={verdict.reason === "super-admin-own"}
            />
            {schedule.status === "PENDING_APPROVAL" && !verdict.may && verdict.reason === "own-schedule" && (
              <p className="mt-2 text-xs text-muted">You made this schedule (or last changed it), so somebody else approves it.</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="overflow-x-auto p-0">
        <CardHeader className="text-sm font-medium text-text">Months</CardHeader>
        {schedule.months.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">
            {schedule.kind === "MILESTONE"
              ? "No month yet: the whole amount is recognised in the month its delivery milestone is completed, by the next recognition run."
              : "No months left: nothing on this schedule remains to recognise."}
          </p>
        ) : (
          <table className="w-full min-w-[560px] text-sm">
            <caption className="sr-only">The schedule&apos;s months</caption>
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5">Month</th>
                <th scope="col" className="px-3 py-2.5 text-right">Amount</th>
                <th scope="col" className="px-3 py-2.5">State</th>
                <th scope="col" className="px-4 py-2.5">Entry</th>
              </tr>
            </thead>
            <tbody>
              {schedule.months.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-4 py-1.5 text-text">{monthLabel(m.month)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Amount value={m.amount} muted={!m.posted} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {m.posted ? <Badge tone="green">Posted</Badge> : <Badge>Planned</Badge>}
                    {m.catchUp && (
                      <Badge tone="amber" className="ml-1.5" title="Its own month was closed, so it was posted in the first open month">
                        Catch-up
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-1.5">
                    {m.entry ? (
                      <>
                        <Link href={`/accounting/journal?q=${encodeURIComponent(m.entry.entryNumber)}`} className="font-mono text-xs text-brand hover:underline">
                          {m.entry.entryNumber}
                        </Link>
                        <span className="ml-2 text-xs text-subtle">
                          {istDay(m.entry.date)}
                          {people?.postedBy[m.entry.id] ? ` · ${people.postedBy[m.entry.id]}` : ""}
                        </span>
                      </>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line-strong">
                <td className="px-4 py-2 font-semibold text-text">Total</td>
                <td className="px-3 py-2 text-right">
                  <Amount value={postedTotal + plannedTotal} bold />
                </td>
                <td colSpan={2} className="px-3 py-2 text-xs text-muted">
                  {formatCurrency(postedTotal)} posted · {formatCurrency(plannedTotal)} planned
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </Card>

      <Card className="overflow-x-auto p-0">
        <CardHeader className="text-sm font-medium text-text">Credit notes</CardHeader>
        {schedule.adjustments.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">No credit note has taken anything off this schedule.</p>
        ) : (
          <table className="w-full min-w-[480px] text-sm">
            <caption className="sr-only">Credit notes against this schedule</caption>
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5">Credit note</th>
                <th scope="col" className="px-3 py-2.5">Date</th>
                <th scope="col" className="px-3 py-2.5 text-right">Taken off</th>
                <th scope="col" className="px-4 py-2.5">State</th>
              </tr>
            </thead>
            <tbody>
              {schedule.adjustments.map((a) => (
                <tr key={a.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-1.5">
                    <Link href={`/documents/${a.creditNoteId}`} className="font-mono text-xs text-brand hover:underline">
                      {a.docNumber}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted">{istDay(a.createdAt)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Amount value={a.amount} />
                  </td>
                  <td className="px-4 py-1.5 text-xs text-muted">
                    {a.reversedAt ? `Credit note cancelled ${istDay(a.reversedAt)}; given back` : "Standing"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-lg font-semibold text-text">
        <Amount value={value} />
      </div>
    </Card>
  );
}
