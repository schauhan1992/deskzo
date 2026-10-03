import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { canSend, type RecipientState } from "@/lib/marketing/suppression";
import { render } from "@/lib/marketing/merge";
import { renewalGroup } from "@/lib/subscriptions/proration";
import { getTicketSlaStatus } from "@/lib/tickets";
import { daysOverdue } from "@/lib/receivables";
import {
  marketingSettings,
  mergeValuesFor,
  newToken,
  sendQueued,
  subscriptionMergeValues,
} from "@/lib/marketing/pipeline";
import {
  NOTICES,
  NOTICE_MESSAGE_CLASS,
  canAnnounceFulfilment,
  daysLeftPhrase,
  type NoticeKind,
} from "@/lib/marketing/customer-notices";
import { formatCurrency } from "@/lib/utils";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatOrderId } from "@/lib/order-id";
import type { ActionResult } from "@/actions/company";

/**
 * Telling a customer something about an order they already have, by hand.
 *
 * Server-only rather than a `"use server"` module, for the usual two reasons: every export in one
 * of those is a client-callable endpoint, and the session check belongs in the action that wraps
 * this rather than buried in the middle of it. It also means a script can exercise the real code.
 *
 * Two things this gets right that are easy to get wrong:
 *
 *   · **On a reseller's order the notice goes to the reseller.** The renewals list shows the end
 *     customer's name because the seats are theirs, but the relationship — and the renewal —
 *     belongs to the reseller. Mailing the end customer would go round our own partner, and they
 *     are hard do-not-contact anyway.
 *   · It is **transactional**. A notice that a service you pay for is about to lapse is not an
 *     offer, so an unsubscribe from marketing does not silence it — while a bounce, a complaint or
 *     a reseller-managed company still does.
 */
/** The subscription, its co-terminating addons, and everything the merge fields need. */
async function loadSubscription(companyProductId: string) {
  const product = await db.companyProduct.findUnique({
    where: { id: companyProductId },
    include: {
      item: { select: { name: true } },
      company: {
        select: {
          id: true,
          name: true,
          managedByResellerId: true,
          owner: { select: { name: true, email: true } },
        },
      },
      endCustomer: { select: { id: true, name: true } },
      addons: {
        where: { orderStatus: { not: "CANCELLED" } },
        select: { id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true },
      },
    },
  });
  if (!product) return null;

  const group = renewalGroup([
    {
      id: product.id,
      quantity: product.quantity,
      unitPrice: product.unitPrice ? Number(product.unitPrice) : null,
      fullTermUnitPrice: product.fullTermUnitPrice ? Number(product.fullTermUnitPrice) : null,
      startDate: product.startDate,
      isAddon: false,
    },
    ...product.addons.map((a) => ({
      id: a.id,
      quantity: a.quantity,
      unitPrice: a.unitPrice ? Number(a.unitPrice) : null,
      fullTermUnitPrice: a.fullTermUnitPrice ? Number(a.fullTermUnitPrice) : null,
      startDate: a.startDate,
      isAddon: true,
    })),
  ]);

  return { product, group };
}

/**
 * Who we could send this to, and what would happen to each of them.
 *
 * The verdict is worked out *before* anybody presses send, so the dialog can show "this one will
 * bounce" rather than reporting it afterwards.
 */
export async function resolveNoticeRecipients(companyProductId: string, kind: NoticeKind = "RENEWAL") {
  const notice = NOTICES[kind];
  const loaded = await loadSubscription(companyProductId);
  if (!loaded) return null;
  const { product, group } = loaded;

  // Whoever we bill is whoever we write to. On a reseller's order that is the reseller, even though
  // the list shows the end customer's name.
  const recipientCompanyId = product.companyId;
  const [contacts, settings, templates] = await Promise.all([
    db.contact.findMany({
      where: { companyId: recipientCompanyId },
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        designation: true,
        isPrimary: true,
        emailStatus: true,
        emailCheckedValue: true,
      },
    }),
    marketingSettings(),
    db.marketingTemplate.findMany({
      where: { active: true, channel: "EMAIL", topic: notice.topic },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const addresses = contacts.map((c) => c.email?.trim().toLowerCase()).filter((e): e is string => !!e);
  const domains = [...new Set(addresses.map((a) => a.split("@")[1]).filter(Boolean))];
  const now = new Date();

  const [suppressions, feedback, invoices, tickets, clock] = await Promise.all([
    db.suppression.findMany({
      where: {
        OR: [
          { scope: "EMAIL", value: { in: addresses } },
          { scope: "CONTACT", value: { in: contacts.map((c) => c.id) } },
          { scope: "COMPANY", value: recipientCompanyId },
          { scope: "DOMAIN", value: { in: domains } },
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
      select: { scope: true, value: true, reason: true },
    }),
    db.feedbackRequest.count({
      where: { companyId: recipientCompanyId, response: { rating: { lte: 3 }, acknowledgedAt: null } },
    }),
    db.tradeDocument.findMany({
      where: {
        companyId: recipientCompanyId,
        docType: "INVOICE",
        status: { in: ["ISSUED", "PARTIALLY_PAID", "ACCEPTED"] },
        dueDate: { lt: now },
      },
      select: { dueDate: true, issueDate: true },
    }),
    db.ticket.findMany({
      where: { companyId: recipientCompanyId, status: { notIn: ["RESOLVED", "CLOSED"] } },
      select: { priority: true, status: true, createdAt: true },
    }),
    workspaceClock(),
  ]);

  const overdue = invoices.reduce((worst, i) => Math.max(worst, daysOverdue(i.dueDate, i.issueDate, now)), 0);
  const breached = tickets.filter((t) => getTicketSlaStatus(t.priority, t.status, t.createdAt, clock, now).key === "overdue").length;

  const rows = contacts.map((contact) => {
    const address = contact.email?.trim().toLowerCase() ?? null;
    const domain = address?.split("@")[1] ?? null;
    const state: RecipientState = {
      company: { managedByResellerId: product.company.managedByResellerId },
      contact: {
        email: contact.email,
        phone: contact.phone,
        emailStatus: contact.emailStatus,
        emailCheckedValue: contact.emailCheckedValue,
      },
      suppressions: suppressions
        .filter(
          (s) =>
            (s.scope === "EMAIL" && address !== null && s.value === address) ||
            (s.scope === "CONTACT" && s.value === contact.id) ||
            (s.scope === "COMPANY" && s.value === recipientCompanyId) ||
            (s.scope === "DOMAIN" && domain !== null && s.value === domain),
        )
        .map((s) => ({ reason: s.reason })),
      // Consent is not consulted for a transactional notice, but the shape wants a value.
      consent: null,
      signals: {
        unansweredFeedback: feedback,
        daysOverdue: overdue > 0 ? overdue : null,
        breachedTickets: breached,
        sentInLastWeek: 0,
      },
    };

    const verdict = canSend(state, {
      messageClass: NOTICE_MESSAGE_CLASS,
      channel: "EMAIL",
      topic: notice.topic,
      limits: settings.limits,
    });

    return {
      ...contact,
      canReceive: verdict.ok,
      blockedBecause: verdict.ok ? null : verdict.detail,
    };
  });

  return toPlain({
    kind,
    title: notice.title,
    buttonLabel: notice.buttonLabel,
    footnote: notice.footnote,
    orderStatus: product.orderStatus,
    /** A "your order is ready" that goes out before it is is unrecoverable. */
    canAnnounce: kind === "FULFILMENT" ? canAnnounceFulfilment(product.orderStatus) : true,
    subscription: {
      id: product.id,
      orderSeq: product.orderSeq,
      poNumber: product.poNumber,
      fulfilledAt: product.fulfilledAt,
      itemName: product.item.name,
      endDate: product.endDate,
      quantity: group.totalQuantity,
      renewalValue: group.renewalValue,
      addonCount: group.addonCount,
    },
    /** Who the mail actually goes to — the reseller on a reseller's order. */
    recipientCompany: { id: product.company.id, name: product.company.name },
    /** Whose seats they are, when that differs. Shown so nobody thinks the list is wrong. */
    endCustomer: product.endCustomer,
    viaReseller: product.endCustomerId !== null,
    contacts: rows,
    templates,
  });
}

export async function queueCustomerNotice(input: {
  companyProductId: string;
  contactIds: string[];
  kind?: NoticeKind;
  /** Absolute, for the unsubscribe link. Passed in because a lib has no request to read. */
  origin: string;
  templateId?: string;
  /** A line from whoever is sending it, put above the standard wording. */
  note?: string;
  /** Who pressed send — kept on each message for the mail log. */
  sentByUserId?: string;
}): Promise<ActionResult<{ sent: number; failed: number; skipped: { name: string; reason: string }[]; product: { id: string; itemName: string; companyId: string; companyName: string } }>> {  if (input.contactIds.length === 0) return { ok: false, error: "Pick at least one person to send it to." };

  const loaded = await loadSubscription(input.companyProductId);
  if (!loaded) return { ok: false, error: "That subscription no longer exists." };
  const { product, group } = loaded;

  const kind = input.kind ?? "RENEWAL";
  const notice = NOTICES[kind];
  // Announcing a fulfilment before it has happened cannot be taken back, so it is refused here
  // rather than trusted to the button being hidden.
  if (kind === "FULFILMENT" && !canAnnounceFulfilment(product.orderStatus)) {
    return { ok: false, error: "That order isn't fulfilled yet, so there is nothing to announce." };
  }
  const available = await resolveNoticeRecipients(input.companyProductId, kind);
  if (!available) return { ok: false, error: "That subscription no longer exists." };

  const chosen = available.contacts.filter((c) => input.contactIds.includes(c.id));
  if (chosen.length === 0) return { ok: false, error: "Those contacts aren't at this company." };

  const [settings, template] = await Promise.all([
    marketingSettings(),
    input.templateId
      ? db.marketingTemplate.findUnique({ where: { id: input.templateId }, select: { subject: true, body: true } })
      : Promise.resolve(null),
  ]);

  const subject = template?.subject ?? notice.subject;
  const body = (input.note?.trim() ? `${input.note.trim()}\n\n` : "") + (template?.body ?? notice.body);

  const origin = input.origin;
  const clock = await workspaceClock();
  const days = product.endDate
    ? Math.ceil((new Date(product.endDate).getTime() - Date.now()) / 86400000)
    : null;

  const skipped: { name: string; reason: string }[] = [];
  let queued = 0;

  for (const contact of chosen) {
    if (!contact.canReceive) {
      skipped.push({ name: contact.name, reason: contact.blockedBecause ?? "Can't be contacted." });
      continue;
    }

    const token = newToken();
    const values = mergeValuesFor(
      {
        contactId: contact.id,
        companyId: product.company.id,
        companyName: product.company.name,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        ownerName: product.company.owner?.name ?? null,
        ownerEmail: product.company.owner?.email ?? null,
        state: {} as RecipientState,
      },
      settings,
      {
        ...subscriptionMergeValues({
          item: product.item,
          quantity: group.totalQuantity,
          endDate: product.endDate,
          fullTermUnitPrice: product.fullTermUnitPrice,
        }),
        // The group's numbers, not the parent's — "20 seats" is the renewal, not "10 and separately 10".
        quantity: group.totalQuantity,
        renewalValue: group.renewalValue > 0 ? formatCurrency(group.renewalValue) : null,
        // The end date is a typed day kept as its midnight UTC; the fulfilment, a moment on the workspace's clock.
        expiryDate: product.endDate ? formatCalendarDay(product.endDate) : null,
        daysLeft: days,
        daysLeftPhrase: daysLeftPhrase(days),
        orderId: formatOrderId(product.orderSeq),
        poNumber: product.poNumber,
        fulfilledDate: product.fulfilledAt ? clock.date(product.fulfilledAt) : null,
        unsubscribeUrl: `${origin}/preferences/${token}`,
      },
    );

    const renderedSubject = render(subject, values);
    const renderedBody = render(body, values);
    if (!renderedSubject.ok || !renderedBody.ok) {
      const missing = [
        ...(renderedSubject.ok ? [] : renderedSubject.missing),
        ...(renderedBody.ok ? [] : renderedBody.missing),
      ];
      skipped.push({ name: contact.name, reason: `The template needs ${[...new Set(missing)].join(", ")}.` });
      continue;
    }

    await db.marketingMessage.create({
      data: {
        token,
        companyId: product.company.id,
        contactId: contact.id,
        channel: "EMAIL",
        messageClass: NOTICE_MESSAGE_CLASS,
        subject: renderedSubject.text,
        body: renderedBody.text,
        toEmail: contact.email,
        // For the mail log: who sent it, about which order, and which notice it was.
        sentByUserId: input.sentByUserId ?? null,
        companyProductId: product.id,
        noticeKind: kind,
        // Manual and transactional, so it goes now rather than waiting for the next send window.
        // Quiet hours exist to stop a *campaign* landing at 2am, not to delay somebody's own notice.
        scheduledFor: new Date(),
        status: "QUEUED",
      },
    });
    queued += 1;
  }

  if (queued === 0) {
    return {
      ok: false,
      error: skipped[0]?.reason ?? "Nobody selected can be sent to.",
    };
  }

  // Sent straight away rather than left for the next tick — somebody clicked a button and expects
  // it gone. Anything else that happens to be due goes with it, which is no bad thing.
  const result = await sendQueued(`manual-${Date.now().toString(36)}`);

  return {
    ok: true,
    data: {
      sent: Math.min(result.sent, queued),
      failed: result.failed,
      skipped,
      product: {
        id: product.id,
        itemName: product.item.name,
        companyId: product.company.id,
        companyName: product.company.name,
      },
    },
  };
}
