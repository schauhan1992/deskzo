import type { MarketingTopic } from "@prisma/client";

/**
 * The notices somebody sends a customer by hand, about an order they already have.
 *
 * Three — a renewal coming up, a renewal confirmed, and an order fulfilled — all the same shape: raised
 * from a list, aimed at chosen contacts, about something the customer already bought. So they share
 * everything except the words: the recipient resolution, the suppression rules, the merge, the
 * send. See src/lib/marketing/order-notice.ts.
 *
 * Both are **transactional**. A notice about a service you pay for is not an offer, so an
 * unsubscribe from marketing does not silence it — while a bounce, a spam complaint or a reseller's
 * customer still does. That distinction is the whole reason `messageClass` exists.
 *
 * Every field in every template carries a fallback. A notice that cannot go out because a unit
 * price was never filled in is worse than one that reads slightly more generally.
 */

export type NoticeKind = "RENEWAL" | "RENEWED" | "FULFILMENT";

export type NoticeDefinition = {
  kind: NoticeKind;
  /** The dialog's title, and the verb on the button. */
  title: string;
  buttonLabel: string;
  /** Which saved templates are offered as an alternative to the standard wording. */
  topic: MarketingTopic;
  subject: string;
  body: string;
  /** Said under the send button, so nobody has to guess what the rules are. */
  footnote: string;
};

const SIGN_OFF = `

Thanks,
{{ourName}}

{{postalAddress|}}
Manage what we send you: {{unsubscribeUrl}}`;

export const RENEWAL_NOTICE: NoticeDefinition = {
  kind: "RENEWAL",
  title: "Send a renewal reminder",
  buttonLabel: "Send a renewal reminder",
  topic: "RENEWALS",
  subject: "{{productName|Your subscription}} renews on {{expiryDate|its renewal date}}",
  body: `Hi {{firstName|there}},

A quick note that {{companyName}}'s {{productName|subscription}} is due for renewal on {{expiryDate|its renewal date}}. {{daysLeftPhrase|}}

  Product   {{productName|—}}
  Quantity  {{quantity|—}}
  Expires   {{expiryDate|—}}
  Renewal   {{renewalValue|we'll confirm}}

{{ownerName|Your account manager}} will be in touch to confirm, but reply to this and we'll get it sorted.${SIGN_OFF}`,
  footnote:
    "Sent as a service notice about their own subscription, so it reaches people who have opted out of marketing — but never a bounced address, a spam complaint, or a reseller's customer.",
};

/**
 * The renewal confirmed (owner, 14 Oct 2026): what the mail icon on a renewed subscription sends in place
 * of the reminder, which would be wrong by then. Written about the renewal order — its number, the new
 * term, the quantity and PO it was renewed for.
 */
export const RENEWED_NOTICE: NoticeDefinition = {
  kind: "RENEWED",
  title: "Confirm the renewal",
  buttonLabel: "Send the confirmation",
  // Something that happened to their account, as an order done is — not a reminder of one to come.
  topic: "SERVICE",
  subject: "{{productName|Your subscription}} is renewed — {{orderId|your renewal}}",
  body: `Hi {{firstName|there}},

Thank you — {{companyName}}'s {{productName|subscription}} is renewed.

  Order     {{orderId|—}}
  Product   {{productName|—}}
  Quantity  {{quantity|—}}
  Your PO   {{poNumber|—}}
  Term      {{startDate|—}} to {{expiryDate|—}}

{{ownerName|Your account manager}} is on hand if anything isn't as you expected — just reply to this.${SIGN_OFF}`,
  footnote:
    "Sent as a service notice about their own subscription, so it reaches people who have opted out of marketing — but never a bounced address, a spam complaint, or a reseller's customer.",
};

export const FULFILMENT_NOTICE: NoticeDefinition = {
  kind: "FULFILMENT",
  title: "Tell them the order is done",
  buttonLabel: "Tell them it's done",
  // Not an offer and not a renewal — this is the "something happened to your account" topic.
  topic: "SERVICE",
  subject: "{{productName|Your order}} is ready — {{orderId|your order}}",
  body: `Hi {{firstName|there}},

Good news — {{companyName}}'s order is complete.

  Order     {{orderId|—}}
  Product   {{productName|—}}
  Quantity  {{quantity|—}}
  Your PO   {{poNumber|—}}
  Completed {{fulfilledDate|today}}

{{ownerName|Your account manager}} is on hand if anything isn't as you expected — just reply to this.${SIGN_OFF}`,
  footnote:
    "Sent as a service notice about their own order, so it reaches people who have opted out of marketing — but never a bounced address, a spam complaint, or a reseller's customer.",
};

export const NOTICES: Record<NoticeKind, NoticeDefinition> = {
  RENEWAL: RENEWAL_NOTICE,
  RENEWED: RENEWED_NOTICE,
  FULFILMENT: FULFILMENT_NOTICE,
};

/** Every notice here is about something the customer already pays for. */
export const NOTICE_MESSAGE_CLASS = "TRANSACTIONAL" as const;

/**
 * "That's 58 days away." or "That was 12 days ago." — a sentence of its own.
 *
 * A reminder that reads "expires on 9 Aug 2027 — 58" is the kind of thing that gets sent once and
 * then never lived down, and a subscription that has already lapsed is a different message from
 * one coming up.
 *
 * Self-contained, with no leading space: `render` trims every value it substitutes, so a clause
 * that depended on one would lose it and run into the word before.
 */
export function daysLeftPhrase(daysLeft: number | null): string | null {
  if (daysLeft === null || !Number.isFinite(daysLeft)) return null;
  if (daysLeft < 0) {
    const ago = Math.abs(daysLeft);
    return ago === 1 ? "That was yesterday." : `That was ${ago} days ago.`;
  }
  if (daysLeft === 0) return "That's today.";
  if (daysLeft === 1) return "That's tomorrow.";
  return `That's ${daysLeft} days away.`;
}

/**
 * Whether an order is far enough along to tell the customer it is done.
 *
 * Only once it is actually fulfilled. "Your order is ready" sent while purchasing is still sourcing
 * it is the single worst email in this whole module — it invites a delivery query nobody can answer
 * and it is impossible to take back.
 */
export function canAnnounceFulfilment(orderStatus: string): boolean {
  return orderStatus === "FULFILLED";
}

/**
 * Whether a renewal order is far enough along to tell the customer it is renewed: approved, or past
 * that. "Your renewal is confirmed" sent while the order still waits for approval, and then rejected,
 * cannot be taken back — the same reasoning as a fulfilment announced too early.
 */
export function canConfirmRenewal(orderStatus: string): boolean {
  return orderStatus === "APPROVED" || orderStatus === "PROCESSING" || orderStatus === "FULFILLED";
}

/** Whether a notice of this kind may go out about an order in this status — and why not, in words. */
export function noticeHeldBack(kind: NoticeKind, orderStatus: string): string | null {
  if (kind === "FULFILMENT" && !canAnnounceFulfilment(orderStatus)) return "That order isn't fulfilled yet, so there is nothing to announce.";
  if (kind === "RENEWED" && !canConfirmRenewal(orderStatus)) return "The renewal order is still waiting for approval — the confirmation can go once it's approved.";
  return null;
}
