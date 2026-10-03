"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser, viewAsContext } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { clearAccessCache } from "@/lib/access/gate";
import { COMPANY_LOCK_PHRASE, companyLockActive, LOCK_MESSAGE_MAX, personalLockActive } from "@/lib/access/lock";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { toPlain } from "@/lib/serialize";
import { PEOPLE_ONLY } from "@/lib/people";
import type { ActionResult } from "@/actions/company";

/**
 * Locking people out of the CRM, and letting them back — see src/lib/access/lock.ts.
 *
 * One person: whoever holds `users.lock`. The whole company: the super admin only, who is the one
 * account no lock applies to. Neither while "viewing as" somebody — a lock is applied by a person,
 * as themselves.
 */

type Actor = { error: string } | { me: { id: string; name: string; isSuperAdmin: boolean }; canLock: boolean };

async function actor(): Promise<Actor> {
  const user = await requireUser();
  if (await viewAsContext()) return { error: "Switch back to your own account first." };
  const me = await db.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, isSuperAdmin: true } });
  if (!me) return { error: "Sign in again." };
  return { me, canLock: me.isSuperAdmin || (await can(me.id, "users.lock")) };
}

function untilFrom(text: string | undefined | null, clock: Clock): { until: Date | null } | { error: string } {
  if (!text?.trim()) return { until: null };
  const until = clock.parseInput(text);
  if (!until) return { error: "That end time isn't a date and time." };
  if (until.getTime() <= Date.now()) return { error: "The end time has to be in the future — or leave it empty to lock until you lift it." };
  return { until };
}

function messageFrom(text: string | undefined | null): { message: string | null } | { error: string } {
  const message = (text ?? "").trim();
  if (message.length > LOCK_MESSAGE_MAX) return { error: `Keep the notice under ${LOCK_MESSAGE_MAX} characters.` };
  return { message: message || null };
}

/** Everything the locks page shows. Null for somebody who may do neither kind of lock. */
export async function getAccessLocks() {
  const a = await actor();
  if ("error" in a || !a.canLock) return null;
  const now = new Date();
  const [company, locked, candidates] = await Promise.all([
    db.companyLock.findUnique({ where: { id: "global" }, select: { enabled: true, message: true, until: true, lockedAt: true, lockedBy: { select: { name: true } } } }),
    db.user.findMany({
      where: { lockedAt: { not: null } },
      orderBy: { lockedAt: "desc" },
      select: { id: true, name: true, email: true, role: true, lockedAt: true, lockedUntil: true, lockMessage: true, lockedBy: { select: { name: true } } },
    }),
    db.user.findMany({
      // People only: naming `id` takes this past db's own filter (src/lib/db.ts).
      where: { active: true, isSuperAdmin: false, id: { not: a.me.id }, lockedAt: null, ...PEOPLE_ONLY },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, role: true },
    }),
  ]);
  return toPlain({
    isSuperAdmin: a.me.isSuperAdmin,
    company: company ? { ...company, active: companyLockActive(company, now), lockedBy: company.lockedBy?.name ?? null } : null,
    people: locked.map((u) => ({ ...u, active: personalLockActive(u, now), lockedBy: u.lockedBy?.name ?? null })),
    candidates,
  });
}

export async function lockUser(input: { userId: string; message?: string; until?: string }): Promise<ActionResult<null>> {
  const a = await actor();
  if ("error" in a) return { ok: false, error: a.error };
  if (!a.canLock) return { ok: false, error: "You can't lock people out." };
  if (typeof input?.userId !== "string" || input.userId === a.me.id) return { ok: false, error: "You can't lock yourself out." };
  const target = await db.user.findUnique({ where: { id: input.userId }, select: { id: true, name: true, email: true, active: true, isSuperAdmin: true } });
  if (!target || !target.active) return { ok: false, error: "That person isn't an active user." };
  // Never: the super admin is the one account that can always lift a lock.
  if (target.isSuperAdmin) return { ok: false, error: "The super admin can't be locked." };
  const m = messageFrom(input.message);
  if ("error" in m) return { ok: false, error: m.error };
  const clock = await workspaceClock();
  const u = untilFrom(input.until, clock);
  if ("error" in u) return { ok: false, error: u.error };

  await db.user.update({ where: { id: target.id }, data: { lockedAt: new Date(), lockedUntil: u.until, lockMessage: m.message, lockedById: a.me.id } });
  clearAccessCache();
  await recordAudit({
    userId: a.me.id,
    action: "UPDATE",
    entityType: "User",
    entityId: target.id,
    entityLabel: `${target.name} locked out of the CRM${u.until ? ` until ${clock.dateTime(u.until)}` : " until unlocked"}`,
  });
  revalidatePath("/settings/locks");
  return { ok: true, data: null };
}

export async function unlockUser(userId: string): Promise<ActionResult<null>> {
  const a = await actor();
  if ("error" in a) return { ok: false, error: a.error };
  if (!a.canLock) return { ok: false, error: "You can't lift locks." };
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, lockedAt: true } });
  if (!target?.lockedAt) return { ok: false, error: "That person isn't locked." };
  await db.user.update({ where: { id: target.id }, data: { lockedAt: null, lockedUntil: null, lockMessage: null, lockedById: null } });
  clearAccessCache();
  await recordAudit({ userId: a.me.id, action: "UPDATE", entityType: "User", entityId: target.id, entityLabel: `${target.name} unlocked` });
  revalidatePath("/settings/locks");
  return { ok: true, data: null };
}

/** Everybody but the super admin, with one notice. The confirmation phrase has to be typed. */
export async function lockCompany(input: { message?: string; until?: string; confirm: string }): Promise<ActionResult<null>> {
  const a = await actor();
  if ("error" in a) return { ok: false, error: a.error };
  if (!a.me.isSuperAdmin) return { ok: false, error: "Only the super admin can lock the whole company." };
  if (typeof input?.confirm !== "string" || input.confirm.trim().toUpperCase() !== COMPANY_LOCK_PHRASE) return { ok: false, error: `Type ${COMPANY_LOCK_PHRASE} to confirm.` };
  const m = messageFrom(input.message);
  if ("error" in m) return { ok: false, error: m.error };
  const clock = await workspaceClock();
  const u = untilFrom(input.until, clock);
  if ("error" in u) return { ok: false, error: u.error };

  const data = { enabled: true, message: m.message, until: u.until, lockedAt: new Date(), lockedById: a.me.id };
  await db.companyLock.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  clearAccessCache();
  await recordAudit({
    userId: a.me.id,
    action: "UPDATE",
    entityType: "CompanyLock",
    entityId: "global",
    entityLabel: `Whole company locked out of the CRM${u.until ? ` until ${clock.dateTime(u.until)}` : " until unlocked"}`,
  });
  revalidatePath("/settings/locks");
  return { ok: true, data: null };
}

export async function unlockCompany(): Promise<ActionResult<null>> {
  const a = await actor();
  if ("error" in a) return { ok: false, error: a.error };
  if (!a.me.isSuperAdmin) return { ok: false, error: "Only the super admin can lift the company lock." };
  await db.companyLock.upsert({ where: { id: "global" }, create: { id: "global", enabled: false }, update: { enabled: false } });
  clearAccessCache();
  await recordAudit({ userId: a.me.id, action: "UPDATE", entityType: "CompanyLock", entityId: "global", entityLabel: "Company lock lifted" });
  revalidatePath("/settings/locks");
  return { ok: true, data: null };
}
