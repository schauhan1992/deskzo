import { cache } from "react";
import { randomUUID } from "node:crypto";
import type { Prisma, UnmaskResult } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { resolveUserPermissions } from "@/lib/authz/resolve";
import { workspaceClock } from "@/lib/time/workspace";
import { requestFacts } from "@/lib/access/request";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";

/**
 * The daily unmask limit: how many distinct leads one person may unmask in one business day.
 *
 * ## What counts
 *
 * A lead, once a day. The first time somebody reveals a lead's masked fields on its page that day,
 * one unit is used and an `UnmaskUsage` row says so; revealing its email, phone and company together
 * is still that one unit, and opening it again — a reload, the back button, another tab — finds the
 * row and uses nothing. A different lead is another unit. When the units are gone, a lead not yet
 * unmasked that day stays masked, and its page says why. The day is the workspace's, on its own
 * clock (Settings › Organisation › Time zone), so it turns over at the workspace's midnight.
 *
 * ## Why it is a lock, a count and an insert in one transaction
 *
 * Two requests at the same moment must not both see "49 of 50 used" and both take the fiftieth. Each
 * attempt takes a transaction-scoped advisory lock on the person and the day before it counts, so the
 * check and the write for one person and day happen one at a time — the seat-cap pattern in
 * src/actions/forms.ts. The unique (person, day, lead) index is the second line: a repeat can never
 * write a second row, whatever happens above it. The log row is written in the same transaction, so a
 * unit is never used without the attempt being recorded.
 *
 * ## What it doesn't decide
 *
 * Whether somebody may unmask a field at all is field access (src/lib/authz/fields.ts), and which
 * leads they reach is the record engine (src/lib/authz/access.ts). Both are asked again on every
 * request: a usage row from this morning shows nothing to somebody whose access was taken away since.
 */

/** The largest limit an admin may set — a typo guard, not a business rule. */
export const MAX_DAILY_UNMASK_LIMIT = 10_000;

export type UnmaskLimitSource =
  | { via: "superAdmin" }
  | { via: "userLimit"; reason: string | null; expiresAt: Date | null }
  | { via: "roleLimit"; role: string }
  | { via: "none" };

/** A person's limit: a number of leads a day, or null for no limit. */
export type UnmaskLimit = { dailyLimit: number | null; source: UnmaskLimitSource };

const limitOf = cache(async (userId: string): Promise<UnmaskLimit> => {
  const resolved = await resolveUserPermissions(userId);
  if (resolved.isSuperAdmin) return { dailyLimit: null, source: { via: "superAdmin" } };
  try {
    const own = await db.userUnmaskLimit.findUnique({
      where: { userId },
      select: { limited: true, dailyLimit: true, reason: true, expiresAt: true },
    });
    if (own && (own.expiresAt === null || own.expiresAt.getTime() > Date.now())) {
      return { dailyLimit: own.limited ? own.dailyLimit : null, source: { via: "userLimit", reason: own.reason, expiresAt: own.expiresAt } };
    }
    if (resolved.role) {
      const forRole = await db.roleUnmaskLimit.findUnique({ where: { role: resolved.role }, select: { dailyLimit: true } });
      if (forRole) return { dailyLimit: forRole.dailyLimit, source: { via: "roleLimit", role: resolved.role } };
    }
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return { dailyLimit: null, source: { via: "none" } };
});

/** One person's daily unmask limit, and where it comes from. */
export async function unmaskLimitFor(userId: string): Promise<UnmaskLimit> {
  return limitOf(userId);
}

/** Today, as the business day the limit counts in: YYYY-MM-DD on the workspace's clock. */
export async function businessDate(at: Date = new Date()): Promise<string> {
  return (await workspaceClock()).dateKey(at);
}

export type UnmaskUsageStatus = {
  businessDate: string;
  used: number;
  /** Null for no limit. */
  limit: number | null;
  /** Null for no limit. */
  remaining: number | null;
};

/** How many leads one person has unmasked today, against their limit — the counter the screens show. */
export async function unmaskUsageToday(userId: string): Promise<UnmaskUsageStatus> {
  const [day, limit] = await Promise.all([businessDate(), limitOf(userId)]);
  let used = 0;
  try {
    used = await db.unmaskUsage.count({ where: { userId, businessDate: day } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return { businessDate: day, used, limit: limit.dailyLimit, remaining: limit.dailyLimit === null ? null : Math.max(0, limit.dailyLimit - used) };
}

/** Whether this person unmasked this lead today — what lets its page show it unmasked again. */
export const revealedToday = cache(async (userId: string, leadId: string): Promise<boolean> => {
  try {
    const day = await businessDate();
    const row = await db.unmaskUsage.findUnique({
      where: { userId_businessDate_leadId: { userId, businessDate: day, leadId } },
      select: { id: true },
    });
    return row !== null;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
});

/** Where an attempt came from, for its log row. Never anything typed into a field. */
export type UnmaskRequestMeta = { requestId: string; ip: string | null; userAgent: string | null; tenantId: string | null };

export async function unmaskRequestMeta(): Promise<UnmaskRequestMeta> {
  const [facts, tenant, given] = await Promise.all([requestFacts(), currentTenantOrNull(), forwardedRequestId()]);
  return {
    requestId: given ?? randomUUID(),
    ip: facts.ip,
    // A user agent is the browser's own string; capped so a crafted one can't fill the log.
    userAgent: facts.userAgent ? facts.userAgent.slice(0, 400) : null,
    tenantId: tenant?.id ?? null,
  };
}

/** A request id the proxy in front of the app set, when it set one that looks like an id. */
async function forwardedRequestId(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const id = (await headers()).get("x-request-id");
    return id && /^[A-Za-z0-9._:-]{8,128}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export type UnmaskSubject = {
  userId: string;
  userName: string;
  impersonatedByUserId: string | null;
  leadId: string;
  leadRef: string | null;
};

export type UnmaskAttempt = {
  result: UnmaskResult;
  consumed: boolean;
  usage: UnmaskUsageStatus;
};

/**
 * Tries to unmask one lead for one person: takes a unit if this is the lead's first reveal today and
 * one is left, and logs the attempt either way. The caller has already decided which fields this
 * person may unmask on this lead (`fields`, never empty) — this only counts and records.
 */
export async function attemptUnmask(subject: UnmaskSubject, fields: string[], meta: UnmaskRequestMeta): Promise<UnmaskAttempt> {
  if (fields.length === 0) throw new Error("attemptUnmask: no fields to unmask.");
  const [day, limit] = await Promise.all([businessDate(), limitOf(subject.userId)]);

  const outcome = await db.$transaction(async (tx) => {
    // One attempt at a time per person and day: the count below and the insert after it can't be
    // split by a request arriving in between.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`unmask:${subject.userId}:${day}`}))`;

    const already = await tx.unmaskUsage.findUnique({
      where: { userId_businessDate_leadId: { userId: subject.userId, businessDate: day, leadId: subject.leadId } },
      select: { id: true },
    });
    const used = await tx.unmaskUsage.count({ where: { userId: subject.userId, businessDate: day } });

    let result: UnmaskResult;
    let consumed = false;
    let usedAfter = used;
    if (already) {
      result = "REPEAT";
    } else if (limit.dailyLimit !== null && used >= limit.dailyLimit) {
      result = "QUOTA_EXHAUSTED";
    } else {
      await tx.unmaskUsage.create({ data: { userId: subject.userId, businessDate: day, leadId: subject.leadId, fields } });
      result = "ALLOWED";
      consumed = true;
      usedAfter = used + 1;
    }

    await tx.unmaskEvent.create({
      data: eventRow(subject, meta, day, {
        fields,
        result,
        consumed,
        usedToday: usedAfter,
        dailyLimit: limit.dailyLimit,
        reason: result === "QUOTA_EXHAUSTED" ? `Daily limit of ${limit.dailyLimit} leads reached.` : null,
      }),
    });
    return { result, consumed, used: usedAfter };
  });

  return {
    result: outcome.result,
    consumed: outcome.consumed,
    usage: {
      businessDate: day,
      used: outcome.used,
      limit: limit.dailyLimit,
      remaining: limit.dailyLimit === null ? null : Math.max(0, limit.dailyLimit - outcome.used),
    },
  };
}

/**
 * Logs a refused attempt — no reach, no permission to unmask, or while viewing as somebody. Nothing is
 * counted. Never throws: a refusal is answered whether or not its log row could be written.
 */
export async function logUnmaskDenied(subject: UnmaskSubject, fields: string[], reason: string, meta: UnmaskRequestMeta): Promise<void> {
  try {
    const day = await businessDate();
    await db.unmaskEvent.create({ data: eventRow(subject, meta, day, { fields, result: "DENIED", consumed: false, usedToday: null, dailyLimit: null, reason }) });
  } catch (err) {
    console.error("[unmask] could not log a refused attempt:", err instanceof Error ? err.message : err);
  }
}

function eventRow(
  subject: UnmaskSubject,
  meta: UnmaskRequestMeta,
  day: string,
  outcome: { fields: string[]; result: UnmaskResult; consumed: boolean; usedToday: number | null; dailyLimit: number | null; reason: string | null },
): Prisma.UnmaskEventCreateInput {
  return {
    businessDate: day,
    tenantId: meta.tenantId,
    userId: subject.userId,
    userName: subject.userName,
    impersonatedByUserId: subject.impersonatedByUserId,
    // The id is whatever the caller sent for a lead that couldn't be found; capped for the same reason.
    leadId: subject.leadId.slice(0, 64),
    leadRef: subject.leadRef,
    fields: outcome.fields,
    result: outcome.result,
    consumed: outcome.consumed,
    usedToday: outcome.usedToday,
    dailyLimit: outcome.dailyLimit,
    reason: outcome.reason,
    requestId: meta.requestId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  };
}
