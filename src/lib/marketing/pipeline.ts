import { randomBytes } from "node:crypto";
import type { MessageChannel, MessageClass, MarketingTopic, Prisma, TemplateFormat } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { getOrganisation } from "@/lib/organisation";
import { closedDates } from "@/lib/hr/calendar";
import { getTicketSlaStatus } from "@/lib/tickets";
import { daysOverdue } from "@/lib/receivables";
import { audienceCompanyWhere, capPerCompany, contactWhere, parseCompanyFilters, parseContactFilters } from "@/lib/marketing/audience";
import { canSend, type RecipientState, type SendContext, type SendVerdict } from "@/lib/marketing/suppression";
import { nextSendTime, type ScheduleRules } from "@/lib/marketing/schedule";
import { render, type MergeValues } from "@/lib/marketing/merge";
import { composeEmail, escapeHtml } from "@/lib/marketing/html";
import { trackedLink } from "@/lib/marketing/tracking";
import { postalAddressFor } from "@/lib/marketing/footer";
import { providerByKey, routeFor, type RoutableProvider } from "@/lib/marketing/providers";
import type { OutboundMessage } from "@/lib/marketing/providers/types";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * The machinery between "somebody pressed send" and "a provider accepted it".
 *
 * Server-only, and deliberately **not** a `"use server"` module: every export in one of those is a
 * client-callable endpoint, and these functions queue mail, decrypt provider secrets and mark
 * messages as sent. The same reasoning guards `notifyUser` and `recordAudit`.
 */

const WEEK = 7 * 86400000;

// ─── Settings ─────────────────────────────────────────────────────────────────

export type MarketingSettings = {
  rules: ScheduleRules;
  limits: SendContext["limits"];
  postalAddress: string | null;
  approvalThreshold: number;
  ourName: string;
};

export async function marketingSettings(): Promise<MarketingSettings> {
  const [org, holidays] = await Promise.all([
    getOrganisation(),
    db.holiday.findMany({ select: { date: true, optional: true } }),
  ]);

  return {
    rules: {
      quiet: { startMinute: org.marketingQuietStartMinute, endMinute: org.marketingQuietEndMinute },
      skipNonWorkingDays: org.marketingSkipNonWorkingDays,
      // Restricted holidays are excluded by `closedDates` — the office is open on those.
      holidays: closedDates(holidays),
    },
    limits: {
      maxPerContactPerWeek: org.marketingMaxPerContactPerWeek,
      overdueDaysBlock: 60,
      requireVerifiedAddress: true,
    },
    // Falls back to the registered office — the app already knows where the company is.
    postalAddress: postalAddressFor(org).text,
    approvalThreshold: org.marketingApprovalThreshold,
    ourName: org.tradeName || org.legalName || "us",
  };
}

// ─── Who would receive this ───────────────────────────────────────────────────

export type Recipient = {
  contactId: string;
  companyId: string;
  companyName: string;
  name: string;
  email: string | null;
  phone: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  state: RecipientState;
};

export type ResolvedRecipient = { recipient: Recipient; verdict: SendVerdict };

/**
 * Everybody an audience reaches, each with the verdict on whether they may actually be reached.
 *
 * Suppressed recipients are returned rather than filtered out. A dry run has to be able to say
 * *why* 112 people are not getting this, and a message row is written for each of them so the
 * question is still answerable in six months.
 *
 * Every signal is gathered in a handful of grouped queries rather than per contact — a campaign is
 * a few thousand rows, and this runs on a five-minute tick.
 */
export async function resolveRecipients(params: {
  /** An audience's filters — leave both out for a list-only send. */
  companyFilters?: unknown;
  contactFilters?: unknown;
  /** An uploaded list, on its own or on top of the audience. */
  listId?: string | null;
  channel: MessageChannel;
  topic: MarketingTopic;
  messageClass: MessageClass;
  settings: MarketingSettings;
}): Promise<ResolvedRecipient[]> {
  const companyFilters = parseCompanyFilters(params.companyFilters);
  const contactFilters = parseContactFilters(params.contactFilters);

  const fromAudience: Prisma.ContactWhereInput | null =
    params.companyFilters !== undefined
      ? { company: audienceCompanyWhere(companyFilters), ...contactWhere(contactFilters, params.channel, db.contact.fields.email) }
      : null;
  // A list is everyone on it. Whether each of them may be mailed is the verdict's job below, the
  // same as for anybody else — being uploaded earns nobody a way round the rules.
  const fromList: Prisma.ContactWhereInput | null = params.listId ? { marketingLists: { some: { listId: params.listId } } } : null;
  if (!fromAudience && !fromList) return [];

  const contacts = await db.contact.findMany({
    where: fromAudience && fromList ? { OR: [fromAudience, fromList] } : (fromAudience ?? fromList)!,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      isPrimary: true,
      emailStatus: true,
      emailCheckedValue: true,
      companyId: true,
      company: {
        select: {
          id: true,
          name: true,
          managedByResellerId: true,
          owner: { select: { name: true, email: true } },
        },
      },
    },
    take: 5000,
  });

  // The per-company cap is the audience's rule; a list was chosen person by person.
  const capped = fromList ? contacts : capPerCompany(contacts, contactFilters.maxPerCompany);
  if (capped.length === 0) return [];

  const contactIds = capped.map((c) => c.id);
  const companyIds = [...new Set(capped.map((c) => c.companyId))];
  const addresses = capped.map((c) => c.email?.trim().toLowerCase()).filter((e): e is string => !!e);
  const domains = [...new Set(addresses.map((a) => a.split("@")[1]).filter(Boolean))];
  const since = new Date(Date.now() - WEEK);
  const now = new Date();

  const [suppressions, consents, feedback, invoices, tickets, recentSends] = await Promise.all([
    db.suppression.findMany({
      where: {
        OR: [
          { scope: "EMAIL", value: { in: addresses } },
          { scope: "CONTACT", value: { in: contactIds } },
          { scope: "COMPANY", value: { in: companyIds } },
          { scope: "DOMAIN", value: { in: domains } },
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
      select: { scope: true, value: true, reason: true },
    }),
    db.contactConsent.findMany({
      where: { contactId: { in: contactIds }, channel: params.channel, topic: params.topic },
      select: { contactId: true, status: true },
    }),
    // Feedback at 3 or below that nobody has answered — the strongest "don't sell to them" signal
    // the app has, after the reseller flag.
    db.feedbackRequest.findMany({
      where: { companyId: { in: companyIds }, response: { rating: { lte: 3 }, acknowledgedAt: null } },
      select: { companyId: true },
    }),
    db.tradeDocument.findMany({
      where: {
        companyId: { in: companyIds },
        docType: "INVOICE",
        status: { in: ["ISSUED", "PARTIALLY_PAID", "ACCEPTED"] },
        dueDate: { lt: now },
      },
      select: { companyId: true, dueDate: true, issueDate: true },
    }),
    db.ticket.findMany({
      where: { companyId: { in: companyIds }, status: { notIn: ["RESOLVED", "CLOSED"] } },
      select: { companyId: true, priority: true, status: true, createdAt: true },
    }),
    db.marketingMessage.groupBy({
      by: ["contactId"],
      where: {
        contactId: { in: contactIds },
        messageClass: "MARKETING",
        sentAt: { gte: since },
        status: { notIn: ["SUPPRESSED", "FAILED"] },
      },
      _count: { _all: true },
    }),
  ]);

  const tally = <T>(rows: T[], key: (row: T) => string | null) => {
    const map = new Map<string, number>();
    for (const row of rows) {
      const k = key(row);
      if (k) map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  };

  const unanswered = tally(feedback, (f) => f.companyId);
  const breached = tally(
    tickets.filter((t) => getTicketSlaStatus(t.priority, t.status, t.createdAt, now).key === "overdue"),
    (t) => t.companyId,
  );
  const overdueBy = new Map<string, number>();
  for (const inv of invoices) {
    if (!inv.companyId) continue;
    const days = daysOverdue(inv.dueDate, inv.issueDate, now);
    overdueBy.set(inv.companyId, Math.max(overdueBy.get(inv.companyId) ?? 0, days));
  }
  const consentBy = new Map(consents.map((c) => [c.contactId, c.status]));
  const sentBy = new Map(recentSends.map((r) => [r.contactId ?? "", r._count._all]));

  const ctx: SendContext = {
    messageClass: params.messageClass,
    channel: params.channel,
    topic: params.topic,
    limits: params.settings.limits,
  };

  return capped.map((contact) => {
    const address = contact.email?.trim().toLowerCase() ?? null;
    const domain = address?.split("@")[1] ?? null;
    const mine = suppressions.filter(
      (s) =>
        (s.scope === "EMAIL" && address !== null && s.value === address) ||
        (s.scope === "CONTACT" && s.value === contact.id) ||
        (s.scope === "COMPANY" && s.value === contact.companyId) ||
        (s.scope === "DOMAIN" && domain !== null && s.value === domain),
    );

    const state: RecipientState = {
      company: { managedByResellerId: contact.company.managedByResellerId },
      contact: {
        email: contact.email,
        phone: contact.phone,
        emailStatus: contact.emailStatus,
        emailCheckedValue: contact.emailCheckedValue,
      },
      suppressions: mine.map((s) => ({ reason: s.reason })),
      consent: consentBy.has(contact.id) ? { status: consentBy.get(contact.id)! } : null,
      signals: {
        unansweredFeedback: unanswered.get(contact.companyId) ?? 0,
        daysOverdue: overdueBy.get(contact.companyId) ?? null,
        breachedTickets: breached.get(contact.companyId) ?? 0,
        sentInLastWeek: sentBy.get(contact.id) ?? 0,
      },
    };

    return {
      recipient: {
        contactId: contact.id,
        companyId: contact.companyId,
        companyName: contact.company.name,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        ownerName: contact.company.owner?.name ?? null,
        ownerEmail: contact.company.owner?.email ?? null,
        state,
      },
      verdict: canSend(state, ctx),
    };
  });
}

// ─── Merge values ─────────────────────────────────────────────────────────────

export function mergeValuesFor(
  recipient: Recipient,
  settings: MarketingSettings,
  extras: MergeValues = {},
): MergeValues {
  return {
    firstName: recipient.name.trim().split(/\s+/)[0] ?? null,
    fullName: recipient.name,
    companyName: recipient.companyName,
    ourName: settings.ourName,
    ownerName: recipient.ownerName,
    ownerEmail: recipient.ownerEmail,
    postalAddress: settings.postalAddress,
    ...extras,
  };
}

/** The renewal and cover fields, formatted the way the rest of the app formats them. */
export function subscriptionMergeValues(product: {
  item: { name: string };
  quantity: number;
  endDate: Date | null;
  fullTermUnitPrice: Prisma.Decimal | number | null;
}): MergeValues {
  const price = product.fullTermUnitPrice === null ? null : Number(product.fullTermUnitPrice);
  const days = product.endDate
    ? Math.ceil((new Date(product.endDate).getTime() - Date.now()) / 86400000)
    : null;
  return {
    productName: product.item.name,
    quantity: product.quantity,
    expiryDate: product.endDate ? formatDate(product.endDate) : null,
    daysLeft: days,
    renewalValue: price === null ? null : formatCurrency(price * product.quantity),
  };
}

// ─── Queueing ─────────────────────────────────────────────────────────────────

export function newToken() {
  return randomBytes(24).toString("base64url");
}

export type QueueOutcome = { queued: number; suppressed: number; blocked: number };

export type BuiltEmail =
  | { ok: true; subject: string; html: string; text: string; unsubscribeUrl: string }
  | { ok: false; missing: string[] };

/**
 * One recipient's email, finished: merged, composed with its footer, tracked, and with its own
 * one-click unsubscribe address. Campaigns and journeys both build theirs here, so a journey step is
 * held to exactly the same rules as a broadcast.
 */
export function buildMarketingEmail(input: {
  template: { subject: string | null; preheader: string | null; body: string; format: TemplateFormat };
  recipient: Recipient;
  settings: MarketingSettings;
  token: string;
  origin: string;
  track: boolean;
}): BuiltEmail {
  const { template, token, origin, settings } = input;
  const values = mergeValuesFor(input.recipient, settings, { unsubscribeUrl: `${origin}/preferences/${token}` });
  const subject = render(template.subject ?? "", values);
  const preheader = render(template.preheader ?? "", values);
  // An HTML template's merged values are escaped; its own markup, and a fallback it wrote, are not.
  const body = render(template.body, values, template.format === "HTML" ? { escape: escapeHtml } : undefined);
  if (!subject.ok || !preheader.ok || !body.ok) {
    return { ok: false, missing: [...new Set([subject, preheader, body].flatMap((r) => (r.ok ? [] : r.missing)))] };
  }
  const email = composeEmail({
    format: template.format,
    body: body.text,
    preheader: preheader.text,
    footer: {
      senderName: settings.ourName,
      unsubscribeUrl: String(values.unsubscribeUrl),
      postalAddress: settings.postalAddress,
      // Placed by the author already — once is enough.
      includeUnsubscribe: !body.used.includes("unsubscribeUrl"),
      includeAddress: !body.used.includes("postalAddress"),
    },
    origin,
    track: input.track ? { openPixelUrl: `${origin}/track/${token}`, link: (url) => trackedLink(origin, token, url) } : undefined,
  });
  return { ok: true, subject: subject.text, html: email.html, text: email.text, unsubscribeUrl: `${origin}/api/marketing/unsubscribe/${token}` };
}

/**
 * Turns an audience into message rows.
 *
 * Every recipient gets a row, including the ones who will never receive it — a suppressed row with
 * a reason is the only thing that can answer "why didn't they get it?" later. Both unique indexes
 * on `MarketingMessage` make this safe to run twice.
 */
export async function queueCampaign(campaignId: string, origin: string): Promise<QueueOutcome> {
  const campaign = await db.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { audience: true, template: true },
  });
  const settings = await marketingSettings();

  const resolved = await resolveRecipients({
    companyFilters: campaign.audience?.companyFilters,
    contactFilters: campaign.audience?.contactFilters,
    listId: campaign.listId,
    channel: campaign.channel,
    topic: campaign.template.topic,
    messageClass: "MARKETING",
    settings,
  });

  const sendAt = nextSendTime(campaign.scheduledFor ?? new Date(), {
    ...settings.rules,
    window:
      campaign.windowStartMinute !== null && campaign.windowEndMinute !== null
        ? { startMinute: campaign.windowStartMinute, endMinute: campaign.windowEndMinute }
        : null,
  });

  let queued = 0;
  let suppressed = 0;
  let blocked = 0;

  for (const { recipient, verdict } of resolved) {
    const token = newToken();
    const base = {
      token,
      campaignId: campaign.id,
      companyId: recipient.companyId,
      contactId: recipient.contactId,
      channel: campaign.channel,
      messageClass: "MARKETING" as const,
      toEmail: recipient.email,
      toPhone: recipient.phone,
      scheduledFor: sendAt,
    };

    if (!verdict.ok) {
      await db.marketingMessage
        .create({
          data: {
            ...base,
            subject: campaign.template.subject,
            body: "",
            status: "SUPPRESSED",
            suppressedReason: `${verdict.reason}: ${verdict.detail}`,
          },
        })
        .catch(() => undefined); // Already queued by an earlier run; the unique index did its job.
      suppressed += 1;
      continue;
    }

    const email =
      campaign.channel === "EMAIL"
        ? buildMarketingEmail({ template: campaign.template, recipient, settings, token, origin, track: true })
        : null;
    // WhatsApp carries its words as they are — no HTML, no footer, no pixel.
    const values = mergeValuesFor(recipient, settings, { unsubscribeUrl: `${origin}/preferences/${token}` });
    const plain = email ? null : { subject: render(campaign.template.subject ?? "", values), body: render(campaign.template.body, values) };

    // A message that cannot be filled in is not sent half-finished. "Hi ," is unrecoverable.
    const missing = email ? (email.ok ? [] : email.missing) : [plain!.subject, plain!.body].flatMap((r) => (r.ok ? [] : r.missing));
    if (missing.length > 0) {
      await db.marketingMessage
        .create({
          data: {
            ...base,
            subject: campaign.template.subject,
            body: "",
            status: "SUPPRESSED",
            suppressedReason: `Missing merge field(s): ${[...new Set(missing)].join(", ")}`,
          },
        })
        .catch(() => undefined);
      blocked += 1;
      continue;
    }

    const content =
      email && email.ok
        ? { subject: email.subject, body: email.html, textBody: email.text, unsubscribeUrl: email.unsubscribeUrl }
        : { subject: plain!.subject.ok ? plain!.subject.text : "", body: plain!.body.ok ? plain!.body.text : "" };
    await db.marketingMessage.create({ data: { ...base, ...content, status: "QUEUED" } }).catch(() => undefined);
    queued += 1;
  }

  return { queued, suppressed, blocked };
}

/**
 * Campaigns, moved along by what their messages have done: SCHEDULED → SENDING once the first has
 * gone, and SENT once nothing is left waiting. Without this a campaign said "Scheduled" for ever,
 * long after the last message was delivered.
 */
export async function settleCampaigns(): Promise<void> {
  const active = await db.campaign.findMany({ where: { status: { in: ["SCHEDULED", "SENDING"] } }, select: { id: true, status: true } });
  if (active.length === 0) return;
  const counts = await db.marketingMessage.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: active.map((c) => c.id) } },
    _count: { _all: true },
  });
  for (const c of active) {
    const mine = counts.filter((r) => r.campaignId === c.id);
    const waiting = mine.filter((r) => r.status === "QUEUED" || r.status === "SENDING").reduce((t, r) => t + r._count._all, 0);
    const gone = mine.filter((r) => !["QUEUED", "SENDING", "SUPPRESSED"].includes(r.status)).reduce((t, r) => t + r._count._all, 0);
    if (waiting === 0) {
      await db.campaign.update({ where: { id: c.id }, data: { status: "SENT", finishedAt: new Date() } });
    } else if (gone > 0 && c.status === "SCHEDULED") {
      await db.campaign.update({ where: { id: c.id }, data: { status: "SENDING" } });
    }
  }
}

// ─── Sending ──────────────────────────────────────────────────────────────────

async function loadProviders(): Promise<RoutableProvider[]> {
  const rows = await db.messagingProvider.findMany({
    select: { id: true, key: true, label: true, kind: true, enabled: true, priority: true, classes: true, fromEmail: true },
  });
  return rows;
}

async function providerCredentials(id: string) {
  const row = await db.messagingProvider.findUniqueOrThrow({ where: { id } });
  return {
    key: row.key,
    label: row.label,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    replyTo: row.replyTo,
    config: (row.config as Record<string, unknown>) ?? {},
    secret: row.secretCipher ? decryptSecret(row.secretCipher) : null,
  };
}

/**
 * Straight through the provider chain, now — for a test send, which has no row to queue. The same
 * routing and failover as the queue, so a test that arrives proves the real thing can.
 */
export async function deliverNow(message: OutboundMessage, messageClass: MessageClass): Promise<{ ok: true; provider: string } | { ok: false; error: string }> {
  const chain = routeFor(await loadProviders(), { kind: "EMAIL", messageClass });
  if (chain.length === 0) return { ok: false, error: "No email provider is set up for marketing mail — add one in the marketing settings." };
  let last = "No provider accepted it.";
  for (const candidate of chain) {
    const implementation = providerByKey[candidate.key];
    if (!implementation) continue;
    const result = await implementation.send(message, await providerCredentials(candidate.id));
    if (result.ok) return { ok: true, provider: candidate.label };
    last = result.error;
    if (!result.retryable) break;
  }
  return { ok: false, error: last };
}

export type TickOutcome = { claimed: number; sent: number; failed: number };

/**
 * One pass of the sender.
 *
 * The claim is a single atomic `UPDATE … RETURNING`, so two ticks that overlap — a slow run and the
 * next one starting — cannot take the same row. The ten-minute clause releases anything a crashed
 * run left locked, which is the only way a stuck message ever gets sent.
 */
export async function sendQueued(runId: string, batchSize = 100): Promise<TickOutcome> {
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE marketing_messages
       SET "lockedAt" = now(), "lockedBy" = ${runId}, status = 'SENDING', attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM marketing_messages
        WHERE status = 'QUEUED'
          AND "scheduledFor" <= now()
          AND "sentAt" IS NULL
          AND ("lockedAt" IS NULL OR "lockedAt" < now() - interval '10 minutes')
        ORDER BY "scheduledFor"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING id`;

  if (claimed.length === 0) return { claimed: 0, sent: 0, failed: 0 };

  const providers = await loadProviders();
  const credentialCache = new Map<string, Awaited<ReturnType<typeof providerCredentials>>>();
  let sent = 0;
  let failed = 0;

  for (const { id } of claimed) {
    const message = await db.marketingMessage.findUnique({
      where: { id },
      include: { contact: { select: { name: true } } },
    });
    if (!message) continue;

    const chain = routeFor(providers, {
      kind: message.channel === "WHATSAPP" ? "WHATSAPP" : "EMAIL",
      messageClass: message.messageClass,
    });
    if (chain.length === 0) {
      await db.marketingMessage.update({
        where: { id },
        data: { status: "QUEUED", lockedAt: null, lockedBy: null, error: "No provider is configured for this." },
      });
      failed += 1;
      continue;
    }

    let result: Awaited<ReturnType<(typeof providerByKey)[string]["send"]>> | null = null;
    let usedProviderId: string | null = null;

    for (const candidate of chain) {
      const implementation = providerByKey[candidate.key];
      if (!implementation) continue;
      if (!credentialCache.has(candidate.id)) {
        credentialCache.set(candidate.id, await providerCredentials(candidate.id));
      }
      usedProviderId = candidate.id;
      result = await implementation.send(
        {
          to: message.toEmail ?? message.toPhone ?? "",
          toName: message.contact?.name ?? null,
          subject: message.subject ?? "",
          html: message.body,
          text: message.textBody ?? undefined,
          // The one-click unsubscribe Gmail and Yahoo require of bulk senders. Null for a notice.
          listUnsubscribe: message.unsubscribeUrl,
        },
        credentialCache.get(candidate.id)!,
      );
      // Only a retryable failure is worth the next provider. A rejected address is rejected
      // everywhere, and trying again is how the same person gets two copies.
      if (result.ok || !result.retryable) break;
    }

    if (result?.ok) {
      await db.marketingMessage.update({
        where: { id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          providerId: usedProviderId,
          providerMessageId: result.providerMessageId,
          lockedAt: null,
          lockedBy: null,
          error: null,
        },
      });
      sent += 1;
    } else {
      const retryable = result ? result.retryable : true;
      await db.marketingMessage.update({
        where: { id },
        data: {
          // A retryable failure goes back in the queue; anything else is done with.
          status: retryable ? "QUEUED" : "FAILED",
          providerId: usedProviderId,
          lockedAt: null,
          lockedBy: null,
          error: result?.ok === false ? result.error : "No provider accepted it.",
        },
      });
      failed += 1;
    }
  }

  return { claimed: claimed.length, sent, failed };
}
