"use server";

import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany, companyScope } from "@/lib/authz/company-scope";
import { viewerHas } from "@/actions/permission";
import { isCustomerRelationshipType } from "@/lib/validation/company";
import { compareToPeers, summariseSupport, type SupportFacts } from "@/lib/support/load";
import { companiesWithSupport, loadSupportFacts, supportPeers, supportWindow } from "@/lib/support/data";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * How much support customers take, for the screens that show it.
 *
 * Tickets are the core of it, so the whole thing is `tickets.view`. The parts drawn from other
 * modules follow their own view permissions: calls need `calls.view`, visits `visits.view`, and
 * what the customer was billed `payments.view`. Someone without the last still sees the Heavy /
 * Light judgement — it is a comparison, not an amount — but not the rupees behind it.
 */

async function viewerParts() {
  const [tickets, calls, visits, money] = await Promise.all([
    viewerHas("tickets.view"),
    viewerHas("calls.view"),
    viewerHas("visits.view"),
    viewerHas("payments.view"),
  ]);
  return { tickets, calls, visits, money };
}

/** Summarise, compare, then drop what this viewer may not see. */
async function present(facts: SupportFacts, window: { from: Date; to: Date }, months: number, parts: Awaited<ReturnType<typeof viewerParts>>) {
  const summary = summariseSupport(facts, { asOf: window.to, months });
  const comparison = compareToPeers(summary, await supportPeers(window.from.toISOString(), window.to.toISOString()));
  return {
    ...summary,
    ...(parts.calls ? {} : { calls: null, talkMinutes: null }),
    ...(parts.visits ? {} : { visits: null, onSiteHours: null, distanceKm: null, visitExpenses: null }),
    recordedHours: parts.calls && parts.visits ? summary.recordedHours : null,
    ...(parts.money ? {} : { billed: null, ticketsPerLakh: null }),
    level: comparison.level,
    multiple: parts.money ? comparison.multiple : null,
    typicalTicketsPerLakh: parts.money ? comparison.typicalTicketsPerLakh : null,
    rank: comparison.rank,
    rankedOf: comparison.rankedOf,
  };
}

/** One customer's support over the last `months` — for the customer page. Null when not theirs to see. */
export async function getSupportLoad(companyId: string, months = 12) {
  const user = await requireModuleUser("helpdesk");
  const parts = await viewerParts();
  if (!parts.tickets) return null;
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  if (!company || !isCustomerRelationshipType(company.relationshipType)) return null;
  if (!(await canSeeCompany(user.id, company))) return null;

  const window = supportWindow(await workspaceClock(), months);
  const facts = (await loadSupportFacts([companyId], window)).get(companyId)!;
  return { months, from: window.from, ...(await present(facts, window, months, parts)) };
}

export type SupportSort = "tickets" | "intensity" | "hours";

/**
 * Every customer this person can see who took any support in the window, heaviest first.
 *
 * Worked out in memory rather than in the database: the set is only customers with support in the
 * window — tens or hundreds, not the whole book — and "heaviest" is a ratio against billing the
 * database cannot sort by without computing it anyway.
 */
export async function listSupportLoad(params: { months: number; sort: SupportSort; page: number; pageSize: number }) {
  const user = await requireModuleUser("helpdesk");
  const parts = await viewerParts();
  if (!parts.tickets) return { rows: [], total: 0 };
  const months = [3, 6, 12, 24].includes(params.months) ? params.months : 12;
  const window = supportWindow(await workspaceClock(), months);

  const ids = await companiesWithSupport(await companyScope(user.id), window);
  const [facts, companies] = await Promise.all([
    loadSupportFacts(ids, window),
    db.company.findMany({ where: { id: { in: ids } }, select: { id: true, companySeq: true, name: true, relationshipType: true } }),
  ]);
  const rows = await Promise.all(
    companies.map(async (c) => ({ id: c.id, companySeq: c.companySeq, name: c.name, isReseller: c.relationshipType === "RESELLER", ...(await present(facts.get(c.id)!, window, months, parts)) })),
  );

  // Intensity: support with nothing billed first, then by tickets per ₹1 lakh. Without the payments
  // view there are no rupees to rank by, so it falls back to the ticket count.
  const intensity = (r: (typeof rows)[number]) =>
    r.level === "UNBILLED" ? Number.POSITIVE_INFINITY : (r.ticketsPerLakh ?? (parts.money ? 0 : r.tickets));
  const key: Record<SupportSort, (r: (typeof rows)[number]) => number> = {
    tickets: (r) => r.tickets,
    intensity,
    hours: (r) => r.recordedHours ?? 0,
  };
  const by = key[params.sort] ?? key.tickets;
  rows.sort((a, b) => by(b) - by(a) || b.tickets - a.tickets || a.name.localeCompare(b.name));
  const start = (params.page - 1) * params.pageSize;
  return { months, rows: rows.slice(start, start + params.pageSize), total: rows.length, canSeeMoney: parts.money };
}
