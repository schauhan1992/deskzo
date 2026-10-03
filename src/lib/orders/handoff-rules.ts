import { MONTH_NAMES, type Clock } from "@/lib/time/zone";

/**
 * The rules of an order's hand-off to purchase, the salesperson's distributor price, and what purchase
 * saved against it — pure, so the form, the order page, the actions and check:order-handoff all read
 * the same answer.
 *
 * Dependency-free on purpose (no Prisma client, no database — the pure clock module only): client
 * components import it. "Today" is the workspace's: the clock is passed in — `workspaceClock()` on the
 * server, `useClock()` in a component.
 *
 * ## The hand-off
 *
 * A salesperson punching an in-hand order (an advance PO from the customer) wants it on the books and
 * visible, not in purchase's queue. So an order is either with purchase (RELEASED, the default and what
 * every other path makes), held by sales (HELD), or scheduled to go on a day (SCHEDULED, `releaseOn`).
 * Purchase can only process an order that is approved **and** released.
 *
 * ## The distributor price, and what counts as a saving
 *
 * The salesperson may record the price a distributor gave them. When purchase buys at or below it, the
 * difference times the quantity is purchase's saving; above it, purchase must say why and the
 * salesperson must accept the higher price. A saving is only ever measured against a price somebody
 * *other than the purchaser* entered — a purchaser who typed the benchmark could set it wherever they
 * liked (owner decision O-D1: no salesperson's price, no saving).
 */

export type Handoff = "NOW" | "HOLD" | "SCHEDULE";
export type ReleaseState = "HELD" | "SCHEDULED" | "RELEASED";

export const handoffLabels: Record<Handoff, string> = {
  NOW: "Send to purchase now",
  HOLD: "Hold (in-hand order)",
  SCHEDULE: "Schedule on a date",
};

/*
 * Today as `yyyy-mm-dd` is `clock.today(now)` — the workspace's. This file's istTodayKey was India's,
 * by a fixed offset.
 */

/** A `@db.Date` value (midnight UTC of its day) as `yyyy-mm-dd`. */
export function dateKeyOf(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `yyyy-mm-dd` → the calendar day as a `@db.Date` holds it (midnight UTC), or null when it isn't a date. */
export function calendarDay(key: string): Date | null {
  const match = DATE_KEY.exec(key.trim());
  if (!match) return null;
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  // 31 February is not a date, and Date.UTC would quietly make it 3 March.
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== key.trim() ? null : at;
}

/**
 * The go-ahead date a salesperson chose, checked: a real date, after today on the workspace's
 * calendar, and within a year (a date years out is a typo, and would sit in the queue unnoticed).
 */
export function checkReleaseDate(key: string | null | undefined, now: Date, clock: Clock): { ok: true; day: Date } | { ok: false; error: string } {
  if (!key || !key.trim()) return { ok: false, error: "Choose the day it goes to purchase." };
  const day = calendarDay(key);
  if (!day) return { ok: false, error: "That isn't a date." };
  const today = clock.today(now);
  if (key.trim() <= today) {
    return { ok: false, error: "Choose a day after today — to send it today, send it to purchase now." };
  }
  const limit = calendarDay(today)!.getTime() + 366 * 86_400_000;
  if (day.getTime() > limit) return { ok: false, error: "Choose a day within the next year." };
  return { ok: true, day };
}

/**
 * "12 Oct" or "12 Oct 2027" — a `@db.Date` day, read by its UTC parts (it is a calendar date), with
 * the year when it isn't this year on the workspace's calendar. In the clock's words: Intl's en-IN
 * month names differ between Node and browsers ("Sept"), and the order list renders on both.
 */
export function shortDay(value: Date | string, clock: Clock, now: Date = new Date()): string {
  const d = new Date(value);
  const sameYear = d.getUTCFullYear() === clock.parts(now).year;
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}${sameYear ? "" : ` ${d.getUTCFullYear()}`}`;
}

/**
 * The badge an order carries while purchase can't have it yet, or null once it can. Written for the
 * order list, the split pane and the order page alike.
 */
export function handoffBadge(order: { purchaseRelease: ReleaseState; releaseOn: Date | string | null }, clock: Clock, now: Date = new Date()): string | null {
  if (order.purchaseRelease === "HELD") return "In hand — not yet sent to purchase";
  if (order.purchaseRelease === "SCHEDULED" && order.releaseOn) return `Goes to purchase on ${shortDay(order.releaseOn, clock, now)}`;
  return null;
}

/** Whether purchase may process it now: approved (or already in progress) and released. */
export function inPurchaseQueue(order: { orderStatus: string; purchaseRelease: ReleaseState }): boolean {
  return (order.orderStatus === "APPROVED" || order.orderStatus === "PROCESSING") && order.purchaseRelease === "RELEASED";
}

/** Rupees and paise, as money is stored: rounded half away from zero to two places. */
export function round2(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n) * 100 + Number.EPSILON) / 100;
}

/**
 * What purchase saved against the salesperson's price: (quoted − actual) × quantity. Negative when an
 * increase was accepted — the performance view should say so rather than show nothing.
 */
export function savingAmount(quoted: number, actual: number, quantity: number): number {
  // In paise, so ₹0.10 × 3 is 30 paise and not 0.30000000000000004 rupees.
  const paise = Math.round(quoted * 100) - Math.round(actual * 100);
  return round2((paise * quantity) / 100);
}

/**
 * The most purchase may pay without asking sales again: the salesperson's price, or — once sales has
 * accepted a higher one and the order is being processed at it — that accepted price. Null when there
 * is no price to hold purchase to (no quote, or the purchaser entered it themselves).
 */
export function priceCeiling(order: {
  quotedPurchasePrice: number | null;
  quotedById: string | null;
  orderStatus: string;
  purchasePrice: number | null;
}, purchaserId: string): number | null {
  if (order.quotedPurchasePrice === null || order.quotedById === purchaserId) return null;
  const accepted = order.orderStatus === "PROCESSING" && order.purchasePrice !== null ? order.purchasePrice : null;
  return accepted !== null && accepted > order.quotedPurchasePrice ? accepted : order.quotedPurchasePrice;
}

/** Whether the purchase price asks for sales' agreement: above the ceiling. */
export function needsSalesApproval(ceiling: number | null, actual: number): boolean {
  return ceiling !== null && Math.round(actual * 100) > Math.round(ceiling * 100);
}

/** The shortest reason accepted for buying above the salesperson's price. */
export const MIN_INCREASE_REASON = 10;

/** The margin a price implies, per the order: (sale − cost) × quantity, and as a share of the sale. */
export function impliedMargin(salePrice: number, cost: number, quantity: number): { margin: number; percent: number | null } {
  const margin = round2((salePrice - cost) * quantity);
  const revenue = salePrice * quantity;
  return { margin, percent: revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : null };
}

export const priceEventLabels: Record<"QUOTED" | "PURCHASED" | "INCREASE_REQUESTED" | "INCREASE_ACCEPTED" | "SENT_BACK", string> = {
  QUOTED: "Distributor price entered",
  PURCHASED: "Purchased",
  INCREASE_REQUESTED: "Higher price proposed",
  INCREASE_ACCEPTED: "Higher price accepted",
  SENT_BACK: "Sent back to purchase",
};

export const vendorPoLabels: Record<"PENDING" | "CANCELLED" | "NOT_NEEDED", string> = {
  PENDING: "Vendor PO to cancel",
  CANCELLED: "Vendor PO cancelled",
  NOT_NEEDED: "Vendor PO cancellation not needed",
};
