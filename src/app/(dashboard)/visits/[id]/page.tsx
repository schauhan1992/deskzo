import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canonicalise, parseRecordRef } from "@/lib/record-url";
import { getVisit } from "@/actions/visit";
import { getDownlineUserIds } from "@/lib/org-chart";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { VisitActions } from "@/components/visits/visit-actions";
import { RecordMeetings } from "@/components/calendar/record-meetings";
import { isModuleEnabled } from "@/actions/module";
import { EmailAddress } from "@/components/contacts/email-address";
import { formatCurrency } from "@/lib/utils";
import {
  formatVisitId,
  visitPurposeLabels,
  visitStatusLabels,
  visitStatusTone,
  visitDuration,
  formatDuration,
} from "@/lib/visits";
import { expenseCategoryLabels, expenseStatusLabels, expenseStatusTone, formatExpenseId } from "@/lib/expenses";
import { viewerHas } from "@/actions/permission";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { companyPath, expensePath, leadPath } from "@/lib/record-links";

export default async function VisitDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!(await viewerHas("visits.view"))) notFound();
  /**
   * The sequence resolves to the cuid before the action runs, so every check that action already
   * made still happens — this translates the reference, it does not bypass anything. A sequence
   * matching nothing falls through as the original segment and the action answers null, which is
   * the same refusal a bad cuid gets.
   */
  const ref = parseRecordRef(id);
  const resolved =
    ref.kind === "seq"
      ? ((await db.visit.findUnique({ where: { visitSeq: ref.seq }, select: { id: true } }))?.id ?? id)
      : ref.id;

  const [visit, session, clock] = await Promise.all([getVisit(resolved), auth(), workspaceClock()]);
  if (!visit) notFound();
  /** When it was planned, arrived and left — on the workspace's clock, whatever zone the server renders in. */
  const stamp = (value: Date | string | null) => clock.dateTime(value);

  // After the check, never before — see `canonicalise`.
  canonicalise(id, "/visits", formatVisitId(visit.visitSeq), query);

  const userId = session!.user.id;
  const canEdit = visit.userId === userId || (await getDownlineUserIds(userId)).includes(visit.userId);
  // The visit goes into the calendar of whoever is making it, and only they put it there.
  const calendarEnabled = await isModuleEnabled("calendar");
  const canCalendar = calendarEnabled && visit.userId === userId && visit.status === "PLANNED";

  const claimed = visit.expenses.reduce((sum, e) => sum + e.amount, 0);
  const duration = visitDuration(visit.checkInAt, visit.checkOutAt);

  return (
    <div className="animate-fade-rise">
      <Link href="/visits" className="text-sm text-muted hover:text-text">
        ← Field visits
      </Link>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">{formatVisitId(visit.visitSeq)}</h1>
            <Badge tone={visitStatusTone[visit.status]}>{visitStatusLabels[visit.status]}</Badge>
            <Badge tone="brand">{visitPurposeLabels[visit.purpose]}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            <Link href={companyPath(visit.company.companySeq)} className="hover:underline">
              {visit.company.name}
            </Link>
            {visit.contact ? ` · ${visit.contact.name}` : ""}
            {` · ${visit.user.name}`}
          </p>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold text-text">{stamp(visit.scheduledFor)}</div>
          {duration !== null && <div className="text-xs text-subtle">{formatDuration(duration)} on site</div>}
        </div>
      </div>

      <Card className="mt-5">
        <CardContent>
          <VisitActions
            id={visit.id}
            status={visit.status}
            distanceKm={visit.distanceKm !== null ? String(visit.distanceKm) : ""}
            canEdit={canEdit}
          />
          {!canEdit && <p className="text-sm text-subtle">You can see this visit but it isn&apos;t yours to change.</p>}
        </CardContent>
      </Card>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Visit</CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Field label="Agenda" value={visit.agenda} />
              <Field label="Outcome" value={visit.outcome} placeholder="Not written up yet." />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
              <span>Expenses claimed</span>
              <span className="text-sm font-semibold text-text">{formatCurrency(claimed)}</span>
            </CardHeader>
            <CardContent className={visit.expenses.length === 0 ? undefined : "p-0"}>
              {visit.expenses.length === 0 ? (
                <p className="text-sm text-subtle">
                  Nothing claimed against this visit yet. Travel, fuel, tolls and client meals all belong here.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-5 py-2">Claim</th>
                      <th className="px-3 py-2">Category</th>
                      <th className="px-3 py-2">Spent on</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visit.expenses.map((expense) => (
                      <tr key={expense.id} className="border-b border-line last:border-0">
                        <td className="px-5 py-2">
                          <Link href={expensePath(expense.expenseSeq)} className="font-mono text-xs text-text hover:underline">
                            {formatExpenseId(expense.expenseSeq)}
                          </Link>
                          <div className="text-xs text-subtle">{expense.description}</div>
                        </td>
                        <td className="px-3 py-2 text-muted">{expenseCategoryLabels[expense.category]}</td>
                        <td className="px-3 py-2 text-muted">{formatCalendarDay(expense.spentOn)}</td>
                        <td className="px-3 py-2 text-right font-medium text-text">{formatCurrency(expense.amount)}</td>
                        <td className="px-3 py-2">
                          <Badge tone={expenseStatusTone[expense.status]}>{expenseStatusLabels[expense.status]}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          {calendarEnabled && (
            <RecordMeetings
              record={{ kind: "visit", id: visit.id }}
              viewerId={userId}
              canSchedule={canCalendar}
              emptyText={canCalendar ? "Not in your calendar yet." : "Not in a calendar."}
            />
          )}
          <Card>
            <CardHeader className="text-sm font-medium text-text">Where</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Office" value={visit.location?.label ?? "Not on file"} />
              <Row label="Address" value={visit.address ?? "—"} />
              <Row label="Distance" value={visit.distanceKm !== null ? `${visit.distanceKm} km` : "—"} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Timings</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Scheduled" value={stamp(visit.scheduledFor)} />
              <Row label="Checked in" value={stamp(visit.checkInAt)} />
              <Row label="Checked out" value={stamp(visit.checkOutAt)} />
              <Row label="On site" value={formatDuration(duration)} />
            </CardContent>
          </Card>

          {visit.contact && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Contact</CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row label="Name" value={visit.contact.name} />
                <div className="flex items-start justify-between gap-3 text-muted">
                  <span className="shrink-0">Email</span>
                  <EmailAddress contact={visit.contact} className="justify-end text-right" />
                </div>
                <Row label="Phone" value={visit.contact.phone ?? "—"} />
              </CardContent>
            </Card>
          )}

          {visit.lead && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Against lead</CardHeader>
              <CardContent className="text-sm">
                <Link href={leadPath(visit.lead.leadSeq)} className="text-text hover:underline">
                  {visit.lead.title}
                </Link>
                <div className="mt-1 text-xs text-subtle">{visit.lead.status.replaceAll("_", " ")}</div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-muted">
      <span className="shrink-0">{label}</span>
      <span className="text-right text-text">{value}</span>
    </div>
  );
}

function Field({ label, value, placeholder }: { label: string; value: string | null; placeholder?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <p className={`mt-1 whitespace-pre-wrap ${value ? "text-muted" : "text-subtle"}`}>
        {value || placeholder || "—"}
      </p>
    </div>
  );
}
