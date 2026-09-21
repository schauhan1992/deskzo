import { randomBytes } from "node:crypto";
import type { MessageChannel, MessageClass, MarketingTopic, Prisma } from "@prisma/client";
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
import { postalAddressFor } from "@/lib/marketing/footer";
import { providerByKey, routeFor, type RoutableProvider } from "@/lib/marketing/providers";
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
  companyFilters: unknown;
  contactFilters: unknown;
  channel: MessageChannel;
  topic: MarketingTopic;
  messageClass: MessageClass;
  settings: MarketingSettings;
}): Promise<ResolvedRecipient[]> {
  const companyFilters = parseCompanyFilters(params.companyFilters);
  const contactFilters = parseContactFilters(params.contactFilters);

  const contacts = await db.contact.findMany({
    where: {
      company: audienceCompanyWhere(companyFilters),
      ...contactWhere(contactFilters, params.channel, db.contact.fields.email),
    },
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

  const capped = capPerCompany(contacts, contactFilters.maxPerCompany);
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
    companyFilters: campaign.audience.companyFilters,
    contactFilters: campaign.audience.contactFilters,
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

    const values = mergeValuesFor(recipient, settings, {
      unsubscribeUrl: `${origin}/preferences/${token}`,
    });
    const subject = render(campaign.template.subject ?? "", values);
    const body = render(campaign.template.body, values);

    // A message that cannot be filled in is not sent half-finished. "Hi ," is unrecoverable.
    if (!subject.ok || !body.ok) {
      const missing = [...(subject.ok ? [] : subject.missing), ...(body.ok ? [] : body.missing)];
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

    await db.marketingMessage
      .create({ data: { ...base, subject: subject.text, body: body.text, status: "QUEUED" } })
      .catch(() => undefined);
    queued += 1;
  }

  return { queued, suppressed, blocked };
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
          listUnsubscribe: null,
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
