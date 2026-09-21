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

