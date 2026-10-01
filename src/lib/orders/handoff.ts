import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { PEOPLE_ONLY } from "@/lib/people";
import { formatOrderId } from "@/lib/order-id";
import { istCalendarDate } from "@/lib/india-time";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { automationUserId } from "@/lib/automation-user";

/**
 * The server half of an order's hand-off to purchase (the pure rules are in ./handoff-rules.ts):
 * telling purchase an order has reached them, releasing scheduled orders on their day, and booking an
 * in-hand order when its first payment arrives.
 *
 * A plain module, not `"use server"`: nothing here checks who is asking, so none of it may be a
 * client-callable endpoint. The actions in src/actions/order.ts, payment.ts and receivable.ts call it
 * after their own checks; the heartbeat calls the daily release.
 */

/** Every active person (not a support or Automation account) who holds a permission, less `except`. */
export async function peopleHolding(permission: string, except: (string | null | undefined)[] = []): Promise<string[]> {
  const people = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { id: true } });
  const skip = new Set(except.filter((id): id is string => !!id));
  const holders: string[] = [];
  for (const person of people) {
    if (!skip.has(person.id) && (await can(person.id, permission))) holders.push(person.id);
  }
  return holders;
}

/**
 * Tells purchase an order is theirs to process. Called when an order becomes approved *and* released —
 * from whichever side got there second: the salesperson's go-ahead on an approved order, the scheduled
 * day arriving, or accounts approving an order that was already released.
 */
export async function tellPurchase(
  order: { id: string; orderSeq: number; companyName: string },
  why: string,
  exceptUserId?: string | null,
) {
  const holders = await peopleHolding("orders.process", [exceptUserId]);
  await Promise.all(
    holders.map((userId) =>
      notifyUser({
        userId,
        type: "ORDER_STATUS_CHANGED",
        title: `${formatOrderId(order.orderSeq)} is ready for purchase`,
        message: `${order.companyName} — ${why}`,
        link: `/orders/${order.id}`,
      }),
    ),
  );
}

/**
 * Releases every scheduled order whose day has come (its `releaseOn` is today or earlier, in India).
 *
 * Each order is claimed with a conditional update — `purchaseRelease` still SCHEDULED — so the daily job
 * and a purchase screen releasing lazily at the same moment release it once, and purchase is told once.
 * An order with no payment yet counts as booked from this moment (O-D2).
 *
 * `onlyIds` narrows it to the orders a screen is about to show.
 */
export async function releaseDueOrders(now: Date = new Date(), onlyIds?: string[]): Promise<string[]> {
  // A `@db.Date` compared with midnight UTC of today's Indian date: exact by calendar day.
  const today = istCalendarDate(now);
  const due = await db.companyProduct.findMany({
    where: {
      purchaseRelease: "SCHEDULED",
      releaseOn: { lte: today },
      orderStatus: { notIn: ["CANCELLED", "REJECTED", "FULFILLED"] },
      ...(onlyIds ? { id: { in: onlyIds } } : {}),
    },
    select: { id: true, orderSeq: true, orderStatus: true, releaseOn: true, company: { select: { name: true } } },
  });
  if (due.length === 0) return [];

  const released: string[] = [];
  let actorId: string | null | undefined;
  for (const order of due) {
    const claim = await db.companyProduct.updateMany({
      where: { id: order.id, purchaseRelease: "SCHEDULED" },
      data: { purchaseRelease: "RELEASED", releaseOn: null, releasedAt: now, releasedById: null },
    });
    if (claim.count !== 1) continue;
    await db.companyProduct.updateMany({ where: { id: order.id, bookedAt: null }, data: { bookedAt: now } });
    released.push(order.id);

    // The schedule released it, not whoever happened to open a screen: the Automation account signs it.
    if (actorId === undefined) actorId = await automationUserId().catch(() => null);
    if (actorId) {
      await recordAudit({
        userId: actorId,
        action: "UPDATE",
        entityType: "Order",
        entityId: order.id,
        entityLabel: `${formatOrderId(order.orderSeq)} went to purchase on its scheduled day`,
      });
    }
    if (order.orderStatus === "APPROVED") {
      await tellPurchase({ id: order.id, orderSeq: order.orderSeq, companyName: order.company.name }, "released on its scheduled day.");
    }
  }
  return released;
}

/** The claim key in `DailyJobRun`. */
export const ORDER_RELEASE_JOB = "order-release";

/**
 * The heartbeat's daily release, once per workspace per India day — the `DailyJobRun (order-release,
 * day)` row is the claim, as src/lib/close/nightly.ts claims its run: whoever inserts it releases, and a
 * later tick (or a second server firing the same tick) hits the key and leaves.
 *
 * Purchase's screens also release due orders lazily when they load, so a missed tick never holds an
 * order back; this is what makes sure it goes on the day even if nobody looks.
 */
export async function runOrderReleases(now: Date = new Date()): Promise<{ ran: boolean; released: number; reason?: string }> {
  if (!(await moduleAvailableForTenant("orders"))) return { ran: false, released: 0, reason: "the orders module is off" };
  const day = istCalendarDate(now);
  const key = { job_day: { job: ORDER_RELEASE_JOB, day } };
  if (await db.dailyJobRun.findUnique({ where: key, select: { job: true } })) {
    return { ran: false, released: 0, reason: "already ran today" };
  }
  try {
    await db.dailyJobRun.create({ data: { job: ORDER_RELEASE_JOB, day, ranAt: now } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ran: false, released: 0, reason: "another run claimed today" };
    }
    throw err;
  }
  try {
    const released = await releaseDueOrders(now);
    await db.dailyJobRun.update({ where: key, data: { ok: true } }).catch(() => undefined);
    return { ran: true, released: released.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db.dailyJobRun.update({ where: key, data: { ok: false, error: error.slice(0, 2000) } }).catch(() => undefined);
    console.error("order release failed", err);
    return { ran: true, released: 0, reason: error };
  }
}

/**
 * The first payment against an in-hand order books it, at that moment (O-D2): until then a held or
 * scheduled order counts toward nothing. Every other order already has `bookedAt`, so this touches
 * only the ones waiting, and a cancelled order never books.
 *
 * Called inside the transaction that writes the allocation, so the two can't disagree.
 */
export async function bookOnFirstPayment(
  tx: Prisma.TransactionClient,
  where: Prisma.CompanyProductWhereInput,
  at: Date,
): Promise<number> {
  const { count } = await tx.companyProduct.updateMany({
    where: { AND: [where, { bookedAt: null, orderStatus: { not: "CANCELLED" } }] },
    data: { bookedAt: at },
  });
  return count;
}
