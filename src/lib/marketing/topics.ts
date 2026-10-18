import type { MarketingTopic } from "@prisma/client";

/**
 * The subscriptions a customer can hold, separately.
 *
 * Lives here rather than beside the preference centre because a `"use server"` module may only
 * export async functions — an array exported from one fails the build rather than a type check,
 * which is a slow way to find out. Keeping it here also means the company page and the public
 * form read the same list.
 *
 * Topics rather than one on/off switch, because the binary version throws away information both
 * sides want: somebody tired of the newsletter usually still wants to know their subscription is
 * about to lapse.
 */
export const TOPICS: { key: MarketingTopic; label: string; blurb: string }[] = [
  { key: "RENEWALS", label: "Renewal reminders", blurb: "When a subscription or AMC is coming up for renewal." },
  { key: "SERVICE", label: "Service notices", blurb: "Outages, maintenance windows and anything affecting your systems." },
  { key: "OFFERS", label: "Offers and pricing", blurb: "Deals, bundles and vendor price changes." },
  { key: "PRODUCT_NEWS", label: "Product news", blurb: "New products and features worth knowing about." },
  { key: "EVENTS", label: "Events and webinars", blurb: "Invitations to things we run or take part in." },
  { key: "NEWSLETTER", label: "Newsletter", blurb: "The occasional round-up. No more than monthly." },
];

/**
 * Reminders about what a customer has with the company (owner, 18 Oct 2026): a renewal reminder, a
 * workflow's email about their order or booking. Sent unless they turn them off — not only when they
 * opt in, as offers are — so the preference centre shows them ticked until they untick them, and a
 * box left ticked records nothing.
 */
export const REMINDER_TOPICS: ReadonlySet<MarketingTopic> = new Set<MarketingTopic>(["RENEWALS", "SERVICE"]);

/**
 * When the preference centre began showing reminders ticked unless turned off — 18 Oct 2026, 18:30 in
 * India. Before it, every topic showed unticked until opted into, so saving the page left the reminders
 * "turned off" for somebody who never chose that; such an opt-out isn't held against them.
 */
export const REMINDER_OPT_OUTS_FROM = new Date("2026-10-18T13:00:00.000Z");

/**
 * Whether a consent row stops a reminder: turned off — by the customer in the preference centre since
 * it showed reminders honestly, or any other way (an import, a campaign's unsubscribe link).
 */
export function countsAsOptOut(row: { status: string; source: string; withdrawnAt: Date | null }): boolean {
  if (row.status !== "UNSUBSCRIBED") return false;
  return !(row.source === "PREFERENCE_CENTRE" && (row.withdrawnAt === null || row.withdrawnAt < REMINDER_OPT_OUTS_FROM));
}

