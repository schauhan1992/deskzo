import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  Prisma,
  type CampaignStatus,
  type ConsentSource,
  type ConsentStatus,
  type ContactDesignation,
  type EmailCheckStatus,
  type FormCategory,
  type FormFillMode,
  type JourneyStatus,
  type MarketingTopic,
  type MessageChannel,
  type MessageClass,
  type MessageEventType,
  type MessageStatus,
  type PortalRequestKind,
  type PortalRequestStatus,
  type PrismaClient,
  type ProjectBillingStatus,
  type ProjectDocumentType,
  type ProjectHealth,
  type ProjectRiskKind,
  type ProjectRiskSeverity,
  type ProjectRiskStatus,
  type ProjectStakeholderRole,
  type ProjectStatus,
  type SuppressionReason,
  type SuppressionScope,
  type TemplateFormat,
  type TicketPriority,
} from "@prisma/client";
import type { DemoContext } from "../context";
import { DEMO_TAG, chance, daysAgo, daysAhead, duringWorkHours, int, log, pick, some } from "../shared";
import {
  buildMarketingEmail,
  mergeValuesFor,
  newToken,
  subscriptionMergeValues,
  type MarketingSettings,
  type Recipient,
} from "../../../src/lib/marketing/pipeline";
import { canSend, type RecipientState, type SendVerdict } from "../../../src/lib/marketing/suppression";
import { fieldsUsed, render, type MergeValues } from "../../../src/lib/marketing/merge";
import { sanitizeEmailHtml } from "../../../src/lib/marketing/html";
import { capPerCompany, type ContactFilters } from "../../../src/lib/marketing/audience";
import { nextSendTime } from "../../../src/lib/marketing/schedule";
import { enrolmentKey, exitLabels, stepDueAt } from "../../../src/lib/marketing/journey";
import { TOPICS } from "../../../src/lib/marketing/topics";
import { NOTICES, canAnnounceFulfilment, daysLeftPhrase, type NoticeKind } from "../../../src/lib/marketing/customer-notices";
import { postalAddressFor } from "../../../src/lib/marketing/footer";
import { checkFieldsForSave, joinPicks, summariseAnswers, validateAnswers, type Answers, type FormField } from "../../../src/lib/marketing/form-fields";
import { currentKeys } from "../../../src/lib/tenancy/keys";
import { categoryOf } from "../../../src/lib/forms/categories";
import { checkFormSettings } from "../../../src/lib/forms/settings";
import { inviteLink, inviteVerdict } from "../../../src/lib/forms/invites";
import { reviewInvitation } from "../../../src/lib/feedback/rating";
import { milestonesFromTemplate } from "../../../src/lib/projects/status";
import { checkUpload } from "../../../src/lib/hr/document-upload";
import { closedDates } from "../../../src/lib/hr/calendar";
import { financialYearOf } from "../../../src/lib/gst-engine";
import { formatCalendarDay, indiaClock } from "../../../src/lib/time/zone";
import { formatOrderId } from "../../../src/lib/order-id";
import { formatCurrency } from "../../../src/lib/utils";
import { getTicketSlaStatus } from "../../../src/lib/tickets";
import { daysOverdue } from "../../../src/lib/receivables";

/**
 * Reach: marketing, forms, customer feedback, the customer portal and projects — every status a
 * record in those modules can be in, on the demo company's own people and accounts.
 *
 * ## Built the way the app builds it
 *
 * Nothing here is sent, and nothing leaves the machine. But every row is the one the app would have
 * written had it been: a campaign's recipients are worked out from its audience and list the way
 * `resolveRecipients` does, each one judged by the app's own `canSend` against the consent and
 * suppressions that stood on that day, its email built by `buildMarketingEmail`, and what happened
 * next — delivered, opened, clicked, bounced, marked as spam — recorded as the webhook and the
 * tracking pixel record it, side effects included: a hard bounce suppresses the address and marks the
 * contact's address dead, an unsubscribe withdraws every topic. A campaign's open rate is therefore
 * the open rate of messages that exist, not a number painted on a dashboard.
 *
 * ## The two rules kept above all
 *
 *   · **A reseller's end customer is never reached.** Every company here is checked against
 *     `managedByResellerId` before anything is aimed at it — no consent, no message, no invitation, no
 *     portal link and no feedback request (src/lib/reseller.ts).
 *   · **Nothing can go out later by accident.** The only QUEUED messages are WhatsApp ones, whose
 *     provider is switched off, so a tick that picks them up leaves them waiting. No email is left
 *     QUEUED for a scheduler to send through a provider with demo credentials, and no journey that
 *     sends email is left with somebody part-way through it (pausing a journey does not stop its
 *     enrolments advancing — see the report).
 *
 * Re-running is safe: every section checks for what it made last time and tops up or skips.
 */

const HOUR = 3600000;
const DAY = 86400000;
const clock = indiaClock;
/** Where the links in a message point. Only ever text in a stored body — nothing is fetched. */
const ORIGIN = (process.env.INTERNAL_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
/** The same 1×1 "scan" the main demo files its documents as — a picture, not a binary upload. */
const SCAN = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Person = DemoContext["people"][number];

type Co = {
  id: string;
  name: string;
  relationshipType: string;
  stage: string;
  managedByResellerId: string | null;
  ownerUserId: string | null;
  assignedToUserId: string | null;
  createdAt: Date;
  ownerName: string | null;
  ownerEmail: string | null;
};

type Ct = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  designation: ContactDesignation;
  companyId: string;
  createdAt: Date;
  emailStatus: EmailCheckStatus;
  emailCheckedValue: string | null;
  emailCheckedAt: Date | null;
};

type ConsentRow = { status: ConsentStatus; capturedAt: Date; withdrawnAt: Date | null };
type SuppRow = { scope: SuppressionScope; value: string; reason: SuppressionReason; createdAt: Date; expiresAt: Date | null };
type FbRow = { companyId: string; rating: number; submittedAt: Date; acknowledgedAt: Date | null };
type TicketRow = { companyId: string; priority: TicketPriority; createdAt: Date; doneAt: Date | null };
type InvoiceRow = { companyId: string; issueDate: Date; dueDate: Date | null };

type Cast = {
  marketer: Person;
  approver: Person;
  director: Person;
  supportLead: Person;
  finance: Person;
  sales: Person[];
  support: Person[];
  presales: Person[];
  managers: Person[];
};

type World = {
  db: PrismaClient;
  ctx: DemoContext;
  now: Date;
  cast: Cast;
  settings: MarketingSettings;
  feedbackDays: number;
  reviewMinRating: number;
  reviewUrl: string | null;
  trackingKey: Buffer | null;
  companies: Map<string, Co>;
  contacts: Map<string, Ct>;
  byCompany: Map<string, Ct[]>;
  /** Every demo company marketing may reach — anything not managed by a reseller. */
  marketable: Co[];
  /** Of those, the clients actually buying from us. */
  customers: Co[];
  consents: Map<string, ConsentRow>;
  suppressions: SuppRow[];
  feedback: FbRow[];
  /** Tickets, with when they stopped being open — for "past its SLA" on the day. */
  tickets: TicketRow[];
  /** Invoices still unsettled today — for "overdue" on the day. */
  invoices: InvoiceRow[];
  /** Marketing sent to each contact, for the weekly frequency cap. */
  sends: Map<string, Date[]>;
  providers: Map<string, string>;
};

// ─── Small helpers ──────────────────────────────────────────────────────────────────────────────

/** A stable share in [0, 1) for an id — so a choice made by id is the same on every run. */
function share(id: string): number {
  return parseInt(createHash("sha1").update(id).digest("hex").slice(0, 8), 16) / 2 ** 32;
}
const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);
const earlier = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
/** A share in [0, 1) from the demo's own PRNG — the only randomness allowed to shape the data. */
function rndShare() {
  return int(0, 9999) / 10000;
}
/** A moment somewhere between two others; the first when they are the wrong way round. */
function between(from: Date, to: Date): Date {
  const span = to.getTime() - from.getTime();
  return span <= 0 ? from : new Date(from.getTime() + Math.floor(span * rndShare()));
}
/** A moment that has already happened. */
function past(w: World, d: Date): Date {
  return earlier(d, new Date(w.now.getTime() - 60000));
}
/** A working-hours moment on that day, never in the future. */
function workTime(w: World, d: Date): Date {
  return past(w, duringWorkHours(d));
}
const consentKey = (contactId: string, channel: MessageChannel, topic: MarketingTopic) => `${contactId}|${channel}|${topic}`;
const domainOf = (email: string) => email.split("@")[1]!.toLowerCase();
const companyShort = (name: string) => name.split(" ").slice(0, 2).join(" ");

function isVerified(c: Ct, when: Date): boolean {
  return (
    c.emailStatus === "VALID" &&
    !!c.email &&
    c.emailCheckedValue === c.email &&
    c.emailCheckedAt !== null &&
    c.emailCheckedAt.getTime() <= when.getTime()
  );
}

function consentAsOf(row: ConsentRow | undefined, when: Date): ConsentStatus | null {
  if (!row || row.capturedAt.getTime() > when.getTime()) return null;
  // Withdrawn later than this: on this day they were still in.
  if (row.status === "UNSUBSCRIBED" && row.withdrawnAt && row.withdrawnAt.getTime() > when.getTime()) return "SUBSCRIBED";
  return row.status;
}

/** `canSend`, asked with the facts as they stood on the day — the app's own verdict, not a copy of it. */
function verdictFor(w: World, c: Ct, channel: MessageChannel, topic: MarketingTopic, messageClass: MessageClass, when: Date): SendVerdict {
  return canSend(stateFor(w, c, channel, topic, when), { messageClass, channel, topic, limits: w.settings.limits });
}

function stateFor(w: World, c: Ct, channel: MessageChannel, topic: MarketingTopic, when: Date): RecipientState {
  const company = w.companies.get(c.companyId)!;
  const address = c.email?.trim().toLowerCase() ?? null;
  const domain = address ? domainOf(address) : null;
  const t = when.getTime();
  const mine = w.suppressions.filter(
    (s) =>
      s.createdAt.getTime() <= t &&
      (!s.expiresAt || s.expiresAt.getTime() > t) &&
      ((s.scope === "EMAIL" && address !== null && s.value === address) ||
        (s.scope === "CONTACT" && s.value === c.id) ||
        (s.scope === "COMPANY" && s.value === c.companyId) ||
        (s.scope === "DOMAIN" && domain !== null && s.value === domain)),
  );
  const consent = consentAsOf(w.consents.get(consentKey(c.id, channel, topic)), when);
  const unanswered = w.feedback.filter(
    (f) => f.companyId === c.companyId && f.rating <= 3 && f.submittedAt.getTime() <= t && (!f.acknowledgedAt || f.acknowledgedAt.getTime() > t),
  ).length;
  const week = (w.sends.get(c.id) ?? []).filter((d) => d.getTime() <= t && d.getTime() > t - 7 * DAY).length;
  // The two the pipeline reads from tickets and invoices, as they stood on the day.
  const breached = w.tickets.filter(
    (k) =>
      k.companyId === c.companyId &&
      k.createdAt.getTime() <= t &&
      (!k.doneAt || k.doneAt.getTime() > t) &&
      getTicketSlaStatus(k.priority, "OPEN", k.createdAt, clock, when).key === "overdue",
  ).length;
  const overdue = w.invoices
    .filter((i) => i.companyId === c.companyId && i.issueDate.getTime() <= t && i.dueDate !== null && i.dueDate.getTime() < t)
    .reduce((worst, i) => Math.max(worst, daysOverdue(i.dueDate, i.issueDate, when)), 0);
  return {
    company: { managedByResellerId: company.managedByResellerId },
    contact: {
      email: c.email,
      phone: c.phone,
      emailStatus: c.emailCheckedAt && c.emailCheckedAt.getTime() <= t ? c.emailStatus : "UNCHECKED",
      emailCheckedValue: c.emailCheckedAt && c.emailCheckedAt.getTime() <= t ? c.emailCheckedValue : null,
    },
    suppressions: mine.map((s) => ({ reason: s.reason })),
    consent: consent ? { status: consent } : null,
    signals: { unansweredFeedback: unanswered, daysOverdue: overdue > 0 ? overdue : null, breachedTickets: breached, sentInLastWeek: week },
  };
}

function recipientOf(w: World, c: Ct, when: Date): Recipient {
  const company = w.companies.get(c.companyId)!;
  return {
    contactId: c.id,
    companyId: c.companyId,
    companyName: company.name,
    name: c.name,
    email: c.email,
    phone: c.phone,
    ownerName: company.ownerName,
    ownerEmail: company.ownerEmail,
    state: stateFor(w, c, "EMAIL", "OFFERS", when),
  };
}

function reasonText(v: SendVerdict): string {
  return v.ok ? "" : `${v.reason}: ${v.detail}`;
}

/**
 * Whether a verdict means this person can no longer be reached by the sequence at all — gone, dead,
 * blocked, or asked us to stop — rather than merely never having opted in.
 */
function unreachable(v: SendVerdict): boolean {
  if (v.ok) return false;
  if (["NO_ADDRESS", "INVALID_ADDRESS", "HARD_BOUNCE", "COMPLAINT", "UNSUBSCRIBED", "MANUAL"].includes(v.reason)) return true;
  return v.reason === "NO_CONSENT" && v.detail === "They opted out of this topic.";
}

/**
 * Since when something has stood against this company's primary contact — the one a journey writes
 * to — or null. Journeys are tried on these first, so the demo shows a sequence meeting somebody it
 * can no longer reach.
 */
function primaryBlockedSince(w: World, companyId: string): Date | null {
  const primary = primaryOf(w, companyId);
  if (!primary) return null;
  const address = primary.email?.trim().toLowerCase() ?? null;
  const since = w.suppressions
    .filter(
      (s) =>
        !s.expiresAt &&
        ((s.scope === "COMPANY" && s.value === companyId) ||
          (s.scope === "CONTACT" && s.value === primary.id) ||
          (s.scope === "EMAIL" && address !== null && s.value === address)),
    )
    .map((s) => s.createdAt.getTime());
  return since.length ? new Date(Math.min(...since)) : null;
}

// ─── What happened to a message once it left ──────────────────────────────────────────────────

type EventDraft = { type: MessageEventType; occurredAt: Date; url?: string | null; providerEventId?: string | null; detail?: string | null };
type Outcome = {
  status: MessageStatus;
  events: EventDraft[];
  error: string | null;
  bounced: boolean;
  complained: boolean;
  unsubscribed: boolean;
};

const BOUNCES = [
  "550 5.1.1 The email account that you tried to reach does not exist.",
  "550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup",
  "554 5.4.14 Hop count exceeded — mail loop detected; the mailbox is gone.",
];

/**
 * One message's fate, at believable rates: about 2% bounce, a fraction of a percent complain, 40%
 * of what arrives is opened and a quarter of those clicked. Every event is dated after the send and
 * before now, and the final status is the furthest one the webhook rules would have let it reach.
 */
/** Where in the dice a forced outcome lands, so forcing one walks exactly the path a roll would have. */
const FORCE_R: Partial<Record<MessageStatus, number>> = { BOUNCED: 0, COMPLAINED: 0.025, FAILED: 0.03, SENT: 0.05, DELIVERED: 0.5, OPENED: 0.5, CLICKED: 0.5 };
const FORCE_O: Partial<Record<MessageStatus, number>> = { DELIVERED: 0.9, OPENED: 0.3, CLICKED: 0.05 };

function simulate(w: World, channel: MessageChannel, sentAt: Date, links: string[], opts: { transactional?: boolean; force?: MessageStatus; unsubscribe?: boolean } = {}): Outcome {
  const window = Math.max(60000, w.now.getTime() - sentAt.getTime() - 60000);
  const after = (minMs: number, maxMs: number) => new Date(sentAt.getTime() + Math.min(window, minMs + Math.floor((maxMs - minMs) * rndShare())));
  const webhook = () => `evt_${randomUUID()}`;
  const out: Outcome = { status: "SENT", events: [], error: null, bounced: false, complained: false, unsubscribed: false };
  const forced = channel === "EMAIL" && !opts.transactional ? opts.force : undefined;
  const r = forced !== undefined ? (FORCE_R[forced] ?? rndShare()) : rndShare();

  if (channel === "WHATSAPP") {
    if (r < 0.06) {
      out.status = "FAILED";
      out.error = "(#131026) Message undeliverable — not a WhatsApp number.";
      out.events.push({ type: "FAILED", occurredAt: after(5000, 60000), providerEventId: webhook(), detail: out.error });
      return out;
    }
    if (r < 0.1) return out;
    out.status = "DELIVERED";
    const delivered = after(2000, 30000);
    out.events.push({ type: "DELIVERED", occurredAt: delivered, providerEventId: webhook() });
    const o = rndShare();
    if (o < 0.62) {
      out.status = "OPENED";
      out.events.push({ type: "OPEN", occurredAt: after(60000, 6 * HOUR), providerEventId: webhook(), detail: "read" });
      if (o < 0.08 && links.length) {
        out.status = "CLICKED";
        out.events.push({ type: "CLICK", occurredAt: after(7 * HOUR, 9 * HOUR), url: pick(links) });
      }
    }
    return out;
  }

  if (opts.transactional) {
    // Transactional mail leaves through the Microsoft 365 SMTP provider: no webhook reports back and
    // a plain-text notice carries no pixel, so nothing is known after the hand-over — except a
    // refusal at the door, which SMTP answers on the spot and the sender records as a failure.
    if (r < 0.02) {
      out.status = "FAILED";
      out.error = pick([
        "550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup",
        "550 5.7.708 Service unavailable. Access denied, traffic not accepted from this IP.",
      ]);
    }
    return out;
  }

  const bounceRate = 0.022;
  if (r < bounceRate) {
    out.status = "BOUNCED";
    out.bounced = true;
    out.events.push({ type: "BOUNCE", occurredAt: after(4000, 90000), providerEventId: webhook(), detail: pick(BOUNCES) });
    return out;
  }
  if (r < 0.028) {
    out.status = "COMPLAINED";
    out.complained = true;
    out.events.push({ type: "DELIVERED", occurredAt: after(2000, 20000), providerEventId: webhook() });
    out.events.push({ type: "COMPLAINT", occurredAt: after(HOUR, 30 * HOUR), providerEventId: webhook(), detail: "Marked as spam by the recipient." });
    return out;
  }
  if (r < 0.036) {
    out.status = "FAILED";
    out.error = "Resend returned 422: The `to` address was rejected by the receiving server.";
    out.events.push({ type: "FAILED", occurredAt: after(3000, 40000), providerEventId: webhook(), detail: out.error });
    return out;
  }
  // Sent, and no receipt has come back — some providers and some servers never say.
  if (r < 0.08) return out;

  out.status = "DELIVERED";
  out.events.push({ type: "DELIVERED", occurredAt: after(2000, 25000), providerEventId: webhook() });
  const o = forced !== undefined ? (FORCE_O[forced] ?? rndShare()) : rndShare();
  const openShare = 0.41;
  const clickShare = 0.11;
  if (o < openShare) {
    out.status = "OPENED";
    const firstOpen = after(5 * 60000, 26 * HOUR);
    out.events.push({ type: "OPEN", occurredAt: firstOpen });
    if (chance(0.35)) out.events.push({ type: "OPEN", occurredAt: new Date(Math.min(w.now.getTime() - 60000, firstOpen.getTime() + int(1, 72) * HOUR)) });
    if (o < clickShare && links.length) {
      out.status = "CLICKED";
      out.events.push({ type: "CLICK", occurredAt: new Date(Math.min(w.now.getTime() - 60000, firstOpen.getTime() + int(10, 600) * 1000)), url: pick(links) });
    }
    if (chance(0.025) || opts.unsubscribe) {
      out.unsubscribed = true;
      out.events.push({
        type: "UNSUBSCRIBE",
        occurredAt: new Date(Math.min(w.now.getTime() - 60000, firstOpen.getTime() + int(1, 20) * 60000)),
        detail: chance(0.5) ? "Unsubscribed from everything" : "Unsubscribed with their mail app's one-click unsubscribe",
      });
    }
  }
  return out;
}

function providerMessageId(channel: MessageChannel, transactional: boolean): string {
  if (channel === "WHATSAPP") return `wamid.${randomBytes(18).toString("base64url")}`;
  return transactional ? `<${randomUUID()}@PN3PR01MB8710.INDPRD01.PROD.OUTLOOK.COM>` : randomUUID();
}

/** What the webhook and the unsubscribe link do after a bounce, a complaint or an opt-out. */
async function aftermath(w: World, c: Ct, outcome: Outcome, provider: string) {
  const address = c.email?.trim().toLowerCase();
  if (!address) return;
  const lastEvent = outcome.events[outcome.events.length - 1];
  const when = lastEvent?.occurredAt ?? w.now;

  if (outcome.bounced || outcome.complained) {
    const reason: SuppressionReason = outcome.complained ? "COMPLAINT" : "HARD_BOUNCE";
    const detail = lastEvent?.detail ?? null;
    await w.db.suppression.upsert({
      where: { scope_value: { scope: "EMAIL", value: address } },
      create: { scope: "EMAIL", value: address, reason, note: `Reported by ${provider}${detail ? `: ${detail}` : ""}`, createdAt: when },
      update: { reason },
    });
    w.suppressions = w.suppressions.filter((s) => !(s.scope === "EMAIL" && s.value === address));
    w.suppressions.push({ scope: "EMAIL", value: address, reason, createdAt: when, expiresAt: null });
  }

  if (outcome.bounced) {
    const detail = `Mail to this address bounced${lastEvent?.detail ? `: ${lastEvent.detail}` : "."}`;
    await w.db.contact.update({
      where: { id: c.id },
      data: { emailStatus: "INVALID", emailCheckedValue: c.email, emailCheckedAt: when, emailCheckMethod: "REPORTED", emailCheckDetail: detail },
    });
    c.emailStatus = "INVALID";
    c.emailCheckedValue = c.email;
    c.emailCheckedAt = when;
  }

  if (outcome.unsubscribed) {
    // `unsubscribeByToken`: out of every topic on email, the address suppressed.
    const note = lastEvent?.detail ?? "Unsubscribed from everything";
    for (const topic of TOPICS) {
      const evidence = `${note} on ${clock.today(when)}.`;
      await w.db.contactConsent.upsert({
        where: { contactId_channel_topic: { contactId: c.id, channel: "EMAIL", topic: topic.key } },
        create: { contactId: c.id, channel: "EMAIL", topic: topic.key, status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", evidence, capturedAt: when, withdrawnAt: when },
        update: { status: "UNSUBSCRIBED", withdrawnAt: when, source: "PREFERENCE_CENTRE" },
      });
      const key = consentKey(c.id, "EMAIL", topic.key);
      const before = w.consents.get(key);
      w.consents.set(key, { status: "UNSUBSCRIBED", capturedAt: before?.capturedAt ?? when, withdrawnAt: when });
    }
    await w.db.suppression.upsert({
      where: { scope_value: { scope: "EMAIL", value: address } },
      create: { scope: "EMAIL", value: address, reason: "UNSUBSCRIBED", note: `${note}.`, createdAt: when },
      update: { reason: "UNSUBSCRIBED" },
    });
    if (!w.suppressions.some((s) => s.scope === "EMAIL" && s.value === address)) {
      w.suppressions.push({ scope: "EMAIL", value: address, reason: "UNSUBSCRIBED", createdAt: when, expiresAt: null });
    }
  }
}

type MessageDraft = Omit<Prisma.MarketingMessageUncheckedCreateInput, "events">;

async function writeMessage(w: World, data: MessageDraft, events: EventDraft[]): Promise<string> {
  const row = await w.db.marketingMessage.create({ data, select: { id: true } });
  if (events.length) {
    await w.db.messageEvent.createMany({
      data: events.map((e) => ({
        messageId: row.id,
        type: e.type,
        occurredAt: e.occurredAt,
        url: e.url ?? null,
        providerEventId: e.providerEventId ?? null,
        detail: e.detail ?? null,
      })),
    });
  }
  return row.id;
}

function noteSend(w: World, contactId: string, at: Date) {
  const list = w.sends.get(contactId) ?? [];
  list.push(at);
  w.sends.set(contactId, list);
}

/** The links a template carries, so a click lands on one the customer was actually sent. */
function linksIn(body: string): string[] {
  return [...new Set([...body.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/[.,;]+$/, "")))];
}

// ─── Loading the world ──────────────────────────────────────────────────────────────────────────

async function loadWorld(db: PrismaClient, ctx: DemoContext): Promise<World> {
  const now = new Date();
  const by = (title: string) => ctx.people.find((p) => p.title === title);
  const sales = ctx.people.filter((p) => p.dept === "Sales");
  const support = ctx.people.filter((p) => p.dept === "Support");
  const presales = ctx.people.filter((p) => p.dept === "Presales & Solutions");
  const anyone = ctx.people[0]!;
  const marketer = by("Inside Sales Lead") ?? sales[0] ?? anyone;
  const approver = by("Head of Sales") ?? by("General Manager") ?? ctx.people.find((p) => p.id !== marketer.id) ?? anyone;
  const cast: Cast = {
    marketer,
    approver,
    director: by("Director") ?? approver,
    supportLead: by("Support Lead") ?? support[0] ?? anyone,
    finance: by("Finance Controller") ?? anyone,
    sales: sales.length ? sales : [anyone],
    support: support.length ? support : [anyone],
    presales: presales.length ? presales : [anyone],
    managers: ctx.people.filter((p) => p.isManager && ["Support", "Presales & Solutions", "Sales"].includes(p.dept)),
  };
  if (cast.managers.length === 0) cast.managers = [cast.supportLead];

  const org = await db.organisationSettings.findUnique({ where: { id: "global" } });
  const holidays = await db.holiday.findMany({ select: { date: true, optional: true } });
  const settings: MarketingSettings = {
    rules: {
      quiet: { startMinute: org?.marketingQuietStartMinute ?? 1200, endMinute: org?.marketingQuietEndMinute ?? 540 },
      skipNonWorkingDays: org?.marketingSkipNonWorkingDays ?? true,
      holidays: closedDates(holidays),
      clock,
    },
    limits: {
      maxPerContactPerWeek: org?.marketingMaxPerContactPerWeek ?? 2,
      overdueDaysBlock: 60,
      requireVerifiedAddress: true,
    },
    postalAddress: org
      ? postalAddressFor({
          legalName: org.legalName,
          tradeName: org.tradeName,
          addressLine1: org.addressLine1,
          addressLine2: org.addressLine2,
          city: org.city,
          state: org.state,
          pincode: org.pincode,
          country: org.country,
          marketingPostalAddress: org.marketingPostalAddress,
        }).text
      : null,
    approvalThreshold: org?.marketingApprovalThreshold ?? 200,
    ourName: org?.tradeName || org?.legalName || "us",
  };

  let trackingKey: Buffer | null = null;
  try {
    trackingKey = (await currentKeys()).trackingKey;
  } catch {
    trackingKey = null;
  }

  const companyRows = await db.company.findMany({
    where: { tags: { has: DEMO_TAG } },
    select: {
      id: true,
      name: true,
      relationshipType: true,
      stage: true,
      managedByResellerId: true,
      ownerUserId: true,
      assignedToUserId: true,
      createdAt: true,
      owner: { select: { name: true, email: true } },
    },
  });
  const companies = new Map<string, Co>(
    companyRows.map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        relationshipType: c.relationshipType,
        stage: c.stage,
        managedByResellerId: c.managedByResellerId,
        ownerUserId: c.ownerUserId,
        assignedToUserId: c.assignedToUserId,
        createdAt: c.createdAt,
        ownerName: c.owner?.name ?? null,
        ownerEmail: c.owner?.email ?? null,
      },
    ]),
  );
  const contactRows = await db.contact.findMany({
    where: { companyId: { in: [...companies.keys()] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      isPrimary: true,
      designation: true,
      companyId: true,
      createdAt: true,
      emailStatus: true,
      emailCheckedValue: true,
      emailCheckedAt: true,
    },
  });
  const contacts = new Map<string, Ct>(contactRows.map((c) => [c.id, { ...c }]));
  const byCompany = new Map<string, Ct[]>();
  for (const c of contacts.values()) byCompany.set(c.companyId, [...(byCompany.get(c.companyId) ?? []), c]);

  const marketable = [...companies.values()].filter((c) => c.managedByResellerId === null);
  const customers = marketable.filter((c) => c.relationshipType === "CLIENT" && c.stage === "CUSTOMER");

  const consentRows = await db.contactConsent.findMany({
    where: { contactId: { in: [...contacts.keys()] } },
    select: { contactId: true, channel: true, topic: true, status: true, capturedAt: true, withdrawnAt: true },
  });
  const consents = new Map<string, ConsentRow>(
    consentRows.map((r) => [consentKey(r.contactId, r.channel, r.topic), { status: r.status, capturedAt: r.capturedAt, withdrawnAt: r.withdrawnAt }]),
  );
  const suppressions: SuppRow[] = (
    await db.suppression.findMany({ select: { scope: true, value: true, reason: true, createdAt: true, expiresAt: true } })
  ).map((s) => ({ ...s }));

  const providers = new Map((await db.messagingProvider.findMany({ select: { key: true, id: true } })).map((p) => [p.key, p.id]));
  const companyIds = [...companies.keys()];
  const tickets: TicketRow[] = (
    await db.ticket.findMany({ where: { companyId: { in: companyIds } }, select: { companyId: true, priority: true, createdAt: true, resolvedAt: true, closedAt: true, status: true } })
  ).map((k) => ({
    companyId: k.companyId,
    priority: k.priority,
    createdAt: k.createdAt,
    // Resolved or closed with no date recorded: treated as done from the day it was raised.
    doneAt: k.resolvedAt ?? k.closedAt ?? (k.status === "RESOLVED" || k.status === "CLOSED" ? k.createdAt : null),
  }));
  const invoices: InvoiceRow[] = await db.tradeDocument.findMany({
    where: { companyId: { in: companyIds }, docType: "INVOICE", status: { in: ["ISSUED", "PARTIALLY_PAID", "ACCEPTED"] }, dueDate: { not: null } },
    select: { companyId: true, issueDate: true, dueDate: true },
  });

  const world: World = {
    db,
    ctx,
    now,
    cast,
    settings,
    feedbackDays: org?.feedbackLinkDays ?? 30,
    reviewMinRating: org?.feedbackReviewMinRating ?? 4,
    reviewUrl: org?.feedbackReviewUrl ?? null,
    trackingKey,
    companies,
    contacts,
    byCompany,
    marketable,
    customers,
    consents,
    suppressions,
    feedback: [],
    tickets,
    invoices,
    sends: new Map(),
    providers,
  };
  await reloadFeedback(world);
  return world;
}

async function reloadFeedback(w: World) {
  const rows = await w.db.feedbackResponse.findMany({
    where: { request: { companyId: { in: [...w.companies.keys()] } } },
    select: { rating: true, submittedAt: true, acknowledgedAt: true, request: { select: { companyId: true } } },
  });
  w.feedback = rows.map((r) => ({ companyId: r.request.companyId, rating: r.rating, submittedAt: r.submittedAt, acknowledgedAt: r.acknowledgedAt }));
}

const marketableContact = (w: World, c: Ct) => w.companies.get(c.companyId)?.managedByResellerId === null;
const contactsOf = (w: World, companyId: string) => w.byCompany.get(companyId) ?? [];
const primaryOf = (w: World, companyId: string) => {
  const list = contactsOf(w, companyId);
  return list.find((c) => c.isPrimary) ?? list[0] ?? null;
};

// ─── 1. Addresses checked ───────────────────────────────────────────────────────────────────────

/**
 * Somebody ran the bulk address check before the first campaign, as the marketing screen asks them
 * to: an audience sends only to verified addresses by default, and an unchecked one is held back.
 * Four in five were checked; the rest are still unchecked, which is what a real book looks like.
 * Decided by contact id, so a second run checks the same people and nobody new.
 */
async function checkAddresses(w: World): Promise<number> {
  let checked = 0;
  for (const c of w.contacts.values()) {
    if (!marketableContact(w, c) || !c.email || c.emailStatus !== "UNCHECKED") continue;
    if (share(c.id) >= 0.8) continue;
    const when = past(w, later(daysAgo(190 + Math.floor(share(`${c.id}:t`) * 40)), plus(c.createdAt, 2 * HOUR)));
    await markValid(w, c, when);
    checked += 1;
  }
  return checked;
}

async function markValid(w: World, c: Ct, when: Date) {
  if (!c.email) return;
  const domain = domainOf(c.email);
  await w.db.contact.update({
    where: { id: c.id },
    data: {
      emailStatus: "VALID",
      emailCheckDetail: `${domain} accepts mail at mx1.${domain}. The mailbox itself can only be confirmed by a reply.`,
      emailCheckMethod: "AUTOMATIC",
      emailCheckedValue: c.email,
      emailCheckedAt: when,
      emailCheckedByUserId: w.cast.marketer.id,
    },
  });
  c.emailStatus = "VALID";
  c.emailCheckedValue = c.email;
  c.emailCheckedAt = when;
}

// ─── 2. Suppressions by person and by company ───────────────────────────────────────────────────

async function seedSuppressions(w: World): Promise<number> {
  const ids = new Set([...w.companies.keys(), ...w.contacts.keys()]);
  const existing = await w.db.suppression.findMany({ where: { scope: { in: ["CONTACT", "COMPANY"] } }, select: { value: true } });
  if (existing.some((s) => ids.has(s.value))) return 0;

  // The people who sign things — a suppression on somebody nobody writes to is one nobody sees — and
  // first those at customers we look after machines for, whom the warranty journey writes to.
  const owners = new Set(
    (await w.db.asset.findMany({ where: { ownerCompanyId: { in: w.customers.map((c) => c.id) } }, select: { ownerCompanyId: true } })).map((a) => a.ownerCompanyId),
  );
  const primaries = w.customers.map((co) => primaryOf(w, co.id)).filter((c): c is Ct => !!c?.email);
  const people = [
    ...some(primaries.filter((c) => c.phone && owners.has(c.companyId)), 2),
    ...some(primaries.filter((c) => !(c.phone && owners.has(c.companyId))), 1),
  ];
  const CONTACT_NOTES: [SuppressionReason, string][] = [
    ["UNSUBSCRIBED", "Asked on a call to stop the marketing mail. Renewal notices and invoices still go."],
    ["MANUAL", "Asked to be reached through their IT manager, not directly."],
    ["MANUAL", "Prefers WhatsApp and asked us not to email offers."],
  ];
  const COMPANY_NOTES: [string, boolean][] = [
    ["Invoice in dispute with accounts — no offers until it is settled.", true],
    ["Their procurement policy bars vendor marketing; they buy by tender only.", false],
  ];
  let made = 0;
  for (const [i, c] of some(people, CONTACT_NOTES.length).entries()) {
    const [reason, note] = CONTACT_NOTES[i]!;
    const createdAt = workTime(w, later(daysAgo(int(150, 260)), plus(c.createdAt, DAY)));
    await w.db.suppression.create({ data: { scope: "CONTACT", value: c.id, reason, note, createdById: w.cast.marketer.id, createdAt } });
    w.suppressions.push({ scope: "CONTACT", value: c.id, reason, createdAt, expiresAt: null });
    made += 1;
  }
  for (const [i, co] of some(w.customers, COMPANY_NOTES.length).entries()) {
    const [note, coolingOff] = COMPANY_NOTES[i]!;
    const createdAt = workTime(w, daysAgo(coolingOff ? int(40, 90) : int(150, 260)));
    // A cooling-off rather than a permanent block, where that is the right answer.
    const expiresAt = coolingOff ? daysAhead(int(30, 75)) : null;
    await w.db.suppression.create({ data: { scope: "COMPANY", value: co.id, reason: "MANUAL", note, createdById: w.cast.approver.id, createdAt, expiresAt } });
    w.suppressions.push({ scope: "COMPANY", value: co.id, reason: "MANUAL", createdAt, expiresAt });
    made += 1;
  }
  return made;
}

// ─── 3. Consent on the other channels ───────────────────────────────────────────────────────────

/**
 * WhatsApp is consented separately from email, topic by topic, which is what a WhatsApp campaign
 * checks. A call before each renewal (TASK) and service notifications (NOTIFICATION) are recorded the
 * way `setConsent` records any channel — the evidence says on what basis.
 */
async function seedChannelConsents(w: World): Promise<Record<string, number>> {
  const already = await w.db.contactConsent.count({
    where: { contactId: { in: [...w.contacts.keys()] }, channel: { in: ["WHATSAPP", "TASK", "NOTIFICATION"] } },
  });
  if (already > 0) return { whatsapp: 0, task: 0, notification: 0 };

  const customerIds = new Set(w.customers.map((c) => c.id));
  const atCustomers = [...w.contacts.values()].filter((c) => customerIds.has(c.companyId));
  const rows: Prisma.ContactConsentCreateManyInput[] = [];
  const counts = { whatsapp: 0, task: 0, notification: 0 };

  const EVIDENCE: Record<ConsentSource, string> = {
    VERBAL: "Agreed on a call with their account manager to hear from us on WhatsApp.",
    CONTRACT: "AMC contract, schedule 3 — WhatsApp updates to the named IT contact.",
    FORM: "Ticked “WhatsApp me” on the service request form.",
    CAMPAIGN_LINK: "Replied YES to the WhatsApp opt-in link in a renewal email.",
    IMPORT: "",
    PREFERENCE_CENTRE: "",
  };
  const withPhone = atCustomers.filter((c) => c.phone);
  // The person who signs is the one WhatsApp reaches, so most primaries were asked; others now and then.
  const asked = [...withPhone.filter((c) => c.isPrimary && chance(0.85)), ...some(withPhone.filter((c) => !c.isPrimary), 40)];
  for (const c of asked) {
    const topics = c.isPrimary ? (["RENEWALS", "SERVICE", "EVENTS"] as const) : some(["RENEWALS", "SERVICE", "OFFERS", "EVENTS"] as const, int(1, 2));
    for (const topic of topics) {
      const status = pick(["SUBSCRIBED", "SUBSCRIBED", "SUBSCRIBED", "SUBSCRIBED", "SUBSCRIBED", "UNSUBSCRIBED", "PENDING"] as const);
      const source = pick(["VERBAL", "CONTRACT", "FORM", "CAMPAIGN_LINK", "CAMPAIGN_LINK"] as const);
      const capturedAt = workTime(w, between(later(c.createdAt, daysAgo(320)), daysAgo(70)));
      const withdrawnAt = status === "UNSUBSCRIBED" ? workTime(w, between(plus(capturedAt, 7 * DAY), daysAgo(5))) : null;
      rows.push({
        contactId: c.id,
        channel: "WHATSAPP",
        topic,
        status,
        source,
        evidence:
          status === "UNSUBSCRIBED"
            ? `Replied STOP on WhatsApp on ${clock.date(withdrawnAt)}.`
            : status === "PENDING"
              ? "Asked for WhatsApp updates; waiting for them to confirm the opt-in message."
              : EVIDENCE[source],
        capturedAt,
        capturedById: w.companies.get(c.companyId)?.ownerUserId ?? w.cast.marketer.id,
        withdrawnAt,
      });
      counts.whatsapp += 1;
    }
  }
  for (const c of some(atCustomers, Math.min(14, atCustomers.length))) {
    rows.push({
      contactId: c.id,
      channel: "TASK",
      topic: "RENEWALS",
      status: "SUBSCRIBED",
      source: "VERBAL",
      evidence: "Asked for a call from their account manager a month before every renewal.",
      capturedAt: workTime(w, between(later(c.createdAt, daysAgo(300)), daysAgo(30))),
      capturedById: w.companies.get(c.companyId)?.ownerUserId ?? null,
    });
    counts.task += 1;
  }
  for (const c of some(atCustomers, Math.min(14, atCustomers.length))) {
    const out = chance(0.15);
    const capturedAt = workTime(w, between(later(c.createdAt, daysAgo(300)), daysAgo(30)));
    rows.push({
      contactId: c.id,
      channel: "NOTIFICATION",
      topic: "SERVICE",
      status: out ? "UNSUBSCRIBED" : "SUBSCRIBED",
      source: "CONTRACT",
      evidence: out ? "Asked to stop the maintenance-window notices; the IT head gets them instead." : "AMC contract — maintenance and outage notices to the named contact.",
      capturedAt,
      capturedById: w.cast.supportLead.id,
      withdrawnAt: out ? workTime(w, between(plus(capturedAt, 10 * DAY), daysAgo(3))) : null,
    });
    counts.notification += 1;
  }
  await w.db.contactConsent.createMany({ data: rows, skipDuplicates: true });
  for (const r of rows) {
    const key = consentKey(r.contactId, r.channel!, r.topic);
    if (!w.consents.has(key)) w.consents.set(key, { status: r.status!, capturedAt: r.capturedAt as Date, withdrawnAt: (r.withdrawnAt as Date | null) ?? null });
  }
  return counts;
}

// ─── 4. Customer feedback, answered and withdrawn ───────────────────────────────────────────────

const PRAISE = [
  "Sorted the same day, and he explained what had gone wrong.",
  "Professional and quick. The engineer cleaned up after himself.",
  "Exactly what we asked for, delivered when promised.",
  "Good follow-up — nobody had to chase.",
  "The migration weekend went without a hitch. Users noticed nothing.",
];
const MIXED = ["Fixed in the end, but it took three calls to get someone.", "Fine, though nobody told us the visit had moved."];
const COMPLAINTS = ["The same issue came back a week later.", "We waited two days for a reply on a P1.", "Delivered without the cables we ordered."];
const ACTION_NOTES = [
  "Called the IT head, apologised, and moved the ticket to the senior engineer.",
  "Root cause found — a vendor patch. Credited a month of the AMC.",
  "Spoke to them; the delivery has been completed and the PO closed.",
];
const WITHDRAWN = [
  "Sent to the wrong contact — asked the IT head instead.",
  "The ticket was reopened the same day, so asking now was premature.",
  "Customer asked us not to send surveys during their audit.",
  "Duplicate of a request sent the day before.",
];
const SERVICE_LABELS = ["The Microsoft 365 migration", "Laptop refresh for the finance team", "The quarterly health check", "Firewall policy review"];

async function seedFeedback(w: World): Promise<{ answered: number; cancelled: number }> {
  const db = w.db;
  const done = await db.feedbackRequest.count({ where: { company: { tags: { has: DEMO_TAG } }, reference: { startsWith: "FB/" } } });
  if (done > 0) return { answered: 0, cancelled: 0 };

  const ids = w.customers.map((c) => c.id);
  const [tickets, visits, orders] = await Promise.all([
    db.ticket.findMany({
      where: { companyId: { in: ids }, status: { in: ["RESOLVED", "CLOSED"] } },
      select: { id: true, companyId: true, contactId: true, assignedToUserId: true, resolvedAt: true, closedAt: true, createdAt: true },
    }),
    db.visit.findMany({ where: { companyId: { in: ids }, status: "COMPLETED" }, select: { id: true, companyId: true, userId: true, checkOutAt: true, createdAt: true } }),
    db.companyProduct.findMany({
      where: { companyId: { in: ids }, orderStatus: "FULFILLED" },
      select: { id: true, companyId: true, addedByUserId: true, fulfilledAt: true, createdAt: true },
    }),
  ]);

  type Plan = {
    company: Co;
    contact: Ct | null;
    aboutUserId: string | null;
    ticketId: string | null;
    visitId: string | null;
    companyProductId: string | null;
    serviceLabel: string | null;
    requestedById: string;
    sentAt: Date;
    answered: boolean;
  };
  const plans: Plan[] = [];
  for (let i = 0; i < 24; i++) {
    const company = pick(w.customers);
    const contact = primaryOf(w, company.id);
    const kind = pick(["ticket", "ticket", "visit", "order", "label"] as const);
    const oneOf = <T extends { companyId: string }>(rows: T[]): T | null => {
      const theirs = rows.filter((r) => r.companyId === company.id);
      return theirs.length ? pick(theirs) : null;
    };
    const ticket = kind === "ticket" ? oneOf(tickets) : null;
    const visit = kind === "visit" ? oneOf(visits) : null;
    const order = kind === "order" ? oneOf(orders) : null;
    const doneAt = ticket?.resolvedAt ?? ticket?.closedAt ?? visit?.checkOutAt ?? order?.fulfilledAt ?? null;
    const base = doneAt ? plus(doneAt, int(2, 72) * HOUR) : daysAgo(int(10, 300));
    const sentAt = workTime(w, earlier(later(base, plus(company.createdAt, DAY)), daysAgo(3)));
    plans.push({
      company,
      contact,
      aboutUserId: ticket?.assignedToUserId ?? visit?.userId ?? order?.addedByUserId ?? (chance(0.5) ? pick(w.cast.support).id : null),
      ticketId: ticket?.id ?? null,
      visitId: visit?.id ?? null,
      companyProductId: order?.id ?? null,
      serviceLabel: ticket || visit || order ? null : pick(SERVICE_LABELS),
      requestedById: ticket || visit ? w.cast.supportLead.id : (company.ownerUserId ?? w.cast.supportLead.id),
      sentAt,
      answered: i % 4 !== 3,
    });
  }
  plans.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

  const serials = new Map<string, number>();
  const nextReference = async (date: Date) => {
    const prefix = `FB/${financialYearOf(date)}/`;
    if (!serials.has(prefix)) {
      const last = await db.feedbackRequest.findFirst({ where: { reference: { startsWith: prefix } }, orderBy: { reference: "desc" }, select: { reference: true } });
      serials.set(prefix, last ? Number(last.reference.slice(prefix.length)) || 0 : 0);
    }
    const n = serials.get(prefix)! + 1;
    serials.set(prefix, n);
    return `${prefix}${String(n).padStart(4, "0")}`;
  };

  let answered = 0;
  let cancelled = 0;
  for (const p of plans) {
    const expiresAt = plus(p.sentAt, w.feedbackDays * DAY);
    const request = await db.feedbackRequest.create({
      data: {
        token: randomBytes(24).toString("base64url"),
        reference: await nextReference(p.sentAt),
        companyId: p.company.id,
        contactId: p.contact?.id ?? null,
        sentToName: p.contact?.name ?? null,
        sentToEmail: p.contact?.email ?? null,
        sentToPhone: p.contact?.phone ?? null,
        aboutUserId: p.aboutUserId,
        ticketId: p.ticketId,
        visitId: p.visitId,
        companyProductId: p.companyProductId,
        serviceLabel: p.serviceLabel,
        message: chance(0.4) ? "Two minutes, and it goes straight to the people who did the work." : null,
        status: "SENT",
        sentAt: p.sentAt,
        expiresAt,
        requestedById: p.requestedById,
        createdAt: p.sentAt,
      },
      select: { id: true },
    });

    if (p.answered) {
      const rating = pick([5, 5, 5, 4, 4, 4, 4, 3, 2, 1]);
      const submittedAt = past(w, earlier(plus(p.sentAt, int(1, 120) * HOUR), plus(expiresAt, -HOUR)));
      const invitation = reviewInvitation({ rating, minRating: w.reviewMinRating, reviewUrl: w.reviewUrl });
      const low = rating <= 3;
      const acknowledged = low ? chance(0.65) : chance(0.25);
      const acknowledgedAt = acknowledged ? past(w, plus(submittedAt, int(2, 60) * HOUR)) : null;
      // Saved with the status change, as `submitFeedback` does — an answer never sits on an open request.
      await db.$transaction([
        db.feedbackResponse.create({
          data: {
            requestId: request.id,
            rating,
            personRating: p.aboutUserId ? Math.max(1, Math.min(5, rating + pick([-1, 0, 0, 1]))) : null,
            serviceRating: chance(0.85) ? Math.max(1, Math.min(5, rating + pick([-1, 0, 0, 0]))) : null,
            comment: chance(0.8) ? (rating >= 4 ? pick(PRAISE) : rating === 3 ? pick(MIXED) : pick(COMPLAINTS)) : null,
            reviewInvited: invitation.invite,
            reviewMinRatingAtTime: w.reviewMinRating,
            reviewOpenedAt: invitation.invite && chance(0.5) ? plus(submittedAt, int(1, 30) * 60000) : null,
            submittedAt,
            acknowledgedAt,
            acknowledgedById: acknowledged ? (p.company.ownerUserId ?? w.cast.supportLead.id) : null,
            actionNote: acknowledged ? (low ? pick(ACTION_NOTES) : "Thanked them on a call.") : null,
          },
        }),
        db.feedbackRequest.update({ where: { id: request.id }, data: { status: "ANSWERED" } }),
      ]);
      answered += 1;
    } else {
      const cancelledAt = past(w, plus(p.sentAt, int(2, 96) * HOUR));
      await db.feedbackRequest.update({ where: { id: request.id }, data: { status: "CANCELLED", cancelledAt, message: pick(WITHDRAWN) } });
      cancelled += 1;
    }
  }
  await reloadFeedback(w);
  return { answered, cancelled };
}

// ─── 5. Templates ───────────────────────────────────────────────────────────────────────────────

type TemplateSpec = {
  key: string;
  name: string;
  channel: MessageChannel;
  topic: MarketingTopic;
  format: TemplateFormat;
  subject?: string;
  preheader?: string;
  body: string;
  whatsappTemplateName?: string;
  active?: boolean;
  createdAgo: number;
};

const TEMPLATES: TemplateSpec[] = [
  {
    key: "newsletter",
    name: "Quarterly newsletter",
    channel: "EMAIL",
    topic: "NEWSLETTER",
    format: "TEXT",
    subject: "{{ourName}} — what changed this quarter",
    preheader: "Licensing changes, a new backup service, and the next roundtable.",
    body: `Hi {{firstName|there}},

Three things worth knowing this quarter.

1. Microsoft's new-commerce prices moved again. Annual commitments are still the cheapest way to hold seats — monthly terms now cost a fifth more. Details: https://acme.example/blog/nce-pricing

2. We now run managed backup for Microsoft 365 and Google Workspace. Ask {{ownerName|your account manager}} for a sizing, or read how it works: https://acme.example/backup

3. Our next customer roundtable is in Pune. Want an invitation? https://acme.example/events/keep-me-posted

As always, reply to this email and it reaches a person.

{{ourName}}`,
    createdAgo: 175,
  },
  {
    key: "copilot",
    name: "Copilot for Microsoft 365 — launch note",
    channel: "EMAIL",
    topic: "PRODUCT_NEWS",
    format: "HTML",
    subject: "Copilot is here — on the licences {{companyName}} already owns",
    preheader: "What it does with your own files, and how a 30-seat pilot works.",
    body: `<table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td style="padding:0 0 16px">
<h1 style="font-size:22px;margin:0 0 12px;color:#111827">Copilot is here — on the licences you already own</h1>
<p>Hi {{firstName|there}},</p>
<p>Microsoft has opened Copilot to Business Standard and Business Premium. For {{companyName}} that means summaries of long mail threads, first drafts in Word written from your own documents, and meeting notes taken for you in Teams.</p>
<p><a href="https://acme.example/copilot/what-it-does" style="color:#2563eb">See what it does with your own files</a></p>
<p>The quickest way to find out whether it pays for itself is a 30-seat pilot for one month. {{ownerName|Your account manager}} can set it up — <a href="https://acme.example/copilot/pilot" style="color:#2563eb">book a 20-minute call</a>.</p>
</td></tr></table>`,
    createdAgo: 110,
  },
  {
    key: "adobe",
    name: "Adobe price change — renew early",
    channel: "EMAIL",
    topic: "OFFERS",
    format: "HTML",
    subject: "Adobe prices rise next month — renew {{companyName}} early",
    preheader: "Lock in this year's price for another twelve months.",
    body: `<h2 style="font-size:20px;margin:0 0 12px">Renew now, pay this year's price</h2>
<p>Hi {{firstName|there}},</p>
<p>Adobe has announced a price rise on Creative Cloud and Acrobat from next month. Renewing before then holds today's price for a full term.</p>
<p><a href="https://acme.example/offers/adobe-early-renewal" style="background:#111827;color:#ffffff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Get the early-renewal quote</a></p>
<p>Questions? {{ownerName|Your account manager}} is on {{ownerEmail|our sales line}}.</p>`,
    createdAgo: 70,
  },
  {
    key: "festive",
    name: "Festive offers — laptops, licences and AMC",
    channel: "EMAIL",
    topic: "OFFERS",
    format: "HTML",
    subject: "Festive offers for {{companyName}} — laptops, licences and AMC",
    preheader: "Business laptops from ₹54,900, and a free first quarter on new AMC contracts.",
    body: `<h2 style="font-size:20px;margin:0 0 12px">This season's offers</h2>
<p>Hi {{firstName|there}},</p>
<ul>
<li>Business laptops with three-year onsite warranty from ₹54,900 — <a href="https://acme.example/offers/festive/laptops" style="color:#2563eb">see the models</a></li>
<li>Microsoft 365 Business Premium at last year's price on annual terms</li>
<li>The first quarter free on any new AMC — <a href="https://acme.example/offers/festive/amc" style="color:#2563eb">how it works</a></li>
</ul>
<p>{{ownerName|Your account manager}} can hold stock for you while you get the PO raised.</p>`,
    createdAgo: 6,
  },
  {
    key: "webinar",
    name: "Backup webinar — invitation",
    channel: "EMAIL",
    topic: "EVENTS",
    format: "TEXT",
    subject: "Webinar: ransomware-proof backup in 45 minutes",
    preheader: "A live restore, and the three settings most tenants get wrong.",
    body: `Hi {{firstName|there}},

Ransomware now goes for the backups first. In 45 minutes we'll show a live restore from an immutable copy, and the three Microsoft 365 settings most tenants get wrong.

Register here: https://acme.example/webinars/backup

{{ownerName|Your account manager}} will send the joining link the day before.

{{ourName}}`,
    createdAgo: 4,
  },
  {
    key: "welcome",
    name: "Welcome — your support desk",
    channel: "EMAIL",
    topic: "SERVICE",
    format: "HTML",
    subject: "Welcome to {{ourName}} — how to reach us when something breaks",
    preheader: "One number, one email, and who picks up.",
    body: `<h2 style="font-size:20px;margin:0 0 12px">Welcome aboard, {{companyName}}</h2>
<p>Hi {{firstName|there}},</p>
<p>Your first order is delivered. When something needs fixing, email the support desk or raise it from <a href="https://acme.example/support" style="color:#2563eb">the support page</a> — every request gets a ticket number within the hour.</p>
<p>{{ownerName|Your account manager}} looks after everything commercial.</p>`,
    createdAgo: 40,
  },
  {
    key: "referral",
    name: "Thank you — and a small favour",
    channel: "EMAIL",
    topic: "OFFERS",
    format: "TEXT",
    subject: "Thank you, {{firstName|and a small favour}}",
    body: `Hi {{firstName|there}},

Thank you for the kind words about our team — they were passed on to the people who did the work.

If you know another business that could use the same, we'd be grateful for an introduction: https://acme.example/refer

{{ownerName|Your account manager}}
{{ourName}}`,
    createdAgo: 335,
  },
  {
    key: "winback",
    name: "Lapsed subscription — renew without the gap",
    channel: "EMAIL",
    topic: "RENEWALS",
    format: "TEXT",
    subject: "{{productName|Your subscription}} has lapsed — renew without losing anything",
    body: `Hi {{firstName|there}},

{{companyName}}'s {{productName|subscription}} ended on {{expiryDate|its renewal date}}. Nothing is deleted yet, and renewing this week restores everything as it was.

Reply to this email, or renew online: https://acme.example/renew

{{ownerName|Your account manager}}
{{ourName}}`,
    createdAgo: 200,
  },
  {
    key: "wa-amc",
    name: "AMC renewal — WhatsApp",
    channel: "WHATSAPP",
    topic: "RENEWALS",
    format: "TEXT",
    body: "Hi {{firstName|there}}, the AMC on {{companyName}}'s machines with {{ourName}} is due for renewal. Reply YES and {{ownerName|your account manager}} will send the quote today. Details: https://acme.example/amc",
    whatsappTemplateName: "amc_renewal_reminder_v2",
    createdAgo: 60,
  },
  {
    key: "wa-webinar",
    name: "Backup webinar — WhatsApp reminder",
    channel: "WHATSAPP",
    topic: "EVENTS",
    format: "TEXT",
    body: "Hi {{firstName|there}}, a reminder from {{ourName}}: the ransomware-proof backup webinar is next week, 4 pm. Reply YES for the joining link.",
    whatsappTemplateName: "webinar_reminder_v1",
    createdAgo: 4,
  },
  {
    key: "wa-warranty",
    name: "Warranty ending — WhatsApp",
    channel: "WHATSAPP",
    topic: "SERVICE",
    format: "TEXT",
    body: "Hi {{firstName|there}}, the warranty on some of {{companyName}}'s machines ends soon. Reply AMC and {{ourName}} will quote extended cover. https://acme.example/amc",
    whatsappTemplateName: "warranty_expiring_notice",
    createdAgo: 345,
  },
  {
    key: "wa-winback",
    name: "Lapsed subscription — WhatsApp",
    channel: "WHATSAPP",
    topic: "RENEWALS",
    format: "TEXT",
    body: "Hi {{firstName|there}}, {{companyName}}'s subscription with {{ourName}} has lapsed. Reply RENEW and we'll restore it today, with nothing lost.",
    whatsappTemplateName: "subscription_winback_v1",
    createdAgo: 200,
  },
  {
    key: "task",
    name: "Call script — renewal follow-up",
    channel: "TASK",
    topic: "RENEWALS",
    format: "TEXT",
    body: "Call {{fullName|the contact}} at {{companyName}} about the renewal. Confirm seats, term and the PO number.",
    // Not offered for a campaign: the editors only send email and WhatsApp. Kept for the call list it was written for.
    active: false,
    createdAgo: 135,
  },
  {
    key: "notification",
    name: "Service window — in-app notice",
    channel: "NOTIFICATION",
    topic: "SERVICE",
    format: "TEXT",
    subject: "Planned maintenance this Saturday",
    body: "Planned maintenance on {{companyName}}'s backup service this Saturday, 10 pm to 2 am. Nothing needs doing on your side.",
    active: false,
    createdAgo: 25,
  },
];

type TemplateRow = { id: string; channel: MessageChannel; topic: MarketingTopic; subject: string | null; preheader: string | null; body: string; format: TemplateFormat; createdAt: Date };

async function seedTemplates(w: World): Promise<{ rows: Map<string, TemplateRow>; made: number }> {
  const rows = new Map<string, TemplateRow>();
  let made = 0;
  for (const spec of TEMPLATES) {
    // `saveTemplate`'s rules: HTML only for email, cleaned on save, no unknown merge field.
    const format: TemplateFormat = spec.format === "HTML" && spec.channel === "EMAIL" ? "HTML" : "TEXT";
    const body = format === "HTML" ? sanitizeEmailHtml(spec.body) : spec.body;
    const unknown = fieldsUsed(`${spec.subject ?? ""} ${spec.preheader ?? ""} ${body}`).unknown;
    if (unknown.length) throw new Error(`Template "${spec.name}" uses unknown merge fields: ${unknown.join(", ")}`);

    const select = { id: true, channel: true, topic: true, subject: true, preheader: true, body: true, format: true, createdAt: true } as const;
    const existing = await w.db.marketingTemplate.findFirst({ where: { name: spec.name, channel: spec.channel }, select });
    if (existing) {
      rows.set(spec.key, existing);
      continue;
    }
    const createdAt = workTime(w, daysAgo(spec.createdAgo));
    const row = await w.db.marketingTemplate.create({
      data: {
        name: spec.name,
        channel: spec.channel,
        topic: spec.topic,
        subject: spec.subject ?? null,
        preheader: spec.preheader ?? null,
        body,
        format,
        whatsappTemplateName: spec.whatsappTemplateName ?? null,
        active: spec.active ?? true,
        createdById: w.cast.marketer.id,
        createdAt,
      },
      select,
    });
    rows.set(spec.key, row);
    made += 1;
  }
  return { rows, made };
}

// ─── 6. Audiences and uploaded lists ────────────────────────────────────────────────────────────

type AudienceSpec = {
  key: string;
  name: string;
  description: string;
  companyFilters: { relationshipType: string[]; stage: string[] };
  contactFilters: ContactFilters;
};

const AUDIENCES: AudienceSpec[] = [
  {
    key: "deciders",
    name: "Customers — IT and finance decision makers",
    description: "Who signs off spend at every customer. Verified addresses, two per company at most.",
    companyFilters: { relationshipType: ["CLIENT"], stage: ["CUSTOMER"] },
    contactFilters: { designation: ["IT_HEAD", "CIO", "IT_MANAGER", "DIRECTOR", "CEO", "PURCHASE_MANAGER"], primaryOnly: false, verifiedOnly: true, maxPerCompany: 2 },
  },
  {
    key: "everyone",
    name: "Customers and prospects — newsletter",
    description: "Everybody at a customer or a prospect with a verified address. Consent decides the rest.",
    companyFilters: { relationshipType: ["CLIENT"], stage: ["CUSTOMER", "PROSPECT"] },
    contactFilters: { designation: [], primaryOnly: false, verifiedOnly: true, maxPerCompany: 3 },
  },
  {
    key: "whatsapp",
    name: "Customers — primary contact on WhatsApp",
    description: "One person per customer: the one who signs. WhatsApp consent decides who hears.",
    companyFilters: { relationshipType: ["CLIENT"], stage: ["CUSTOMER"] },
    contactFilters: { designation: [], primaryOnly: true, verifiedOnly: false, maxPerCompany: 1 },
  },
];

type ListSpec = { key: string; name: string; fileName: string; consentNote: string; topics: MarketingTopic[]; createdAgo: number; size: number };

const LISTS: ListSpec[] = [
  {
    key: "events",
    name: "Event sign-ups — roundtables and webinars",
    fileName: "event-signups-2025-26.csv",
    consentNote: "Signed up at our roundtables and webinars and ticked “keep me posted”.",
    topics: ["EVENTS", "PRODUCT_NEWS", "NEWSLETTER"],
    createdAgo: 185,
    size: 48,
  },
  {
    key: "expo",
    name: "IT expo — badge scans at our stand",
    fileName: "it-expo-badge-scans.xlsx",
    consentNote: "Visited our stand and agreed to hear about offers when their badge was scanned.",
    topics: ["OFFERS", "PRODUCT_NEWS"],
    createdAgo: 112,
    size: 36,
  },
];

type ListRow = { id: string; createdAt: Date; members: Ct[] };

async function seedAudiences(w: World): Promise<{ ids: Map<string, string>; made: number }> {
  const ids = new Map<string, string>();
  let made = 0;
  for (const a of AUDIENCES) {
    const existing = await w.db.audience.findFirst({ where: { name: a.name }, select: { id: true } });
    if (existing) {
      ids.set(a.key, existing.id);
      continue;
    }
    const row = await w.db.audience.create({
      data: {
        name: a.name,
        description: a.description,
        companyFilters: a.companyFilters as Prisma.InputJsonValue,
        contactFilters: a.contactFilters as Prisma.InputJsonValue,
        createdById: w.cast.marketer.id,
        createdAt: workTime(w, daysAgo(int(200, 240))),
      },
      select: { id: true },
    });
    ids.set(a.key, row.id);
    made += 1;
  }
  return { ids, made };
}

/**
 * An uploaded list, as `importMarketingList` leaves it: every row a contact, the consent the
 * uploader vouched for recorded against each of them (never over an existing row), and every
 * unchecked address checked on the way in.
 */
async function seedLists(w: World): Promise<{ rows: Map<string, ListRow>; made: number; consents: number }> {
  const rows = new Map<string, ListRow>();
  let made = 0;
  let consents = 0;
  for (const spec of LISTS) {
    const existing = await w.db.marketingList.findFirst({
      where: { name: spec.name },
      select: { id: true, createdAt: true, members: { select: { contactId: true } } },
    });
    if (existing) {
      rows.set(spec.key, { id: existing.id, createdAt: existing.createdAt, members: existing.members.map((m) => w.contacts.get(m.contactId)).filter((c): c is Ct => !!c) });
      continue;
    }
    const createdAt = workTime(w, daysAgo(spec.createdAgo));
    const pool = [...w.contacts.values()].filter((c) => marketableContact(w, c) && c.email && c.createdAt < createdAt);
    const members = some(pool, Math.min(spec.size, pool.length));
    const list = await w.db.marketingList.create({
      data: {
        name: spec.name,
        fileName: spec.fileName,
        consentNote: spec.consentNote,
        topics: spec.topics,
        createdById: w.cast.marketer.id,
        createdAt,
        members: { createMany: { data: members.map((m) => ({ contactId: m.id, addedAt: createdAt })), skipDuplicates: true } },
      },
      select: { id: true },
    });
    const evidence = `On the list "${spec.name}" (${spec.fileName}), uploaded ${clock.today(createdAt)}: ${spec.consentNote}`.slice(0, 1000);
    const data: Prisma.ContactConsentCreateManyInput[] = [];
    for (const m of members) {
      for (const topic of spec.topics) {
        const key = consentKey(m.id, "EMAIL", topic);
        if (w.consents.has(key)) continue;
        data.push({ contactId: m.id, channel: "EMAIL", topic, status: "SUBSCRIBED", source: "IMPORT", evidence, capturedById: w.cast.marketer.id, capturedAt: createdAt });
        w.consents.set(key, { status: "SUBSCRIBED", capturedAt: createdAt, withdrawnAt: null });
      }
      if (m.emailStatus === "UNCHECKED" && m.email) await markValid(w, m, plus(createdAt, int(1, 20) * 1000));
    }
    consents += (await w.db.contactConsent.createMany({ data, skipDuplicates: true })).count;
    rows.set(spec.key, { id: list.id, createdAt, members });
    made += 1;
  }
  return { rows, made, consents };
}

function audienceMembers(w: World, spec: AudienceSpec, channel: MessageChannel, when: Date): Ct[] {
  const rel = new Set(spec.companyFilters.relationshipType);
  const stages = new Set(spec.companyFilters.stage);
  const f = spec.contactFilters;
  const pool: Ct[] = [];
  for (const co of w.marketable) {
    if (!rel.has(co.relationshipType) || !stages.has(co.stage) || co.createdAt > when) continue;
    for (const c of contactsOf(w, co.id)) {
      if (c.createdAt > when) continue;
      if (channel === "EMAIL" && !c.email) continue;
      if (channel === "WHATSAPP" && !c.phone) continue;
      if (f.designation && f.designation.length > 0 && !f.designation.includes(c.designation)) continue;
      if (f.primaryOnly && !c.isPrimary) continue;
      if (f.verifiedOnly && channel === "EMAIL" && !isVerified(c, when)) continue;
      pool.push(c);
    }
  }
  return capPerCompany(pool, f.maxPerCompany);
}

// ─── 7. Campaigns ───────────────────────────────────────────────────────────────────────────────

type CampaignPlan = {
  name: string;
  template: string;
  audience?: string;
  list?: string;
  status: CampaignStatus;
  createdAgo: number;
  /** When it was meant to go — days ago, or negative for the future. */
  sendAgo?: number;
  window?: [number, number];
  /** Of those who could receive it, the share that had gone when it stopped. */
  progress?: number;
  /**
   * Make sure every outcome a message can have appears somewhere. The rates are believable, so on a
   * small book a bounce or a complaint may simply not come up; this campaign's last few recipients
   * take whichever outcomes nothing else has produced yet.
   */
  ensureOutcomes?: boolean;
};

const CAMPAIGNS: CampaignPlan[] = [
  { name: "Newsletter — first quarter", template: "newsletter", audience: "everyone", list: "events", status: "SENT", createdAgo: 168, sendAgo: 165 },
  { name: "Renewal call list — first quarter", template: "task", audience: "deciders", status: "CANCELLED", createdAgo: 132 },
  { name: "Copilot for Microsoft 365 — launch", template: "copilot", audience: "deciders", list: "events", status: "SENT", createdAgo: 98, sendAgo: 95, window: [600, 780], ensureOutcomes: true },
  { name: "Newsletter — second quarter", template: "newsletter", audience: "everyone", list: "expo", status: "SENT", createdAgo: 76, sendAgo: 72 },
  { name: "Adobe price change — renew early", template: "adobe", audience: "deciders", list: "expo", status: "CANCELLED", createdAgo: 62, sendAgo: 60, progress: 0.55 },
  { name: "AMC renewals — WhatsApp nudge", template: "wa-amc", audience: "whatsapp", status: "PAUSED", createdAgo: 47, sendAgo: 45, progress: 0.5 },
  { name: "Service window — in-app notice", template: "notification", audience: "whatsapp", status: "DRAFT", createdAgo: 20 },
  { name: "Festive offers — laptops, licences and AMC", template: "festive", audience: "deciders", list: "expo", status: "SENDING", createdAgo: 3, sendAgo: 1, progress: 0.88 },
  { name: "Backup webinar — invitation", template: "webinar", audience: "everyone", list: "events", status: "PENDING_APPROVAL", createdAgo: 2, sendAgo: -4 },
  { name: "Backup webinar — WhatsApp reminder", template: "wa-webinar", audience: "whatsapp", status: "SCHEDULED", createdAgo: 2, sendAgo: -6, window: [600, 720] },
];

async function seedCampaigns(
  w: World,
  templates: Map<string, TemplateRow>,
  audienceIds: Map<string, string>,
  lists: Map<string, ListRow>,
): Promise<{ campaigns: number; messages: number; events: number; linkConsents: number }> {
  const db = w.db;
  const serials = new Map<string, number>();
  const nextReference = async (date: Date) => {
    const prefix = `MC/${financialYearOf(date)}/`;
    if (!serials.has(prefix)) {
      const last = await db.campaign.findFirst({ where: { reference: { startsWith: prefix } }, orderBy: { reference: "desc" }, select: { reference: true } });
      serials.set(prefix, last ? Number(last.reference.slice(prefix.length)) || 0 : 0);
    }
    const n = serials.get(prefix)! + 1;
    serials.set(prefix, n);
    return `${prefix}${String(n).padStart(4, "0")}`;
  };

  let campaigns = 0;
  let messages = 0;
  let events = 0;
  let linkConsents = 0;
  const resend = w.providers.get("resend") ?? null;
  const gupshup = w.providers.get("gupshup") ?? null;
  const OUTCOMES: MessageStatus[] = ["SENT", "DELIVERED", "OPENED", "CLICKED", "BOUNCED", "COMPLAINED", "FAILED"];
  const produced = new Set<MessageStatus>();
  let unsubscribedSeen = false;

  for (const plan of CAMPAIGNS) {
    if (await db.campaign.findFirst({ where: { name: plan.name }, select: { id: true } })) continue;
    const template = templates.get(plan.template)!;
    const channel = template.channel;
    const audience = plan.audience ? AUDIENCES.find((a) => a.key === plan.audience)! : null;
    const list = plan.list ? lists.get(plan.list) ?? null : null;
    const createdAt = workTime(w, daysAgo(plan.createdAgo));
    const reference = await nextReference(createdAt);
    const window = plan.window ? { startMinute: plan.window[0], endMinute: plan.window[1] } : null;
    const rules = { ...w.settings.rules, window };
    let scheduledFor = plan.sendAgo === undefined ? null : plan.sendAgo >= 0 ? duringWorkHours(daysAgo(plan.sendAgo)) : duringWorkHours(daysAhead(-plan.sendAgo));
    const sends = ["SCHEDULED", "SENDING", "SENT", "PAUSED"].includes(plan.status) || (plan.status === "CANCELLED" && plan.progress !== undefined);
    let sendBase = sends && scheduledFor ? nextSendTime(scheduledFor, rules) : null;
    // Something that has already gone out went on a working day that has already happened: a weekend
    // or a holiday pushes the window to the next one, which may still be ahead of us.
    for (let back = 1; sendBase && plan.status !== "SCHEDULED" && sendBase.getTime() > w.now.getTime() - 3 * HOUR && back < 15; back++) {
      scheduledFor = duringWorkHours(daysAgo((plan.sendAgo ?? 0) + back));
      sendBase = nextSendTime(scheduledFor, rules);
    }
    // Pressed send a little after it was built; the messages wait for "not before" and the window.
    const startedAt = sends ? earlier(plus(createdAt, int(1, 5) * HOUR), scheduledFor ?? w.now) : null;

    // Who it reaches: the audience as it stood that day, plus everybody on the list.
    const asOf = sendBase && sendBase < w.now ? sendBase : w.now;
    const seen = new Set<string>();
    const recipients: Ct[] = [];
    for (const c of [...(audience ? audienceMembers(w, audience, channel, asOf) : []), ...(list?.members ?? [])]) {
      if (seen.has(c.id) || !marketableContact(w, c)) continue;
      seen.add(c.id);
      recipients.push(c);
    }
    const verdicts = recipients.map((c) => ({ c, v: verdictFor(w, c, channel, template.topic, "MARKETING", asOf) }));
    const sendable = verdicts.filter((x) => x.v.ok);
    const needsApproval = sendable.length >= w.settings.approvalThreshold;
    const approved = needsApproval && sends;

    const campaign = await db.campaign.create({
      data: {
        reference,
        name: plan.name,
        audienceId: audience ? audienceIds.get(audience.key)! : null,
        listId: list?.id ?? null,
        templateId: template.id,
        channel,
        status: plan.status,
        scheduledFor,
        windowStartMinute: window?.startMinute ?? null,
        windowEndMinute: window?.endMinute ?? null,
        approvedById: approved ? w.cast.approver.id : null,
        approvedAt: approved ? plus(startedAt!, -30 * 60000) : null,
        startedAt,
        createdById: w.cast.marketer.id,
        createdAt,
      },
      select: { id: true },
    });
    campaigns += 1;
    if (!sends || !sendBase) {
      // A draft, one waiting for approval, or one stopped before it was ever scheduled: no recipients
      // are frozen until somebody schedules it, so there are no messages.
      if (plan.status === "CANCELLED") await db.campaign.update({ where: { id: campaign.id }, data: { finishedAt: workTime(w, plus(createdAt, 2 * DAY)) } });
      continue;
    }

    const links = linksIn(template.body);
    // What had not gone when it stopped: everything for a scheduled one, at least one for one stopped part-way.
    const held = plan.status === "SCHEDULED" ? sendable.length : plan.progress === undefined ? 0 : Math.max(1, Math.round(sendable.length * (1 - plan.progress)));
    const goneCount = Math.max(0, sendable.length - held);
    let lastSent = sendBase;
    let index = 0;

    for (const { c, v } of verdicts) {
      const token = newToken();
      const base: MessageDraft = {
        token,
        campaignId: campaign.id,
        companyId: c.companyId,
        contactId: c.id,
        channel,
        messageClass: "MARKETING",
        toEmail: c.email,
        toPhone: c.phone,
        scheduledFor: sendBase,
        createdAt: startedAt!,
        body: "",
      };
      if (!v.ok) {
        await writeMessage(w, { ...base, subject: template.subject, status: "SUPPRESSED", suppressedReason: reasonText(v) }, []);
        messages += 1;
        continue;
      }

      const recipient = recipientOf(w, c, sendBase);
      let content: { subject: string | null; body: string; textBody?: string | null; unsubscribeUrl?: string | null };
      if (channel === "EMAIL") {
        const built = buildMarketingEmail({ template, recipient, settings: w.settings, token, origin: ORIGIN, trackingKey: w.trackingKey });
        if (!built.ok) {
          await writeMessage(w, { ...base, subject: template.subject, status: "SUPPRESSED", suppressedReason: `Missing merge field(s): ${built.missing.join(", ")}` }, []);
          messages += 1;
          continue;
        }
        content = { subject: built.subject, body: built.html, textBody: built.text, unsubscribeUrl: built.unsubscribeUrl };
      } else {
        const values = mergeValuesFor(recipient, w.settings, { unsubscribeUrl: `${ORIGIN}/preferences/${token}` });
        const body = render(template.body, values);
        content = { subject: "", body: body.ok ? body.text : "" };
      }

      const i = index++;
      const gone = i < goneCount;
      // A hundred a tick, a tick every five minutes.
      const sentAt = past(w, plus(sendBase, Math.floor(i / 100) * 5 * 60000 + int(1, 240) * 1000));

      if (!gone) {
        if (plan.status === "SENDING") {
          await writeMessage(w, { ...base, ...content, status: "SENDING", lockedAt: plus(w.now, -int(2, 9) * 60000), lockedBy: randomBytes(8).toString("hex"), attempts: 1 }, []);
        } else if (plan.status === "CANCELLED") {
          // Held back by a rate limit, then stopped — `cancelCampaign`'s own words on the row.
          await writeMessage(
            w,
            { ...base, ...content, status: "SUPPRESSED", suppressedReason: "The campaign was stopped before this went out.", attempts: int(1, 2), error: "Resend returned 429: Too many requests — daily sending quota reached.", providerId: resend },
            [],
          );
        } else {
          // PAUSED and SCHEDULED: WhatsApp, waiting. Its provider is switched off, so the tick that
          // claims a due one puts it straight back with the reason.
          const due = sendBase < w.now;
          await writeMessage(w, { ...base, ...content, status: "QUEUED", attempts: due ? 1 : 0, error: due ? "No provider is configured for this." : null }, []);
        }
        messages += 1;
        continue;
      }

      // Outcomes nothing has produced yet, and an unsubscribe — the last of the coverage campaign's
      // recipients take them, one each.
      const missing = OUTCOMES.filter((o) => !produced.has(o));
      const pending = missing.length + (unsubscribedSeen ? 0 : 1);
      const forcing = !!plan.ensureOutcomes && channel === "EMAIL" && pending > 0 && goneCount - i <= pending;
      const outcome = simulate(w, channel, sentAt, links, { force: forcing ? (missing[0] ?? "OPENED") : undefined, unsubscribe: forcing && missing.length === 0 });
      if (channel === "EMAIL") produced.add(outcome.status);
      if (outcome.unsubscribed) unsubscribedSeen = true;
      const provider = channel === "WHATSAPP" ? gupshup : resend;
      await writeMessage(
        w,
        {
          ...base,
          ...content,
          status: outcome.status,
          attempts: 1,
          sentAt: outcome.status === "FAILED" ? null : sentAt,
          providerId: provider,
          providerMessageId: outcome.status === "FAILED" ? null : providerMessageId(channel, false),
          error: outcome.error,
        },
        outcome.events,
      );
      messages += 1;
      events += outcome.events.length;
      if (outcome.status !== "FAILED") noteSend(w, c.id, sentAt);
      lastSent = later(lastSent, sentAt);
      await aftermath(w, c, outcome, channel === "WHATSAPP" ? "gupshup" : "resend");

      // The newsletter's "invite me" link is an opt-in in its own right: a click on it is recorded
      // as consent to hear about events, where there was none.
      const click = outcome.events.find((e) => e.type === "CLICK");
      if (click?.url?.includes("/events/keep-me-posted")) {
        const key = consentKey(c.id, "EMAIL", "EVENTS");
        if (!w.consents.has(key)) {
          await db.contactConsent.create({
            data: {
              contactId: c.id,
              channel: "EMAIL",
              topic: "EVENTS",
              status: "SUBSCRIBED",
              source: "CAMPAIGN_LINK",
              evidence: `Clicked “Want an invitation?” in ${reference} on ${clock.date(click.occurredAt)}.`,
              capturedAt: click.occurredAt,
            },
          });
          w.consents.set(key, { status: "SUBSCRIBED", capturedAt: click.occurredAt, withdrawnAt: null });
          linkConsents += 1;
        }
      }
    }

    const finishedAt =
      plan.status === "SENT" ? past(w, plus(lastSent, 5 * 60000)) : plan.status === "CANCELLED" ? past(w, plus(lastSent, int(20, 90) * 60000)) : null;
    if (finishedAt) await db.campaign.update({ where: { id: campaign.id }, data: { finishedAt } });
  }
  return { campaigns, messages, events, linkConsents };
}

// ─── 8. Journeys that are drafted, paused or retired ────────────────────────────────────────────

type StepSpec = {
  order: number;
  delayDays: number;
  channel: MessageChannel;
  template?: string;
  taskTitle?: string;
  taskDetail?: string;
  taskDueDays?: number;
  taskAssignee?: string;
};
type Candidate = { companyId: string; subjectId: string; enrolledAt: Date };

async function createTask(
  w: World,
  input: { title: string; description: string | null; dueDate: Date | null; assignee: string; companyId: string; createdAt: Date },
) {
  const done = input.dueDate ? input.dueDate.getTime() < w.now.getTime() - DAY && chance(0.85) : false;
  await w.db.task.create({
    data: {
      title: input.title,
      description: input.description,
      dueDate: input.dueDate,
      assignedToUserId: input.assignee,
      createdByUserId: input.assignee,
      companyId: input.companyId,
      done,
      doneAt: done && input.dueDate ? past(w, plus(input.dueDate, -int(0, 36) * HOUR)) : null,
      createdAt: input.createdAt,
    },
  });
}

async function seedJourneys(w: World, templates: Map<string, TemplateRow>): Promise<{ journeys: number; enrolments: number; messages: number; tasks: number }> {
  const db = w.db;
  const out = { journeys: 0, enrolments: 0, messages: 0, tasks: 0 };
  const marketableIds = new Set(w.marketable.map((c) => c.id));

  // Lapsed subscriptions, warranties and happy customers: the subjects the triggers would have found.
  const lapsed = await db.companyProduct.findMany({
    where: {
      companyId: { in: [...marketableIds] },
      parentId: null,
      item: { type: "SUBSCRIPTION" },
      orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
      endDate: { gte: daysAgo(170), lte: daysAgo(25) },
    },
    select: { id: true, companyId: true, endDate: true },
  });
  const assets = await db.asset.findMany({
    where: { ownerCompanyId: { in: [...marketableIds] }, status: { notIn: ["RETIRED", "LOST"] } },
    select: { id: true, ownerCompanyId: true },
  });
  const promoters = new Map<string, Date>();
  for (const f of [...w.feedback].sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())) {
    if (promoters.has(f.companyId) || !marketableIds.has(f.companyId)) continue;
    promoters.set(f.companyId, f.rating >= 4 ? f.submittedAt : new Date(0));
  }

  const plans: {
    name: string;
    trigger: string;
    triggerConfig: Record<string, unknown>;
    status: JourneyStatus;
    exitOn: string[];
    reEnrolAfterDays: number | null;
    createdAgo: number;
    steps: StepSpec[];
    candidates: Candidate[];
    exits: string[];
  }[] = [
    {
      name: "Welcome — first order delivered",
      trigger: "NEW_CUSTOMER",
      triggerConfig: { days: 30 },
      status: "DRAFT",
      exitOn: ["TICKET_RAISED"],
      reEnrolAfterDays: null,
      createdAgo: 18,
      steps: [
        { order: 1, delayDays: 0, channel: "EMAIL", template: "welcome" },
        { order: 2, delayDays: 3, channel: "TASK", taskTitle: "Book the onboarding call with {{companyName}}", taskDetail: "Walk them through the support desk and the portal.", taskDueDays: 2, taskAssignee: "OWNER" },
        { order: 3, delayDays: 7, channel: "NOTIFICATION", taskTitle: "Introduce the support desk to {{companyName}}", taskDetail: "A short call from the support lead.", taskDueDays: 3, taskAssignee: "ASSIGNEE" },
      ],
      candidates: [],
      exits: [],
    },
    {
      name: "Lapsed subscriptions — win back",
      trigger: "RENEWAL_LAPSED",
      triggerConfig: { days: 30 },
      status: "PAUSED",
      exitOn: ["RENEWED", "ORDERED"],
      reEnrolAfterDays: 365,
      createdAgo: 160,
      steps: [
        { order: 1, delayDays: 0, channel: "EMAIL", template: "winback" },
        { order: 2, delayDays: 5, channel: "WHATSAPP", template: "wa-winback" },
        { order: 3, delayDays: 7, channel: "TASK", taskTitle: "Call {{companyName}} about the lapsed subscription", taskDetail: "Raised automatically by the journey.", taskDueDays: 2, taskAssignee: "OWNER" },
      ],
      candidates: [...new Map(lapsed.map((p) => [p.id, p])).values()]
        .sort((a, b) => Number(!!primaryBlockedSince(w, b.companyId)) - Number(!!primaryBlockedSince(w, a.companyId)))
        .slice(0, 14)
        .map((p) => ({
          companyId: p.companyId,
          subjectId: p.id,
          enrolledAt: workTime(w, later(plus(p.endDate!, int(1, 3) * DAY), plus(primaryBlockedSince(w, p.companyId) ?? new Date(0), DAY))),
        })),
      exits: [exitLabels.RENEWED, exitLabels.ORDERED],
    },
    {
      name: "Warranty ending — WhatsApp heads-up",
      trigger: "WARRANTY_EXPIRING",
      triggerConfig: { days: 60 },
      status: "ARCHIVED",
      exitOn: ["ORDERED"],
      reEnrolAfterDays: null,
      createdAgo: 330,
      steps: [
        { order: 1, delayDays: 0, channel: "WHATSAPP", template: "wa-warranty" },
        { order: 2, delayDays: 10, channel: "TASK", taskTitle: "Quote an AMC for {{companyName}}", taskDetail: "Machines coming out of warranty — raised by the journey.", taskDueDays: 5, taskAssignee: "OWNER" },
      ],
      candidates: [
        ...some(assets.filter((a) => primaryBlockedSince(w, a.ownerCompanyId!)), 3),
        ...some(assets.filter((a) => !primaryBlockedSince(w, a.ownerCompanyId!)), 9),
      ].map((a) => ({
        companyId: a.ownerCompanyId!,
        subjectId: a.id,
        enrolledAt: workTime(w, later(daysAgo(int(140, 300)), plus(primaryBlockedSince(w, a.ownerCompanyId!) ?? new Date(0), DAY))),
      })),
      exits: [exitLabels.ORDERED],
    },
    {
      name: "Happy customers — ask for a referral",
      trigger: "FEEDBACK_PROMOTER",
      triggerConfig: {},
      status: "PAUSED",
      exitOn: ["ORDERED", "TICKET_RAISED"],
      reEnrolAfterDays: 365,
      createdAgo: 210,
      steps: [
        { order: 1, delayDays: 0, channel: "NOTIFICATION", taskTitle: "Thank {{companyName}} for the feedback and ask for a referral", taskDetail: "They rated us 4 or 5. A call, not an email.", taskDueDays: 3, taskAssignee: "OWNER" },
        { order: 2, delayDays: 7, channel: "EMAIL", template: "referral" },
      ],
      candidates: [...promoters.entries()]
        .filter(([, at]) => at.getTime() > 0 && at.getTime() < w.now.getTime() - 10 * DAY)
        .map(([companyId, at]) => ({ companyId, subjectId: companyId, enrolledAt: workTime(w, plus(at, int(1, 2) * DAY)) })),
      exits: [exitLabels.ORDERED, exitLabels.TICKET_RAISED],
    },
  ];

  for (const plan of plans) {
    if (await db.journey.findFirst({ where: { name: plan.name }, select: { id: true } })) continue;
    // A journey's steps run at day granularity; nobody here is left part-way through one, because a
    // paused journey's enrolments still advance on the tick and its email steps would really send.
    const total = plan.steps.reduce((t, s) => t + s.delayDays, 0);
    const candidates = plan.candidates
      .filter((c) => w.companies.get(c.companyId)?.managedByResellerId === null)
      .map((c) => ({ ...c, enrolledAt: earlier(c.enrolledAt, daysAgo(total + 2)) }))
      .filter((c, i, all) => all.findIndex((x) => x.subjectId === c.subjectId) === i);
    const firstEnrolled = candidates.reduce((d, c) => earlier(d, c.enrolledAt), daysAgo(plan.createdAgo));
    const journey = await db.journey.create({
      data: {
        name: plan.name,
        trigger: plan.trigger,
        triggerConfig: plan.triggerConfig as Prisma.InputJsonValue,
        status: plan.status,
        exitOn: plan.exitOn as Prisma.InputJsonValue,
        reEnrolAfterDays: plan.reEnrolAfterDays,
        createdById: w.cast.marketer.id,
        createdAt: workTime(w, plus(firstEnrolled, -int(3, 20) * DAY)),
        steps: {
          create: plan.steps.map((s) => ({
            order: s.order,
            delayDays: s.delayDays,
            channel: s.channel,
            templateId: s.template ? templates.get(s.template)!.id : null,
            taskTitle: s.taskTitle ?? null,
            taskDetail: s.taskDetail ?? null,
            taskDueDays: s.taskDueDays ?? null,
            taskAssignee: s.taskAssignee ?? null,
          })),
        },
      },
      include: { steps: { orderBy: { order: "asc" }, select: { id: true, order: true } } },
    });
    out.journeys += 1;

    for (const cand of candidates) {
      const company = w.companies.get(cand.companyId)!;
      let status: "COMPLETED" | "EXITED" | "SUPPRESSED" = "COMPLETED";
      let exitReason: string | null = null;
      let exitedAt: Date | null = null;
      let currentStep = 0;
      let runAt = cand.enrolledAt;
      const drafts: { data: MessageDraft; events: EventDraft[]; contact: Ct | null; outcome: Outcome | null }[] = [];

      for (const [k, step] of plan.steps.entries()) {
        runAt = stepDueAt(runAt, step.delayDays);
        if (k > 0 && plan.exits.length && chance(0.18)) {
          status = "EXITED";
          exitReason = pick(plan.exits);
          exitedAt = runAt;
          break;
        }
        const row = journey.steps.find((s) => s.order === step.order)!;

        if (step.channel === "TASK" || step.channel === "NOTIFICATION") {
          const assignee = step.taskAssignee === "ASSIGNEE" ? company.assignedToUserId : company.ownerUserId;
          if (assignee) {
            const title = (step.taskTitle ?? plan.name).replace("{{companyName}}", company.name);
            await createTask(w, {
              title,
              description: step.taskDetail ?? null,
              dueDate: step.taskDueDays ? stepDueAt(runAt, step.taskDueDays) : null,
              assignee,
              companyId: company.id,
              createdAt: runAt,
            });
            out.tasks += 1;
            if (step.channel === "NOTIFICATION") {
              // Recorded on the timeline the way the main demo records a task step that ran.
              drafts.push({
                data: { token: newToken(), stepId: row.id, companyId: company.id, channel: "NOTIFICATION", messageClass: "MARKETING", body: title, scheduledFor: runAt, status: "SENT", sentAt: runAt, attempts: 1, createdAt: runAt },
                events: [],
                contact: null,
                outcome: null,
              });
            }
          }
          currentStep = step.order;
          continue;
        }

        // A message: the primary contact, verified for email — `runStep`'s own narrowing.
        const template = templates.get(step.template!)!;
        const primary = contactsOf(w, company.id).find(
          (c) => c.isPrimary && (step.channel === "EMAIL" ? isVerified(c, runAt) : !!c.phone),
        );
        currentStep = step.order;
        if (!primary) continue; // Nobody to send it to: skipped, and the journey moves on.
        const scheduledFor = nextSendTime(runAt, w.settings.rules);
        const token = newToken();
        const verdict = verdictFor(w, primary, step.channel, template.topic, "MARKETING", scheduledFor);
        const base: MessageDraft = {
          token,
          stepId: row.id,
          companyId: company.id,
          contactId: primary.id,
          channel: step.channel,
          messageClass: "MARKETING",
          toEmail: primary.email,
          toPhone: primary.phone,
          scheduledFor,
          createdAt: runAt,
          body: "",
        };
        if (!verdict.ok) {
          drafts.push({ data: { ...base, subject: template.subject, status: "SUPPRESSED", suppressedReason: reasonText(verdict) }, events: [], contact: primary, outcome: null });
          if (unreachable(verdict)) {
            status = "SUPPRESSED";
            exitReason = exitLabels.SUPPRESSED;
            exitedAt = runAt;
            break;
          }
          continue;
        }
        const recipient = recipientOf(w, primary, scheduledFor);
        let content: { subject: string | null; body: string; textBody?: string | null; unsubscribeUrl?: string | null };
        if (step.channel === "EMAIL") {
          const built = buildMarketingEmail({ template, recipient, settings: w.settings, token, origin: ORIGIN, trackingKey: w.trackingKey });
          if (!built.ok) continue;
          content = { subject: built.subject, body: built.html, textBody: built.text, unsubscribeUrl: built.unsubscribeUrl };
        } else {
          const body = render(template.body, mergeValuesFor(recipient, w.settings, { unsubscribeUrl: `${ORIGIN}/preferences/${token}` }));
          content = { subject: "", body: body.ok ? body.text : "" };
        }
        const sentAt = past(w, plus(scheduledFor, int(5, 280) * 1000));
        const outcome = simulate(w, step.channel, sentAt, linksIn(template.body));
        drafts.push({
          data: {
            ...base,
            ...content,
            status: outcome.status,
            attempts: 1,
            sentAt: outcome.status === "FAILED" ? null : sentAt,
            providerId: (step.channel === "WHATSAPP" ? w.providers.get("gupshup") : w.providers.get("resend")) ?? null,
            providerMessageId: outcome.status === "FAILED" ? null : providerMessageId(step.channel, false),
            error: outcome.error,
          },
          events: outcome.events,
          contact: primary,
          outcome,
        });
        if (outcome.status !== "FAILED") noteSend(w, primary.id, sentAt);
        await aftermath(w, primary, outcome, step.channel === "WHATSAPP" ? "gupshup" : "resend");
        if (outcome.unsubscribed) {
          status = "EXITED";
          exitReason = exitLabels.UNSUBSCRIBED;
          exitedAt = outcome.events.find((e) => e.type === "UNSUBSCRIBE")?.occurredAt ?? runAt;
          break;
        }
      }

      const enrolment = await db.journeyEnrolment.create({
        data: {
          journeyId: journey.id,
          companyId: company.id,
          triggerKey: enrolmentKey(plan.trigger, cand.subjectId),
          status,
          currentStep,
          nextRunAt: null,
          enrolledAt: cand.enrolledAt,
          exitedAt,
          exitReason,
        },
        select: { id: true },
      });
      out.enrolments += 1;
      for (const d of drafts) {
        await writeMessage(w, { ...d.data, enrolmentId: enrolment.id }, d.events);
        out.messages += 1;
      }
    }
  }
  return out;
}

// ─── 9. Notices about an order the customer already has ─────────────────────────────────────────

/**
 * Renewal reminders and "your order is done", sent by hand from the renewals and orders lists:
 * transactional, so an unsubscribe from offers does not stop them — a bounce, a complaint or a
 * reseller's customer still does. Carried by the provider for transactional mail.
 */
async function seedNotices(w: World): Promise<{ renewal: number; fulfilment: number; events: number }> {
  const db = w.db;
  const out = { renewal: 0, fulfilment: 0, events: 0 };
  const done = await db.marketingMessage.count({ where: { noticeKind: { not: null }, company: { tags: { has: DEMO_TAG } } } });
  if (done > 0) return out;

  const marketableIds = w.marketable.map((c) => c.id);
  const select = {
    id: true,
    companyId: true,
    orderSeq: true,
    poNumber: true,
    quantity: true,
    endDate: true,
    fulfilledAt: true,
    orderStatus: true,
    fullTermUnitPrice: true,
    addedByUserId: true,
    item: { select: { name: true } },
  } as const;
  const renewing = await db.companyProduct.findMany({
    where: {
      companyId: { in: marketableIds },
      parentId: null,
      item: { type: "SUBSCRIPTION" },
      orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
      endDate: { gte: daysAgo(20), lte: daysAhead(75) },
    },
    select,
  });
  const fulfilled = await db.companyProduct.findMany({
    where: { companyId: { in: marketableIds }, orderStatus: "FULFILLED", fulfilledAt: { gte: daysAgo(150) } },
    select,
  });
  const m365 = w.providers.get("m365") ?? null;

  const send = async (kind: NoticeKind, product: (typeof renewing)[number], when: Date) => {
    if (kind === "FULFILMENT" && !canAnnounceFulfilment(product.orderStatus)) return;
    const company = w.companies.get(product.companyId)!;
    const people = contactsOf(w, company.id).filter((c) => c.email && c.createdAt < when);
    const chosen = people.filter((c) => c.isPrimary).concat(chance(0.35) ? some(people.filter((c) => !c.isPrimary), 1) : []);
    const notice = NOTICES[kind];
    for (const c of chosen) {
      const verdict = verdictFor(w, c, "EMAIL", notice.topic, "TRANSACTIONAL", when);
      if (!verdict.ok) continue; // The dialog shows why, and nothing is queued for them.
      const token = newToken();
      const days = product.endDate ? Math.ceil((product.endDate.getTime() - when.getTime()) / DAY) : null;
      const values: MergeValues = mergeValuesFor(recipientOf(w, c, when), w.settings, {
        ...subscriptionMergeValues({ item: product.item, quantity: product.quantity, endDate: product.endDate, fullTermUnitPrice: product.fullTermUnitPrice }),
        renewalValue: product.fullTermUnitPrice ? formatCurrency(Number(product.fullTermUnitPrice) * product.quantity) : null,
        expiryDate: product.endDate ? formatCalendarDay(product.endDate) : null,
        daysLeft: days,
        daysLeftPhrase: daysLeftPhrase(days),
        orderId: formatOrderId(product.orderSeq),
        poNumber: product.poNumber,
        fulfilledDate: product.fulfilledAt ? clock.date(product.fulfilledAt) : null,
        unsubscribeUrl: `${ORIGIN}/preferences/${token}`,
      });
      const subject = render(notice.subject, values);
      const body = render(notice.body, values);
      if (!subject.ok || !body.ok) continue;
      const sentAt = past(w, plus(when, int(3, 40) * 1000));
      const outcome = simulate(w, "EMAIL", sentAt, linksIn(body.text), { transactional: true });
      await writeMessage(
        w,
        {
          token,
          companyId: company.id,
          contactId: c.id,
          channel: "EMAIL",
          messageClass: "TRANSACTIONAL",
          subject: subject.text,
          body: body.text,
          toEmail: c.email,
          sentByUserId: company.ownerUserId ?? product.addedByUserId,
          companyProductId: product.id,
          noticeKind: kind,
          scheduledFor: when,
          status: outcome.status,
          attempts: 1,
          sentAt: outcome.status === "FAILED" ? null : sentAt,
          providerId: m365,
          providerMessageId: outcome.status === "FAILED" ? null : providerMessageId("EMAIL", true),
          error: outcome.error,
          createdAt: when,
        },
        outcome.events,
      );
      out.events += outcome.events.length;
      out[kind === "RENEWAL" ? "renewal" : "fulfilment"] += 1;
      await aftermath(w, c, outcome, "m365");
    }
  };

  for (const p of some(renewing, Math.min(16, renewing.length))) {
    // A month or two before it ends, within the last six weeks — a reminder is sent, not scheduled.
    const target = plus(p.endDate!, -int(30, 60) * DAY);
    const when = workTime(w, earlier(later(target, daysAgo(45)), daysAgo(int(1, 6))));
    await send("RENEWAL", p, when);
  }
  for (const p of some(fulfilled, Math.min(16, fulfilled.length))) {
    const when = workTime(w, plus(p.fulfilledAt!, int(2, 30) * HOUR));
    await send("FULFILMENT", p, when);
  }
  return out;
}

// ─── 10. Forms, invitations and who answered ────────────────────────────────────────────────────

type FormPlan = {
  slug: string;
  name: string;
  category: FormCategory;
  fillMode: FormFillMode;
  topic: MarketingTopic;
  createsLead: boolean;
  createdAgo: number;
  /** Days from now; negative is the past. */
  eventIn?: number;
  eventHour?: [number, number];
  eventLengthMinutes?: number;
  closesInDays?: number;
  venue?: string;
  capacity?: number;
  invites: number;
  invitedAgo: [number, number];
  linkAnswers: number;
  fields?: FormField[];
  headline?: string;
  intro?: string;
};

const blank = { options: [] as string[], placeholder: null, help: null };

const FORMS: FormPlan[] = [
  {
    slug: "roundtable-copilot-pune",
    name: "Customer roundtable — Copilot in practice, Pune",
    category: "EVENT",
    fillMode: "BOTH",
    topic: "EVENTS",
    createsLead: false,
    createdAgo: 75,
    eventIn: -38,
    eventHour: [18, 30],
    eventLengthMinutes: 180,
    venue: "The Westin, Koregaon Park, Pune",
    capacity: 30,
    invites: 26,
    invitedAgo: [62, 58],
    linkAnswers: 6,
    headline: "Copilot in practice — a customer roundtable",
    intro: "Twelve IT heads, one evening, and an honest conversation about what Copilot has and hasn't changed.",
  },
  {
    slug: "webinar-ransomware-backup",
    name: "Webinar — ransomware-proof backup in 45 minutes",
    category: "EVENT",
    fillMode: "INVITE",
    topic: "PRODUCT_NEWS",
    createsLead: false,
    createdAgo: 9,
    eventIn: 12,
    eventHour: [16, 0],
    eventLengthMinutes: 45,
    venue: "Online — the Teams link is sent on registration",
    capacity: 100,
    invites: 30,
    invitedAgo: [6, 4],
    linkAnswers: 0,
    headline: "Ransomware-proof backup, live",
    intro: "A live restore from an immutable copy, and the three Microsoft 365 settings most tenants get wrong.",
  },
  {
    slug: "renewal-readiness-check",
    name: "Renewal readiness check",
    category: "ASSESSMENT",
    fillMode: "INVITE",
    topic: "RENEWALS",
    createsLead: true,
    createdAgo: 120,
    invites: 16,
    invitedAgo: [110, 30],
    linkAnswers: 0,
    headline: "Before your renewal: ten minutes, rough answers are fine",
  },
  {
    slug: "customer-survey-2026",
    name: "How are we doing? — 2026 customer survey",
    category: "SURVEY",
    fillMode: "BOTH",
    topic: "NEWSLETTER",
    createsLead: false,
    createdAgo: 45,
    closesInDays: 21,
    invites: 28,
    invitedAgo: [40, 30],
    linkAnswers: 5,
  },
  {
    slug: "delivery-address-update",
    name: "Tell us about a new delivery address",
    category: "OTHER",
    fillMode: "LINK",
    topic: "SERVICE",
    createsLead: false,
    createdAgo: 150,
    invites: 0,
    invitedAgo: [0, 0],
    linkAnswers: 6,
    headline: "Moving office?",
    intro: "Tell us where deliveries and engineers should go from now on.",
    fields: [
      { key: "name", label: "Your name", type: "TEXT", required: true, ...blank },
      { key: "email", label: "Work email", type: "EMAIL", required: true, ...blank },
      { key: "companyName", label: "Company", type: "TEXT", required: true, ...blank },
      { key: "newAddress", label: "The new address", type: "TEXTAREA", required: true, ...blank },
      { key: "effectiveFrom", label: "From when?", type: "DATE", required: true, ...blank },
      { key: "gatePass", label: "Do visitors need a gate pass?", type: "CHECKBOX", required: false, ...blank },
    ],
  },
];

const INTERESTS = [
  "Microsoft 365 and Copilot",
  "Security and compliance",
  "Cloud and infrastructure",
  "Design software (Autodesk, Adobe)",
  "Devices and hardware refresh",
  "Licensing and cost control",
];

/** Answers that pass the form's own validation — checked, not assumed. */
function answersFor(fields: FormField[], c: Ct, company: Co, attending: boolean | null): Answers {
  const a: Answers = { name: c.name, email: (c.email ?? "").toLowerCase(), companyName: company.name, phone: c.phone ?? "" };
  if (attending === false) return { name: a.name, email: a.email, companyName: a.companyName };
  for (const f of fields) {
    if (f.key in a || f.type === "HEADING") continue;
    switch (f.type) {
      case "TEXT":
        a[f.key] = f.key === "designation" ? pick(["IT Head", "CFO", "IT Manager", "Director — Operations"]) : pick(["Yes", "Head office only"]);
        break;
      case "TEXTAREA":
        a[f.key] = f.key === "newAddress"
          ? pick([
              "Plot 14, MIDC Bhosari, Pune 411026 — the new warehouse, ground floor.",
              "4th floor, Tower B, Cyber City, Gurugram 122002.",
              "Unit 7, Guindy Industrial Estate, Chennai 600032.",
            ])
          : chance(0.6) || f.required
          ? pick([
              "How others are measuring whether Copilot pays for itself.",
              "Moving 60 users from Google Workspace to Microsoft 365 before the renewal.",
              "Plot 14, MIDC Bhosari, Pune 411026 — the new warehouse, ground floor.",
              "Keep the engineers who know our site — that matters more than speed.",
              "Backup for the design team's file server, and something for the laptops.",
            ])
          : "";
        break;
      case "MULTISELECT":
        a[f.key] = chance(0.85) || f.required ? joinPicks(some(f.options.length ? f.options : INTERESTS, int(1, 3))) : "";
        break;
      case "SELECT":
      case "RADIO":
        a[f.key] = f.options.length && (chance(0.85) || f.required) ? pick(f.options) : "";
        break;
      case "NUMBER":
        a[f.key] = String(int(f.key === "sites" ? 1 : 15, f.key === "sites" ? 6 : 400));
        break;
      case "DATE":
        a[f.key] = clock.today(daysAhead(int(10, 200)));
        break;
      case "RATING":
        a[f.key] = String(pick([5, 5, 4, 4, 4, 3, 2]));
        break;
      case "CHECKBOX":
        a[f.key] = chance(0.5) ? "yes" : "";
        break;
      default:
        break;
    }
  }
  // A decline returned above with who they are, which is all an event asks of somebody not coming.
  const errors = validateAnswers(fields, a);
  if (Object.keys(errors).length) throw new Error(`Generated answers fail validation: ${JSON.stringify(errors)}`);
  return a;
}

async function seedForms(w: World): Promise<Record<string, number>> {
  const db = w.db;
  const out = { forms: 0, invites: 0, inviteMessages: 0, submissions: 0, attended: 0, noShow: 0, grants: 0, leads: 0 };
  const m365 = w.providers.get("m365") ?? null;
  const entry = await db.leadStage.findFirst({ where: { status: "NEW", archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } });

  const GRANTS: Record<string, { userId?: string; roleKey?: string; canEdit?: boolean; canViewResponses?: boolean; canInvite?: boolean }[]> = {
    "roundtable-copilot-pune": [
      { userId: pick(w.cast.sales).id, canInvite: true, canViewResponses: true },
      { roleKey: "SALES", canInvite: true },
    ],
    "webinar-ransomware-backup": [
      { userId: pick(w.cast.presales).id, canEdit: true },
      { roleKey: "SUPPORT", canViewResponses: true },
    ],
    "renewal-readiness-check": [
      { userId: w.cast.approver.id, canViewResponses: true },
      { roleKey: "SALES" },
    ],
    "customer-survey-2026": [
      { userId: w.cast.supportLead.id, canEdit: true, canViewResponses: true },
      { roleKey: "MANAGEMENT", canViewResponses: true },
    ],
    "delivery-address-update": [{ roleKey: "PURCHASE", canViewResponses: true }],
  };
  const roleKeys = new Set((await db.role.findMany({ select: { key: true } })).map((r) => r.key));

  for (const plan of FORMS) {
    if (await db.inboundForm.findUnique({ where: { slug: plan.slug }, select: { id: true } })) continue;
    const category = categoryOf(plan.category);
    const owner = plan.category === "SURVEY" ? w.cast.supportLead : w.cast.marketer;
    const createdAt = workTime(w, daysAgo(plan.createdAgo));
    const eventStartsAt =
      plan.eventIn !== undefined
        ? (() => {
            const day = clock.parts(plan.eventIn! < 0 ? daysAgo(-plan.eventIn!) : daysAhead(plan.eventIn!));
            return clock.at(day.year, day.month, day.day, plan.eventHour![0], plan.eventHour![1]);
          })()
        : null;
    const eventEndsAt = eventStartsAt ? plus(eventStartsAt, (plan.eventLengthMinutes ?? 60) * 60000) : null;
    const closesAt = eventStartsAt ? plus(eventStartsAt, -26 * HOUR) : plan.closesInDays ? daysAhead(plan.closesInDays) : null;

    // The builder's own checks — the form saved is one the builder would have accepted.
    const checked = checkFormSettings(
      {
        name: plan.name,
        slug: plan.slug,
        headline: plan.headline ?? category.defaults.headline,
        intro: plan.intro ?? category.defaults.intro,
        thankYouText: category.defaults.thankYouText,
        category: plan.category,
        fillMode: plan.fillMode,
        createsLead: plan.createsLead,
        topic: plan.topic,
        assignToUserId: null,
        closesAt: closesAt ? clock.input(closesAt) : "",
        eventStartsAt: eventStartsAt ? clock.input(eventStartsAt) : "",
        eventEndsAt: eventEndsAt ? clock.input(eventEndsAt) : "",
        venue: plan.venue ?? null,
        capacity: plan.capacity ?? null,
      },
      clock,
    );
    if (!checked.ok) throw new Error(`Form "${plan.name}": ${checked.error}`);
    const shaped = checkFieldsForSave(plan.fields ?? category.starter);
    if (!shaped.ok) throw new Error(`Form "${plan.name}": ${shaped.error}`);
    const fields = shaped.fields;

    const form = await db.inboundForm.create({
      data: {
        ...checked.settings,
        fields: fields as unknown as Prisma.InputJsonValue,
        active: true,
        ownerUserId: owner.id,
        createdById: owner.id,
        createdAt,
      },
      select: { id: true, slug: true, name: true },
    });
    out.forms += 1;

    for (const g of GRANTS[plan.slug] ?? []) {
      if (g.userId === owner.id || (g.roleKey && !roleKeys.has(g.roleKey))) continue;
      await db.formAccessGrant.create({
        data: {
          formId: form.id,
          userId: g.userId ?? null,
          roleKey: g.userId ? null : (g.roleKey ?? null),
          canEdit: g.canEdit === true,
          canViewResponses: g.canViewResponses === true,
          canInvite: g.canInvite === true,
          grantedById: owner.id,
          createdAt: plus(createdAt, int(1, 48) * HOUR),
        },
      });
      out.grants += 1;
    }

    const event = plan.category === "EVENT";
    const eventOver = event && eventStartsAt !== null && eventStartsAt < w.now;
    let coming = 0;
    const invited = new Set<string>();
    // The register on the day: about one in four who said yes did not come.
    let marked = 0;
    const register = () => (marked++ % 4 === 3 ? "NO_SHOW" : "ATTENDED") as "ATTENDED" | "NO_SHOW";

    // ── Personal invitations, each sent as a one-to-one message ──────────────────────────────
    if (plan.invites > 0) {
      const firstSend = workTime(w, daysAgo(plan.invitedAgo[0]));
      const lastSend = workTime(w, daysAgo(plan.invitedAgo[1]));
      const pool = w.customers
        .flatMap((co) => contactsOf(w, co.id))
        .filter((c) => c.email && c.createdAt < firstSend);
      for (const c of some(pool, Math.min(plan.invites * 2, pool.length))) {
        if (invited.size >= plan.invites) break;
        const company = w.companies.get(c.companyId)!;
        const sendAt = between(firstSend, later(lastSend, firstSend));
        // `inviteVerdict`: everything that stops a notice, plus an unsubscribe, a manual block or an opt-out of the topic.
        const state = stateFor(w, c, "EMAIL", plan.topic, sendAt);
        if (!inviteVerdict(state, { topic: plan.topic, limits: w.settings.limits }).ok) continue;
        invited.add(c.id);

        const inviter = company.ownerUserId ? w.ctx.people.find((p) => p.id === company.ownerUserId) ?? owner : owner;
        const inviteToken = newToken();
        const reminder = chance(0.3) && plan.invitedAgo[0] - plan.invitedAgo[1] < 20 ? past(w, plus(sendAt, int(3, 6) * DAY)) : null;
        const sends = reminder && (!eventStartsAt || reminder < eventStartsAt) ? [sendAt, reminder] : [sendAt];
        const invite = await db.formInvite.create({
          data: {
            formId: form.id,
            token: inviteToken,
            contactId: c.id,
            companyId: company.id,
            email: c.email!.trim().toLowerCase(),
            invitedById: inviter.id,
            createdAt: sendAt,
            lastSentAt: sends[sends.length - 1],
            sendCount: sends.length,
          },
          select: { id: true },
        });
        out.invites += 1;

        let bounced = false;
        for (const at of sends) {
          const token = newToken();
          const values = mergeValuesFor(recipientOf(w, c, at), w.settings, {
            formName: form.name,
            formLink: inviteLink(ORIGIN, form.slug, inviteToken),
            eventDate: eventStartsAt ? clock.dateTime(eventStartsAt) : null,
            eventVenue: plan.venue ?? null,
            inviterName: inviter.name,
            unsubscribeUrl: `${ORIGIN}/preferences/${token}`,
          });
          const subject = render(category.invitation.subject, values);
          const body = render(category.invitation.body, values);
          if (!subject.ok || !body.ok) throw new Error(`Invitation for "${form.name}" does not render.`);
          const sentAt = past(w, plus(at, int(2, 30) * 1000));
          const outcome = simulate(w, "EMAIL", sentAt, [], { transactional: true });
          await writeMessage(
            w,
            {
              token,
              companyId: company.id,
              contactId: c.id,
              channel: "EMAIL",
              messageClass: "TRANSACTIONAL",
              subject: subject.text,
              body: body.text,
              toEmail: c.email,
              sentByUserId: inviter.id,
              formInviteId: invite.id,
              scheduledFor: at,
              status: outcome.status,
              attempts: 1,
              sentAt: outcome.status === "FAILED" ? null : sentAt,
              providerId: m365,
              providerMessageId: outcome.status === "FAILED" ? null : providerMessageId("EMAIL", true),
              error: outcome.error,
              createdAt: at,
            },
            outcome.events,
          );
          out.inviteMessages += 1;
          await aftermath(w, c, outcome, "m365");
          if (outcome.bounced || outcome.status === "FAILED") {
            bounced = true;
            break;
          }
        }
        if (bounced) continue;

        // Withdrawn, opened, answered — derived on the screen from these facts, never stored.
        if (chance(0.07)) {
          await db.formInvite.update({ where: { id: invite.id }, data: { revokedAt: past(w, plus(sendAt, int(1, 4) * DAY)) } });
          continue;
        }
        const viaPhone = event && chance(0.08);
        const opened = viaPhone ? null : chance(0.72) ? past(w, plus(sendAt, int(10, 2880) * 60000)) : null;
        if (opened) await db.formInvite.update({ where: { id: invite.id }, data: { openedAt: opened } });
        if (!viaPhone && (!opened || !chance(0.78))) continue;

        const answeredAt = viaPhone ? past(w, plus(sendAt, int(1, 5) * DAY)) : past(w, plus(opened!, int(2, 600) * 60000));
        if (eventStartsAt && answeredAt >= eventStartsAt) continue;
        if (closesAt && answeredAt >= closesAt) continue;
        let attending: boolean | null = event ? chance(0.78) : null;
        if (attending && plan.capacity && coming >= plan.capacity) attending = false;
        const answers = viaPhone ? { name: c.name, email: c.email!.toLowerCase(), companyName: company.name } : answersFor(fields, c, company, attending);

        // An assessment makes a lead the first time it is answered — `submitInvited`.
        let leadId: string | null = null;
        if (plan.createsLead && attending !== false) {
          const lead = await db.lead.create({
            data: {
              companyId: company.id,
              contactId: c.id,
              title: `${form.name} — ${company.name}`,
              description: summariseAnswers(fields, answers) || null,
              status: "NEW",
              stageId: entry?.id ?? null,
              stageChangedAt: entry ? answeredAt : null,
              ownerUserId: company.ownerUserId ?? inviter.id,
              sourcedByUserId: inviter.id,
              source: "WEBSITE",
              sourceDetail: `Form: ${form.name} (invited)`,
              createdAt: answeredAt,
              updatedAt: answeredAt,
            },
            select: { id: true },
          });
          leadId = lead.id;
          out.leads += 1;
        }

        const attended = eventOver && attending ? register() : null;
        await db.formSubmission.create({
          data: {
            formId: form.id,
            inviteId: invite.id,
            payload: answers,
            name: answers.name!,
            email: c.email!.toLowerCase(),
            phone: answers.phone || null,
            companyName: company.name,
            companyId: company.id,
            contactId: c.id,
            leadId,
            sourceHash: createHash("sha256").update(`${c.email!.toLowerCase()}:${form.id}`).digest("hex").slice(0, 32),
            attending,
            attendance: attended,
            attendanceMarkedAt: attended ? plus(eventStartsAt!, int(20, 90) * 60000) : null,
            attendanceMarkedById: attended ? owner.id : null,
            // An RSVP somebody here took on the phone.
            recordedById: viaPhone ? inviter.id : null,
            createdAt: answeredAt,
            updatedAt: answeredAt,
          },
        });
        out.submissions += 1;
        if (attending) coming += 1;
        if (attended === "ATTENDED") out.attended += 1;
        if (attended === "NO_SHOW") out.noShow += 1;
      }
    }

    // ── Answers through the public link, from people we already know ─────────────────────────
    if (plan.linkAnswers > 0 && (plan.fillMode === "LINK" || plan.fillMode === "BOTH")) {
      const opensAt = plus(createdAt, DAY);
      const pool = w.customers.flatMap((co) => contactsOf(w, co.id)).filter((c) => c.email && !invited.has(c.id) && c.createdAt < opensAt);
      const used = new Set<string>();
      for (const c of some(pool, Math.min(plan.linkAnswers, pool.length))) {
        if (used.has(c.email!.toLowerCase())) continue;
        used.add(c.email!.toLowerCase());
        const company = w.companies.get(c.companyId)!;
        const answeredAt = workTime(w, between(opensAt, earlier(eventStartsAt ? plus(eventStartsAt, -27 * HOUR) : w.now, closesAt ?? w.now)));
        let attending: boolean | null = event ? chance(0.85) : null;
        if (attending && plan.capacity && coming >= plan.capacity) attending = false;
        const answers = answersFor(fields, c, company, attending);
        // Recorded as PENDING, never as consent: nobody proved they own the address they typed.
        const key = consentKey(c.id, "EMAIL", plan.topic);
        if (!w.consents.has(key)) {
          await db.contactConsent.create({
            data: { contactId: c.id, channel: "EMAIL", topic: plan.topic, status: "PENDING", source: "FORM", evidence: `Submitted "${form.name}" (${form.slug}) — address not confirmed.`, capturedAt: answeredAt },
          });
          w.consents.set(key, { status: "PENDING", capturedAt: answeredAt, withdrawnAt: null });
        }
        const attended = eventOver && attending ? register() : null;
        await db.formSubmission.create({
          data: {
            formId: form.id,
            payload: answers,
            name: answers.name!,
            email: answers.email!,
            phone: answers.phone || null,
            companyName: company.name,
            companyId: company.id,
            contactId: c.id,
            sourceHash: createHash("sha256").update(`${answers.email}:${form.id}`).digest("hex").slice(0, 32),
            attending,
            attendance: attended,
            attendanceMarkedAt: attended ? plus(eventStartsAt!, int(20, 90) * 60000) : null,
            attendanceMarkedById: attended ? owner.id : null,
            createdAt: answeredAt,
            updatedAt: answeredAt,
          },
        });
        out.submissions += 1;
        if (attending) coming += 1;
        if (attended === "ATTENDED") out.attended += 1;
        if (attended === "NO_SHOW") out.noShow += 1;
      }
    }
  }
  return out;
}

// ─── 11. The customer portal ───────────────────────────────────────────────────────────────────

const QUESTIONS = [
  "Can we move the Adobe licences to the new design lead? Same seat count.",
  "Our GST number changed after the merger — please update it before the next invoice.",
  "Which of our laptops are still under warranty?",
  "Can the renewal be split across two POs, one per branch?",
  "We need a copy of last quarter's invoices for the auditors.",
];
const RESPONSES: Record<PortalRequestStatus, string[]> = {
  NEW: [],
  IN_PROGRESS: ["Quote being prepared — expect it by Friday.", "Checking stock with the distributor."],
  DONE: ["Renewal raised as a new order; the quote is in your inbox.", "Seats added from the first of the month.", "Invoices sent to the address on file.", "Updated — the next invoice carries the new GSTIN."],
  DECLINED: ["The subscription runs to the end of its term; seats can only go down at renewal.", "This sits with your reseller — they will contact you."],
};

async function seedPortal(w: World): Promise<{ companies: number; logins: number; revoked: number; requests: number }> {
  const db = w.db;
  const out = { companies: 0, logins: 0, revoked: 0, requests: 0 };
  if ((await db.portalLogin.count({ where: { company: { tags: { has: DEMO_TAG } } } })) > 0) return out;

  // Customers, and a reseller of our own: the two kinds of company `companyMayUsePortal` allows.
  // A reseller's end customer never gets one — that relationship is the reseller's.
  const eligible = w.marketable.filter((c) => (c.relationshipType === "CLIENT" && c.stage === "CUSTOMER") || c.relationshipType === "RESELLER");
  const chosen = [
    ...some(eligible.filter((c) => c.relationshipType === "CLIENT" && contactsOf(w, c.id).some((x) => x.email)), 11),
    ...some(eligible.filter((c) => c.relationshipType === "RESELLER" && contactsOf(w, c.id).some((x) => x.email)), 1),
  ];
  const subscriptions = await db.companyProduct.findMany({
    where: { companyId: { in: chosen.map((c) => c.id) }, parentId: null, item: { type: "SUBSCRIPTION" }, orderStatus: { notIn: ["CANCELLED", "REJECTED"] } },
    select: { id: true, companyId: true, quantity: true, endDate: true },
  });
  const statuses: PortalRequestStatus[] = ["NEW", "NEW", "NEW", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "DONE", "DONE", "DONE", "DONE", "DECLINED", "DECLINED"];

  for (const company of chosen) {
    // Granted on the company's own record: the global setting defaults to selected companies only.
    await db.company.update({ where: { id: company.id }, data: { portalEnabled: true } });
    out.companies += 1;
    const people = contactsOf(w, company.id).filter((c) => c.email);
    const issuer = company.ownerUserId ?? w.ctx.admin.id;
    for (const c of some(people, Math.min(people.length, int(1, 3)))) {
      const createdAt = workTime(w, later(daysAgo(int(15, 220)), plus(c.createdAt, DAY)));
      const used = chance(0.75);
      const lastSeenAt = used ? past(w, between(plus(createdAt, HOUR), w.now)) : null;
      const revokedAt = chance(0.18) ? past(w, between(plus(createdAt, 3 * DAY), w.now)) : null;
      const login = await db.portalLogin.create({
        data: {
          // A bearer link, not a password: 192 bits, revocable, scoped to this one company. Nothing
          // opens while the portal's master switch is off.
          token: randomBytes(24).toString("base64url"),
          companyId: company.id,
          contactId: c.id,
          personName: c.name,
          personEmail: c.email,
          createdById: issuer,
          createdAt,
          expiresAt: null,
          lastSeenAt: lastSeenAt && revokedAt ? earlier(lastSeenAt, revokedAt) : lastSeenAt,
          visits: used ? int(1, 28) : 0,
          revokedAt,
          revokedById: revokedAt ? issuer : null,
        },
        select: { id: true },
      });
      out.logins += 1;
      if (revokedAt) out.revoked += 1;
      if (!used) continue;

      const mine = subscriptions.filter((s) => s.companyId === company.id);
      for (let i = 0; i < int(1, 2); i++) {
        const kind: PortalRequestKind = mine.length ? pick(["RENEWAL", "ADD_SEATS", "QUESTION"] as const) : "QUESTION";
        const subscription = kind === "QUESTION" ? null : pick(mine);
        const status = statuses[out.requests % statuses.length]!;
        const until = revokedAt ?? w.now;
        const createdAtRequest = past(w, between(plus(createdAt, HOUR), plus(until, -HOUR)));
        const closing = status === "DONE" || status === "DECLINED";
        const quantity = kind === "ADD_SEATS" ? (chance(0.85) ? int(2, 25) : -int(1, 5)) : null;
        await db.portalRequest.create({
          data: {
            companyId: company.id,
            loginId: login.id,
            personName: c.name,
            personEmail: c.email,
            kind,
            companyProductId: subscription?.id ?? null,
            quantity,
            message:
              kind === "QUESTION"
                ? pick(QUESTIONS)
                : kind === "RENEWAL"
                  ? chance(0.6) ? "Please renew on the same terms — the PO will follow." : null
                  : chance(0.5) ? `${quantity && quantity > 0 ? "New joiners" : "Two people left"} — please adjust from next month.` : null,
            status,
            createdAt: createdAtRequest,
            handledById: closing ? (company.assignedToUserId ?? company.ownerUserId ?? w.ctx.admin.id) : null,
            handledAt: closing ? past(w, plus(createdAtRequest, int(2, 72) * HOUR)) : null,
            response: RESPONSES[status].length && (closing || chance(0.6)) ? pick(RESPONSES[status]) : null,
          },
        });
        out.requests += 1;
      }
    }
  }
  return out;
}

// ─── 12. Projects in every state ────────────────────────────────────────────────────────────────

type ProjectPlan = {
  name: string;
  type: string;
  /** The plan, when the project's kind has no template of its own. */
  steps?: [name: string, dayOffset: number][];
  status: ProjectStatus;
  /** Days from now the work started — negative for a start still to come. */
  startedAgo: number;
  lengthDays: number;
  value: number;
  /** How many of the plan's milestones are done. */
  doneMilestones: (total: number) => number;
  billing: [label: string, percent: number, status: ProjectBillingStatus, dueDay: number][];
  updates: [body: string, health: ProjectHealth][];
  risks: [kind: ProjectRiskKind, title: string, severity: ProjectRiskSeverity, status: ProjectRiskStatus, mitigation: string | null][];
  documents: [ProjectDocumentType, string, string | null][];
  prospect?: boolean;
};

const PROJECTS: ProjectPlan[] = [
  {
    name: "Microsoft 365 tenant consolidation",
    type: "Mail migration",
    status: "PROPOSED",
    startedAgo: -21,
    lengthDays: 60,
    value: 640000,
    doneMilestones: () => 0,
    billing: [["Advance on PO", 30, "PENDING", 0], ["On cutover", 50, "PENDING", 28], ["After hypercare", 20, "PENDING", 40]],
    updates: [["Scope and price sent with the proposal. Waiting on their board's sign-off at month end.", "ON_TRACK"]],
    risks: [["RISK", "Two tenants have conflicting domain ownership", "MEDIUM", "OPEN", null]],
    documents: [["PROPOSAL", "Proposal — tenant consolidation", "Version 2, after the scoping call."], ["NDA", "Mutual NDA", null]],
    prospect: true,
  },
  {
    name: "Firewall refresh — head office and two branches",
    type: "Firewall implementation",
    status: "DISCOVERY",
    startedAgo: 12,
    lengthDays: 45,
    value: 380000,
    doneMilestones: () => 1,
    billing: [["Advance", 30, "DUE", 3], ["On installation", 50, "PENDING", 14], ["On handover", 20, "PENDING", 30]],
    updates: [
      ["Site survey done at head office. Branch links are on consumer broadband — that changes the design.", "ON_TRACK"],
      ["Waiting on the ISP for static IPs at both branches.", "AT_RISK"],
    ],
    risks: [
      ["RISK", "Branch ISPs slow to issue static IPs", "MEDIUM", "MITIGATING", "Escalated through their IT head; temporary DDNS as a fallback."],
      ["ISSUE", "Old firewall's config export is partial", "LOW", "ACCEPTED", "Rules will be rebuilt from the policy document instead — agreed with the customer."],
    ],
    documents: [["PROPOSAL", "Accepted proposal", null], ["SOW", "Statement of work", null], ["OTHER", "Site photos — server room and racks", "Taken on the survey visit."]],
  },
  {
    name: "Intune and Autopilot rollout",
    type: "Device management",
    steps: [["Kick-off", 0], ["Pilot group enrolled", 10], ["Driver packs validated", 20], ["Wave 1 rollout", 30], ["Wave 2 rollout", 40], ["Sign-off", 50]],
    status: "IN_PROGRESS",
    startedAgo: 48,
    lengthDays: 50,
    value: 450000,
    doneMilestones: (n) => Math.max(1, Math.floor(n / 2) - 1),
    billing: [["Advance", 30, "DUE", 0], ["Pilot complete", 30, "PENDING", 25], ["Rollout complete", 40, "PENDING", 50]],
    updates: [
      ["Pilot group of 20 enrolled. Two models need a driver pack we don't have yet.", "AT_RISK"],
      ["Vendor confirmed the driver pack is three weeks out. Rollout blocked for 140 laptops.", "OFF_TRACK"],
      ["Agreed a manual imaging workaround for the two models; still a fortnight behind.", "OFF_TRACK"],
    ],
    risks: [
      ["ISSUE", "Driver pack missing for two laptop models", "HIGH", "OPEN", null],
      ["RISK", "Customer's change freeze in the last week of the quarter", "MEDIUM", "ACCEPTED", "Rollout pauses for that week; the customer accepts the slip."],
    ],
    documents: [["PROPOSAL", "Proposal — device management", null], ["DESIGN", "Intune policy design", null], ["OTHER", "Device inventory export", "From their asset sheet."]],
  },
  {
    name: "Customer portal website",
    type: "Website development",
    status: "GO_LIVE",
    startedAgo: 96,
    lengthDays: 80,
    value: 520000,
    doneMilestones: (n) => n - 1,
    billing: [["On design sign-off", 30, "DUE", 20], ["On UAT", 40, "DUE", 60], ["On go-live", 30, "PENDING", 70], ["Content migration", 0, "WAIVED", 70]],
    updates: [
      ["Design signed off. Build under way.", "ON_TRACK"],
      ["UAT found the enquiry form posting twice on slow connections. Fixed.", "AT_RISK"],
      ["DNS cut over on Saturday night. Watching error rates for a week.", "AT_RISK"],
    ],
    risks: [["ISSUE", "Enquiry form double-posting on slow connections", "MEDIUM", "CLOSED", "Fixed in build 1.4 and re-tested in UAT."]],
    documents: [["PROPOSAL", "Proposal — portal website", null], ["AGREEMENT", "Master services agreement (signed)", null], ["SIGN_OFF", "UAT sign-off", null]],
  },
  {
    name: "Backup and DR refresh",
    type: "Server & backup refresh",
    status: "HANDOVER",
    startedAgo: 75,
    lengthDays: 45,
    value: 910000,
    doneMilestones: (n) => n - 1,
    billing: [["On hardware delivery", 60, "DUE", 10], ["On cutover", 30, "DUE", 35], ["Hypercare extension", 10, "WAIVED", 45]],
    updates: [
      ["Cutover weekend overran by six hours — the old NAS took longer to drain than measured.", "OFF_TRACK"],
      ["All restores tested. Handover pack with the customer for sign-off.", "ON_TRACK"],
    ],
    risks: [
      ["RISK", "Legacy accounting app still on Server 2012", "HIGH", "ACCEPTED", "Kept on the old host until their ERP move; the customer accepts the exposure in writing."],
      ["ISSUE", "Cutover overran the change window", "MEDIUM", "CLOSED", "Root cause written up in the handover report."],
    ],
    documents: [["PROPOSAL", "Proposal — backup and DR", null], ["HANDOVER", "Handover pack", null], ["REPORT", "Restore test report", null]],
  },
  {
    name: "VAPT and ISO 27001 readiness audit",
    type: "Security audit",
    status: "CANCELLED",
    startedAgo: 165,
    lengthDays: 40,
    value: 300000,
    doneMilestones: () => 1,
    billing: [["Advance", 40, "WAIVED", 0], ["On draft report", 40, "WAIVED", 20], ["On remediation review", 20, "WAIVED", 35]],
    updates: [
      ["Scoping done; the testing window keeps moving on their side.", "AT_RISK"],
      ["Customer has paused the audit — their certification plan moved to next year.", "OFF_TRACK"],
      ["Cancelled by the customer. Nothing billed; the advance was waived as goodwill.", "OFF_TRACK"],
    ],
    risks: [["RISK", "Testing window not confirmed", "MEDIUM", "CLOSED", "Closed with the project."]],
    documents: [["PROPOSAL", "Proposal — VAPT and readiness audit", null], ["NDA", "NDA — security testing", null], ["REPORT", "Scoping notes", null]],
  },
  {
    name: "Branch office mail migration",
    type: "Mail migration",
    status: "PLANNING",
    startedAgo: 6,
    lengthDays: 35,
    value: 210000,
    doneMilestones: () => 0,
    billing: [["Mobilisation", 20, "DUE", 0], ["On cutover", 60, "PENDING", 28], ["After hypercare", 20, "PENDING", 35]],
    updates: [["Kick-off held. Their vendor still holds the old domain's DNS — chasing an authorisation letter.", "AT_RISK"]],
    risks: [["ISSUE", "Old IT vendor holds the DNS", "HIGH", "MITIGATING", "Authorisation letter requested from their director."]],
    documents: [["PROPOSAL", "Proposal — branch migration", null], ["SOW", "Statement of work", null]],
  },
];

async function seedProjects(w: World): Promise<{ projects: number; stakeholders: number; milestones: number; billing: number; risks: number; documents: number; updates: number }> {
  const db = w.db;
  const out = { projects: 0, stakeholders: 0, milestones: 0, billing: 0, risks: 0, documents: 0, updates: 0 };
  const types = await db.projectType.findMany({ include: { templateMilestones: true } });
  // One of these per company; a customer may well have other projects running already.
  const taken = new Set<string>();
  const prospects = w.marketable.filter((c) => c.relationshipType === "CLIENT" && c.stage === "PROSPECT");
  const codes = new Map<string, number>();
  const nextCode = async (at: Date) => {
    const prefix = `PRJ-${at.getUTCFullYear()}-`;
    if (!codes.has(prefix)) {
      const last = await db.project.findFirst({ where: { code: { startsWith: prefix } }, orderBy: { code: "desc" }, select: { code: true } });
      codes.set(prefix, last ? Number(last.code.slice(prefix.length)) || 0 : 0);
    }
    const n = codes.get(prefix)! + 1;
    codes.set(prefix, n);
    return `${prefix}${String(n).padStart(4, "0")}`;
  };
  const scan = checkUpload({ name: "scan", fileDataUrl: SCAN, mimeType: "image/png" });
  const sizeBytes = scan.ok ? scan.sizeBytes : 68;

  for (const plan of PROJECTS) {
    if (await db.project.findFirst({ where: { name: { startsWith: `${plan.name} — ` } }, select: { id: true } })) continue;
    // Enough people at the customer to fill every role on their side.
    const candidates = (plan.prospect ? prospects : w.customers).filter((c) => !taken.has(c.id));
    const roomy = candidates.filter((c) => contactsOf(w, c.id).length >= (plan.prospect ? 1 : 4));
    const company = roomy.length
      ? pick(roomy)
      : [...(candidates.length ? candidates : w.customers)].sort((a, b) => contactsOf(w, b.id).length - contactsOf(w, a.id).length)[0]!;
    taken.add(company.id);

    const type = types.find((t) => t.name === plan.type) ?? null;
    const startDate = plan.startedAgo >= 0 ? clock.calendarDate(daysAgo(plan.startedAgo)) : clock.calendarDate(daysAhead(-plan.startedAgo));
    const targetEndDate = plus(startDate, plan.lengthDays * DAY);
    const createdAt = workTime(w, plus(startDate, -int(5, 20) * DAY));
    const manager = pick(w.cast.managers);
    const creator = company.ownerUserId ? w.ctx.people.find((p) => p.id === company.ownerUserId) ?? manager : manager;
    const lastUpdateHealth = plan.updates[plan.updates.length - 1]?.[1] ?? "ON_TRACK";

    const project = await db.project.create({
      data: {
        code: await nextCode(createdAt),
        companyId: company.id,
        typeId: type?.id ?? null,
        name: `${plan.name} — ${companyShort(company.name)}`,
        description: plan.prospect ? "Scoped and quoted; not yet won." : "Scoped from the accepted proposal.",
        status: plan.status,
        // `postUpdate` moves the project's health with every update, so it is the latest one's.
        health: lastUpdateHealth,
        startDate,
        targetEndDate,
        actualEndDate: null,
        managerId: manager.id,
        value: new Prisma.Decimal(plan.value),
        createdById: creator.id,
        createdAt,
      },
      select: { id: true },
    });
    out.projects += 1;

    // ── Who is on it — every role a project has, ours and theirs ──────────────────────────────
    const users: [string, ProjectStakeholderRole, string | null][] = [[manager.id, "PROJECT_MANAGER", null]];
    if (creator.id !== manager.id) users.push([creator.id, "TEAM_MEMBER", "Account manager — raised the project."]);
    const sponsor = plan.value > 400000 ? w.cast.director : w.cast.approver;
    users.push([sponsor.id, "SPONSOR", null]);
    users.push([pick(w.cast.presales).id, "TECHNICAL_LEAD", null]);
    for (const p of some(w.cast.support, 2)) users.push([p.id, "TEAM_MEMBER", null]);
    users.push([w.cast.finance.id, "OBSERVER", "Watching the billing stages."]);
    const seenUsers = new Set<string>();
    for (const [userId, role, note] of users) {
      if (seenUsers.has(userId)) continue;
      seenUsers.add(userId);
      await db.projectStakeholder.create({ data: { projectId: project.id, userId, role, note, addedById: manager.id, createdAt: plus(createdAt, int(1, 72) * HOUR) } });
      out.stakeholders += 1;
    }
    const theirs = contactsOf(w, company.id);
    const bySeniority = [...theirs].sort((a, b) => Number(["DIRECTOR", "CEO", "CIO"].includes(b.designation)) - Number(["DIRECTOR", "CEO", "CIO"].includes(a.designation)));
    const contactRoles: [ProjectStakeholderRole, string | null][] = [
      ["CUSTOMER_SPONSOR", null],
      ["CUSTOMER_TECHNICAL", null],
      ["CUSTOMER_USER", "Pilot user — reports what breaks."],
      ["VENDOR", "Their incumbent AMC partner's engineer."],
    ];
    const used = new Set<string>();
    for (const [role, note] of contactRoles) {
      const c =
        role === "CUSTOMER_TECHNICAL"
          ? theirs.find((x) => !used.has(x.id) && ["IT_HEAD", "IT_MANAGER"].includes(x.designation)) ?? theirs.find((x) => !used.has(x.id))
          : role === "CUSTOMER_SPONSOR"
            ? bySeniority.find((x) => !used.has(x.id))
            : theirs.find((x) => !used.has(x.id));
      if (!c) break;
      used.add(c.id);
      await db.projectStakeholder.create({ data: { projectId: project.id, contactId: c.id, role, note, addedById: manager.id, createdAt: plus(createdAt, int(1, 96) * HOUR) } });
      out.stakeholders += 1;
    }

    // ── The plan, from the type's template ───────────────────────────────────────────────────
    const template = type?.templateMilestones ?? (plan.steps ?? []).map(([name, dayOffset], sortOrder) => ({ name, note: null, dayOffset, sortOrder }));
    const planned = milestonesFromTemplate(template, startDate);
    const done = Math.min(planned.length, plan.doneMilestones(planned.length));
    const team = [...seenUsers];
    const milestoneIds: { id: string; name: string }[] = [];
    for (const [i, m] of planned.entries()) {
      const complete = i < done;
      const completedAt = complete && m.dueDate ? past(w, plus(m.dueDate, int(-1, 3) * DAY)) : null;
      const row = await db.projectMilestone.create({
        data: { projectId: project.id, name: m.name, note: m.note, dueDate: m.dueDate, sortOrder: m.sortOrder, completedAt, completedById: completedAt ? pick(team) : null },
        select: { id: true, name: true },
      });
      milestoneIds.push(row);
      out.milestones += 1;
    }

    // ── What gets billed when. Invoiced and paid follow a document; none is raised here. ────────
    for (const [i, [label, percent, status, dueDay]] of plan.billing.entries()) {
      const amount = percent > 0 ? Math.round((plan.value * percent) / 100) : Math.round(plan.value * 0.05);
      const earnedOn = milestoneIds.find((m) => {
        const n = m.name.toLowerCase();
        return (/uat/i.test(label) && n.includes("uat")) || (/go-live|go live/i.test(label) && n.includes("go live")) || (/cutover/i.test(label) && n.includes("cutover")) || (/handover/i.test(label) && n.includes("handover"));
      });
      await db.projectBillingMilestone.create({
        data: {
          projectId: project.id,
          label,
          percent: percent > 0 ? new Prisma.Decimal(percent) : null,
          amount: new Prisma.Decimal(amount),
          dueOn: plus(startDate, dueDay * DAY),
          status,
          deliveryMilestoneId: earnedOn?.id ?? null,
          sortOrder: i,
        },
      });
      out.billing += 1;
    }

    // From when there was work to talk about: the start, or the day it was raised if that is still ahead.
    const activeFrom = startDate.getTime() <= w.now.getTime() ? later(startDate, createdAt) : createdAt;
    // ── Risks, documents and the written history ──────────────────────────────────────────────
    for (const [kind, title, severity, status, mitigation] of plan.risks) {
      const raisedOn = workTime(w, between(activeFrom, w.now));
      // `saveRisk` dates a resolution only when the risk is resolved or closed; accepted is a decision, not an end.
      const resolvedOn = status === "RESOLVED" || status === "CLOSED" ? past(w, between(plus(raisedOn, DAY), w.now)) : null;
      await db.projectRisk.create({
        data: { projectId: project.id, kind, title, severity, status, mitigation, ownerId: manager.id, raisedById: pick(team), raisedOn, resolvedOn },
      });
      out.risks += 1;
    }
    for (const [docType, name, note] of plan.documents) {
      await db.projectDocument.create({
        data: {
          projectId: project.id,
          type: docType,
          name: `${name} — ${companyShort(company.name)}`,
          note,
          fileDataUrl: SCAN,
          mimeType: "image/png",
          sizeBytes,
          uploadedById: docType === "PROPOSAL" ? creator.id : manager.id,
          createdAt: docType === "PROPOSAL" ? createdAt : workTime(w, between(activeFrom, w.now)),
        },
      });
      out.documents += 1;
    }
    const first = later(createdAt, plan.startedAgo >= 0 ? startDate : createdAt);
    const span = Math.max(DAY, w.now.getTime() - first.getTime());
    for (const [i, [body, health]] of plan.updates.entries()) {
      const at = past(w, plus(first, Math.floor((span * (i + 1)) / (plan.updates.length + 1))));
      await db.projectUpdate.create({ data: { projectId: project.id, body, health, authorId: manager.id, at } });
      out.updates += 1;
    }
  }
  return out;
}

// ─── The whole area ─────────────────────────────────────────────────────────────────────────────

export default async function seedReach(db: PrismaClient, ctx: DemoContext): Promise<void> {
  const w = await loadWorld(db, ctx);

  const checked = await checkAddresses(w);
  log("Address checks", `${checked} addresses checked before the first campaign`);

  const suppressed = await seedSuppressions(w);
  log("Suppressions", `${suppressed} by contact and by company`);

  const channelConsents = await seedChannelConsents(w);
  log("Consent by channel", `${channelConsents.whatsapp} WhatsApp, ${channelConsents.task} call, ${channelConsents.notification} notification`);

  const feedback = await seedFeedback(w);
  log("Feedback requests", `${feedback.answered} answered, ${feedback.cancelled} withdrawn`);

  const { rows: templates, made: madeTemplates } = await seedTemplates(w);
  const { ids: audiences, made: madeAudiences } = await seedAudiences(w);
  const { rows: lists, made: madeLists, consents: listConsents } = await seedLists(w);
  log("Marketing set-up", `${madeTemplates} templates, ${madeAudiences} audiences, ${madeLists} lists (${listConsents} consents from the uploads)`);

  const campaigns = await seedCampaigns(w, templates, audiences, lists);
  log("Campaigns", `${campaigns.campaigns} campaigns, ${campaigns.messages} messages, ${campaigns.events} events, ${campaigns.linkConsents} opt-ins by link`);

  const journeys = await seedJourneys(w, templates);
  log("Journeys", `${journeys.journeys} drafted, paused or retired; ${journeys.enrolments} enrolments, ${journeys.messages} messages, ${journeys.tasks} tasks`);

  const notices = await seedNotices(w);
  log("Customer notices", `${notices.renewal} renewal reminders, ${notices.fulfilment} fulfilment notices`);

  const forms = await seedForms(w);
  log(
    "Forms",
    `${forms.forms} forms, ${forms.invites} invitations (${forms.inviteMessages} sent), ${forms.submissions} answers, ${forms.attended} attended, ${forms.noShow} no-shows, ${forms.leads} leads, ${forms.grants} shares`,
  );

  const portal = await seedPortal(w);
  log("Customer portal", `${portal.companies} companies granted, ${portal.logins} links (${portal.revoked} revoked), ${portal.requests} requests`);

  const projects = await seedProjects(w);
  log(
    "Projects",
    `${projects.projects} projects, ${projects.stakeholders} stakeholders, ${projects.milestones} milestones, ${projects.billing} billing stages, ${projects.risks} risks, ${projects.documents} documents, ${projects.updates} updates`,
  );
}
