"use server";

import { db } from "@/lib/db";
import { requireModuleUser, moduleAccessFor } from "@/lib/modules-access";
import { isModuleEnabled } from "@/actions/module";
import { callAccess, leadAccess, peopleReached, throughAccount } from "@/lib/authz/access";
import { buildCallReport, REPORT_MAX_DAYS, type CallReport, type ReportLead } from "@/lib/call-report";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Calls › Team report (owner, 18 Oct 2026): each person's calling in a period — see src/lib/call-report.ts
 * for what is worked out. Everything is read within the viewer's own reach, as the Calls list is: the calls
 * of the people whose calls they may see ("See everyone's calls, notes & meetings", or their own and their
 * team's), on accounts they may see; leads only where leads are theirs to open, and only those they may see.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `yyyy-mm-dd` moved by whole days — calendar arithmetic, whatever the zone. */
const shift = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export type CallReportView = CallReport & { from: string; to: string; today: string; leadsShown: boolean; clamped: boolean };

export async function callingReport(params: { from?: string; to?: string }): Promise<CallReportView | null> {
  const user = await requireModuleUser("calls");
  // In the plan is not enough: Calls switched on for the company, and View calls this person's.
  if (!(await isModuleEnabled("calls"))) return null;

  const clock = await workspaceClock();
  const today = clock.today();
  let to = params.to && DAY.test(params.to) ? params.to : today;
  let from = params.from && DAY.test(params.from) ? params.from : to;
  if (from > to) [from, to] = [to, from];
  // A quarter at most — the report reads every call in it.
  const clamped = shift(from, REPORT_MAX_DAYS - 1) < to;
  if (clamped) from = shift(to, -(REPORT_MAX_DAYS - 1));
  const range = clock.dayRange(from, to)!;
  const dayKeys: string[] = [];
  for (let d = from; d <= to; d = shift(d, 1)) dayKeys.push(d);

  const [reached, account, whose] = await Promise.all([peopleReached(user.id, "activities", "view"), throughAccount(user.id, "view"), callAccess(user.id, "view")]);
  const scope = { AND: [account, whose] };
  const now = new Date();

  const [calls, overdue, callers] = await Promise.all([
    db.callLog.findMany({
      where: { AND: [scope, { startedAt: range }] },
      select: { userId: true, direction: true, outcome: true, durationSeconds: true, startedAt: true, source: true, reviewedAt: true, followUpAt: true },
    }),
    db.callLog.groupBy({ by: ["userId"], where: { AND: [scope, { followUpAt: { lt: now }, followUpDone: false }] }, _count: { _all: true } }),
    // Who calls here: anybody within reach who logged a call in the last month — so somebody who made none
    // today shows as none, rather than not at all.
    db.user.findMany({
      where: { active: true, ...(reached ? { id: { in: reached } } : {}), callsLogged: { some: { startedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } } } },
      select: { id: true, name: true },
    }),
  ]);

  // Speed to lead: the leads that came in during the period, owned by somebody within reach.
  let leads: ReportLead[] | null = null;
  if ((await moduleAccessFor(user.id, "leads")) === "available") {
    const fresh = await db.lead.findMany({
      where: { AND: [await leadAccess(user.id, "view"), { createdAt: range, ownerUserId: reached ? { in: reached } : { not: null } }] },
      select: { id: true, companyId: true, createdAt: true, ownerUserId: true },
      take: 5000,
    });
    const earliest = fresh.reduce<Date | null>((min, l) => (!min || l.createdAt < min ? l.createdAt : min), null);
    const answers = earliest
      ? await db.callLog.findMany({
          where: { AND: [scope, { startedAt: { gte: earliest } }, { OR: [{ leadId: { in: fresh.map((l) => l.id) } }, { companyId: { in: [...new Set(fresh.map((l) => l.companyId))] } }] }] },
          orderBy: { startedAt: "asc" },
          select: { leadId: true, companyId: true, startedAt: true },
        })
      : [];
    leads = fresh.map((l) => ({
      id: l.id,
      ownerUserId: l.ownerUserId!,
      createdAt: l.createdAt,
      // The first call after it came in, about it or to its company.
      firstCallAt: answers.find((c) => (c.leadId === l.id || c.companyId === l.companyId) && c.startedAt >= l.createdAt)?.startedAt ?? null,
    }));
  }

  // Names for anybody in the figures who isn't among the callers (an owner of new leads who never called).
  const known = new Set(callers.map((c) => c.id));
  const missing = [...new Set([...calls.map((c) => c.userId), ...overdue.map((o) => o.userId), ...(leads ?? []).map((l) => l.ownerUserId)])].filter((id) => !known.has(id));
  const others = missing.length ? await db.user.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } }) : [];

  const report = buildCallReport({
    clock,
    people: [...callers, ...others],
    calls,
    overdue: overdue.map((o) => ({ userId: o.userId, count: o._count._all })),
    leads,
    dayKeys,
  });
  return { ...report, from, to, today, leadsShown: leads !== null, clamped };
}
