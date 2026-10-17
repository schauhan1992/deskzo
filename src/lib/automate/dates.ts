import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { formatLeadId, formatOrderId } from "@/lib/order-id";
import type { Clock } from "@/lib/time/zone";

/**
 * Deskzo Automate's date checks (Phase 2): things that become true with time rather than with a
 * change — an invoice overdue, a subscription coming up for renewal, a deal gone quiet. Once a day per
 * workspace (claimed through `DailyJobRun`), and only for the kinds an active workflow listens for,
 * each record that qualifies gets one event for that day, carrying how many days it is:
 *
 *   · invoice.overdue — an invoice issued and not settled, past its due date. `daysOverdue`.
 *   · renewal.due     — a subscription ending within 60 days, not cancelled. `daysLeft`.
 *   · lead.quiet      — an open lead that hasn't moved stage in 3 days or more. `daysQuiet`.
 *
 * A workflow picks its day with a condition ("daysOverdue is 1", "daysLeft is in 30, 15, 7"). The
 * definitions are the ones Collections and the marketing journeys already use, so a workflow, a
 * reminder and a journey agree about what "overdue" and "quiet" mean.
 */

export const DATE_TRIGGERS = ["invoice.overdue", "renewal.due", "lead.quiet"] as const;
const JOB = "automate-dates";
const CAP = 1_000;
const RENEWAL_WINDOW_DAYS = 60;
const QUIET_FROM_DAYS = 3;
const DAY_MS = 86_400_000;

type Row = { type: string; recordType: string; recordId: string; payload: Prisma.InputJsonValue };

/** Today's date checks, once. Null when they have already run today, or nobody listens for them. */
export async function emitDateEvents(clock: Clock, now: Date = new Date()): Promise<{ events: number } | null> {
  const day = clock.calendarDate(now);
  if (await db.dailyJobRun.findUnique({ where: { job_day: { job: JOB, day } }, select: { day: true } })) return null;
  const wanted = new Set(
    (await db.automationTrigger.findMany({ where: { type: { in: [...DATE_TRIGGERS] }, workflow: { status: "ACTIVE" } }, select: { type: true }, distinct: ["type"] })).map((t) => t.type),
  );
  // Nobody listens: nothing claimed, so a workflow published later today still gets today's.
  if (!wanted.size) return null;
  try {
    await db.dailyJobRun.create({ data: { job: JOB, day } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
  const key = clock.dateKey(now);
  const rows: Row[] = [];
  try {
    if (wanted.has("invoice.overdue")) {
      const invoices = await db.tradeDocument.findMany({
        where: { docType: "INVOICE", status: { notIn: ["DRAFT", "CANCELLED", "PAID"] }, dueDate: { lt: day } },
        select: { id: true, docNumber: true, status: true, companyId: true, total: true, currency: true, issueDate: true, dueDate: true, salespersonId: true, company: { select: { name: true } } },
        orderBy: { dueDate: "asc" },
        take: CAP,
      });
      for (const d of invoices) {
        rows.push({
          type: "invoice.overdue",
          recordType: "document",
          recordId: `${d.id}@${key}`,
          payload: {
            document: { id: d.id, number: d.docNumber, type: "INVOICE", status: d.status, companyId: d.companyId, total: Number(d.total), currency: d.currency, issueDate: d.issueDate.toISOString(), dueDate: d.dueDate?.toISOString() ?? null, salespersonId: d.salespersonId },
            company: { id: d.companyId, name: d.company.name },
            daysOverdue: d.dueDate ? Math.round((day.getTime() - d.dueDate.getTime()) / DAY_MS) : null,
          },
        });
      }
    }
    if (wanted.has("renewal.due")) {
      const renewals = await db.companyProduct.findMany({
        where: {
          parentId: null,
          item: { type: "SUBSCRIPTION" },
          orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
          // A typed day, held at UTC midnight: one ending today is still renewing.
          endDate: { gte: day, lte: new Date(day.getTime() + RENEWAL_WINDOW_DAYS * DAY_MS) },
        },
        select: { id: true, orderSeq: true, companyId: true, endDate: true, quantity: true, addedByUserId: true, item: { select: { name: true } }, company: { select: { name: true, ownerUserId: true } } },
        orderBy: { endDate: "asc" },
        take: CAP,
      });
      for (const r of renewals) {
        rows.push({
          type: "renewal.due",
          recordType: "order",
          recordId: `${r.id}@${key}`,
          payload: {
            order: { id: r.id, ref: formatOrderId(r.orderSeq), companyId: r.companyId, itemName: r.item.name, quantity: r.quantity, endDate: r.endDate?.toISOString() ?? null, addedByUserId: r.addedByUserId },
            company: { id: r.companyId, name: r.company.name, ownerUserId: r.company.ownerUserId },
            daysLeft: r.endDate ? Math.round((r.endDate.getTime() - day.getTime()) / DAY_MS) : null,
          },
        });
      }
    }
    if (wanted.has("lead.quiet")) {
      const leads = await db.lead.findMany({
        where: { status: { notIn: ["WON", "LOST", "DISQUALIFIED"] }, stageChangedAt: { lt: new Date(now.getTime() - QUIET_FROM_DAYS * DAY_MS) } },
        select: { id: true, leadSeq: true, title: true, status: true, stageId: true, pipelineId: true, ownerUserId: true, companyId: true, contactId: true, estimatedValue: true, stageChangedAt: true, company: { select: { name: true } } },
        orderBy: { stageChangedAt: "asc" },
        take: CAP,
      });
      for (const l of leads) {
        rows.push({
          type: "lead.quiet",
          recordType: "lead",
          recordId: `${l.id}@${key}`,
          payload: {
            lead: { id: l.id, ref: formatLeadId(l.leadSeq), title: l.title, status: l.status, stageId: l.stageId, pipelineId: l.pipelineId, ownerUserId: l.ownerUserId, companyId: l.companyId, contactId: l.contactId, value: l.estimatedValue === null ? null : Number(l.estimatedValue) },
            company: { id: l.companyId, name: l.company.name },
            daysQuiet: l.stageChangedAt ? Math.floor((now.getTime() - l.stageChangedAt.getTime()) / DAY_MS) : null,
          },
        });
      }
    }
    for (let i = 0; i < rows.length; i += 500) await db.automationEvent.createMany({ data: rows.slice(i, i + 500) });
    await db.dailyJobRun.update({ where: { job_day: { job: JOB, day } }, data: { ok: true } });
    return { events: rows.length };
  } catch (err) {
    await db.dailyJobRun.update({ where: { job_day: { job: JOB, day } }, data: { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) } }).catch(() => undefined);
    throw err;
  }
}

/** Whether any active workflow waits on a date check — so the worker wakes for tomorrow's. */
export async function listensForDates(): Promise<boolean> {
  return !!(await db.automationTrigger.findFirst({ where: { type: { in: [...DATE_TRIGGERS] }, workflow: { status: "ACTIVE" } }, select: { id: true } }));
}
