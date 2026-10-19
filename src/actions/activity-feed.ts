"use server";

import { requireUser } from "@/lib/session";
import { mayAccess } from "@/lib/authz/access";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { getDownlineUserIds } from "@/lib/org-chart";
import { workspaceClock } from "@/lib/time/workspace";
import {
  ACTIVITY_GROUPS,
  mayViewPersonActivity,
  personActivity,
  recordActivity,
  type ActivityGroupKey,
  type ActivityOptions,
  type ActivityPage,
} from "@/lib/activity/timeline";
import type { ActionResult } from "@/actions/company";

/**
 * Activity (owner, 19 Oct 2026) — src/lib/activity/timeline.ts. A record's for whoever can open it; a
 * person's for themselves, their managers, and whoever sees everyone's.
 */

export type ActivityQuery = {
  /** Older than this item's time — the next page. */
  before?: string | null;
  group?: string | null;
  personId?: string | null;
  /** Workspace days, yyyy-mm-dd. */
  from?: string | null;
  to?: string | null;
};

const GROUP_KEYS = new Set<string>(ACTIVITY_GROUPS.map((g) => g.key));

async function options(q: ActivityQuery | undefined): Promise<ActivityOptions> {
  const before = q?.before ? new Date(q.before) : null;
  const clock = await workspaceClock();
  const from = q?.from ? clock.startOfDay(q.from) : null;
  const to = q?.to ? clock.endOfDay(q.to) : null;
  return {
    before: before && !Number.isNaN(before.getTime()) ? before : undefined,
    groups: q?.group && GROUP_KEYS.has(q.group) ? [q.group as ActivityGroupKey] : undefined,
    personId: q?.personId ? String(q.personId) : undefined,
    from: from ?? undefined,
    to: to ?? undefined,
  };
}

/** A customer's or vendor's Activity: the company and everything under it. */
export async function companyActivity(companyId: string, q?: ActivityQuery): Promise<ActionResult<ActivityPage>> {
  const user = await requireUser();
  const id = String(companyId ?? "");
  if (!id || !(await mayAccess(user.id, "companies", "view", id))) return { ok: false, error: "Company not found." };
  return { ok: true, data: await recordActivity(user.id, { companyId: id }, await options(q)) };
}

/** A lead's Activity. */
export async function leadActivity(leadId: string, q?: ActivityQuery): Promise<ActionResult<ActivityPage>> {
  const user = await requireUser();
  const id = String(leadId ?? "");
  if (!id || !(await mayAccess(user.id, "leads", "view", id))) return { ok: false, error: "Lead not found." };
  return { ok: true, data: await recordActivity(user.id, { leadId: id }, await options(q)) };
}

/** Everything a person did. */
export async function peopleActivity(personId: string, q?: ActivityQuery): Promise<ActionResult<ActivityPage>> {
  const user = await requireUser();
  const id = String(personId ?? "") || user.id;
  if (!(await mayViewPersonActivity(user.id, id))) return { ok: false, error: "You can see your own activity, and your team's." };
  return { ok: true, data: await personActivity(user.id, id, await options({ ...q, personId: null })) };
}

/** The people a viewer may pick on the person view: themselves, their team, or everyone with the reach. */
export async function activityPeopleOptions(): Promise<{ id: string; name: string }[]> {
  const user = await requireUser();
  const people = await db.user.findMany({ where: { kind: "MEMBER" }, orderBy: { name: "asc" }, select: { id: true, name: true }, take: 2000 });
  if (await can(user.id, "activity.viewAll")) return people;
  const team = new Set([user.id, ...(await getDownlineUserIds(user.id))]);
  return people.filter((p) => team.has(p.id));
}
