import { db } from "@/lib/db";
import { OPEN_STAGES } from "@/lib/forecast/stages";
import { PEOPLE_ONLY } from "@/lib/people";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * What the Staff tab of Staff & roles shows beside each person, past what the access roster already
 * says (src/actions/permission.ts, `accessRoster`): their photo, work phone and job title, when they
 * last signed in, and the leads they are holding.
 *
 * A plain server module, not `"use server"`: these are facts about colleagues, and the page decides
 * who may see which of them before asking — sign-in times to whoever may already read the sign-in or
 * activity log, lead counts to whoever may see leads. As an endpoint it would answer anybody.
 *
 * Four grouped queries for the whole list, whatever its length. The status and "58m ago" wording is
 * in ./status.ts, which the client table shares.
 */

export type StaffFacts = {
  photoUpdatedAt: Date | null;
  phone: string | null;
  /** Their designation on the HR record, which is where a job title lives. */
  jobTitle: string | null;
  /** Null when not asked for, or when they have never signed in. */
  lastSignInAt: Date | null;
  /** Open leads they own — any stage short of Won, Lost or Disqualified. Null when not asked for. */
  openLeads: number | null;
  /** Of those, the ones whose expected close date is before today in the workspace: the forecast's "slipped". */
  overdueLeads: number | null;
};

export async function staffFacts(
  userIds: string[],
  options: { leads: boolean; signIns: boolean; now?: Date },
): Promise<Map<string, StaffFacts>> {
  const ids = [...new Set(userIds)];
  const facts = new Map<string, StaffFacts>();
  if (ids.length === 0) return facts;

  const now = options.now ?? new Date();
  const clock = await workspaceClock();
  const today = clock.parts(now);
  const startOfToday = clock.midnight(today.year, today.month, today.day);
  const open = { status: { in: [...OPEN_STAGES] } };

  const [people, signIns, leads, slipped] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids }, ...PEOPLE_ONLY },
      select: { id: true, photoUpdatedAt: true, phone: true, employeeProfile: { select: { designation: true } } },
    }),
    options.signIns
      ? db.signIn.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _max: { at: true } })
      : Promise.resolve([]),
    options.leads
      ? db.lead.groupBy({ by: ["ownerUserId"], where: { ownerUserId: { in: ids }, ...open }, _count: { _all: true } })
      : Promise.resolve([]),
    options.leads
      ? db.lead.groupBy({
          by: ["ownerUserId"],
          where: { ownerUserId: { in: ids }, ...open, expectedCloseDate: { lt: startOfToday } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  const lastAt = new Map(signIns.map((s) => [s.userId, s._max.at ?? null]));
  const openBy = new Map(leads.map((l) => [l.ownerUserId, l._count._all]));
  const slippedBy = new Map(slipped.map((l) => [l.ownerUserId, l._count._all]));

  for (const person of people) {
    facts.set(person.id, {
      photoUpdatedAt: person.photoUpdatedAt,
      phone: person.phone,
      jobTitle: person.employeeProfile?.designation?.trim() || null,
      lastSignInAt: options.signIns ? (lastAt.get(person.id) ?? null) : null,
      openLeads: options.leads ? (openBy.get(person.id) ?? 0) : null,
      overdueLeads: options.leads ? (slippedBy.get(person.id) ?? 0) : null,
    });
  }
  return facts;
}
