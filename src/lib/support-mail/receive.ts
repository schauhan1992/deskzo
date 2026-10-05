import type { SupportEmailState } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { automationUserId } from "@/lib/automation-user";
import { notifyUser } from "@/lib/notify";
import { PEOPLE_ONLY } from "@/lib/people";
import { ticketPath } from "@/lib/record-links";
import { formatTicketId } from "@/lib/tickets";
import { inboundDomain } from "@/lib/support-mail/config";
import type { IncomingEmail } from "@/lib/support-mail/parse";
import { FLOOD_PER_HOUR, isForwardingConfirmation, normalizeAddress, ticketSeqFromSubject, visiblePart } from "@/lib/support-mail/rules";
import { sendSupportEmail } from "@/lib/support-mail/send";

/**
 * One email that reached this workspace's helpdesk address, decided — inside the workspace
 * (`runAsTenant`, src/app/api/platform/inbound-email). In this order:
 *
 *   1. **A repeat** of one already received (the same Message-ID): nothing new, nothing stored.
 *   2. **Left out** (IGNORED, kept so it can be looked at): no sender, mail from this helpdesk itself, an
 *      automatic reply, a bounce or a newsletter (`automatedReason`), or the thirty-first email from one
 *      address in an hour. Never acknowledged — that is how mail loops start.
 *   3. **A reply** to a ticket — by its In-Reply-To or References, else the [TCK-…] tag in the subject —
 *      added to the ticket's conversation (REPLY), and a resolved or closed ticket opens again. Only from
 *      somebody already on the ticket: its contact, or an address that wrote to it or was written to. A
 *      stranger quoting a ticket number waits in the inbox instead; nobody adds to a customer's ticket by
 *      guessing its number.
 *   4. **A new ticket** (NEW_TICKET) when the sender is a contact at exactly one company: opened by the
 *      workspace's Automation account, given to the default agent when there is one, acknowledged by
 *      email when the workspace says so.
 *   5. **The Support inbox** (INBOX) otherwise — an unknown sender, one known at several companies,
 *      Gmail's forwarding confirmation — for somebody to decide where it belongs.
 *
 * The support team (anybody in a support-team department) is told about each new ticket and reply that
 * nobody is assigned to, and about each email waiting in the inbox; an assigned ticket tells its agent.
 */

export type Received = { state: SupportEmailState | "DUPLICATE"; emailId: string | null; ticketSeq?: number; note?: string };

const ONE_HOUR = 60 * 60_000;

/** The people a support email is news to: the ticket's agent, else everybody in a support team. */
async function supportTeam(): Promise<string[]> {
  const rows = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY, department: { isSupportTeam: true } }, select: { id: true } });
  return rows.map((r) => r.id);
}

async function tell(userIds: string[], title: string, message: string, link: string) {
  for (const userId of userIds) await notifyUser({ userId, type: "TICKET_EMAIL", title, message, link });
}

/** Whether `address` is already part of this ticket: its contact, or an address in its conversation. */
async function onTicket(ticketId: string, contactEmail: string | null, address: string): Promise<boolean> {
  if (contactEmail && normalizeAddress(contactEmail) === address) return true;
  const seen = await db.supportEmail.count({
    where: { ticketId, OR: [{ fromAddress: address }, { toAddresses: { has: address } }, { ccAddresses: { has: address } }] },
  });
  return seen > 0;
}

export async function receiveEmail(mail: IncomingEmail, now = new Date()): Promise<Received> {
  if (mail.messageId && (await db.supportEmail.count({ where: { messageId: mail.messageId } })) > 0) {
    return { state: "DUPLICATE", emailId: null, note: "Already received" };
  }

  const sender = mail.from?.address ?? "";
  const base = {
    direction: "INBOUND" as const,
    fromAddress: sender || "unknown",
    fromName: mail.from?.name ?? null,
    toAddresses: mail.to,
    ccAddresses: mail.cc,
    subject: mail.subject || "(no subject)",
    body: mail.text,
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
  };
  const keep = async (state: SupportEmailState, extra: { ticketId?: string; contactId?: string | null; note?: string | null } = {}) => {
    const row = await db.supportEmail.create({
      data: {
        ...base,
        state,
        ticketId: extra.ticketId ?? null,
        contactId: extra.contactId ?? null,
        note: extra.note ?? null,
        attachments: { create: mail.attachments },
      },
      select: { id: true },
    });
    return row.id;
  };
  const ignore = async (note: string): Promise<Received> => ({ state: "IGNORED", emailId: await keep("IGNORED", { note }), note });

  // ── 2. Left out ─────────────────────────────────────────────────────────────────────────────────
  if (!sender) return ignore("It had no sender to answer");
  const domain = inboundDomain();
  if (domain && sender.endsWith(`@${domain}`)) return ignore("It came from a helpdesk address itself");
  if (mail.automated) return ignore(mail.automated);
  const recent = await db.supportEmail.count({ where: { direction: "INBOUND", fromAddress: sender, createdAt: { gte: new Date(now.getTime() - ONE_HOUR) } } });
  if (recent >= FLOOD_PER_HOUR) return ignore(`More than ${FLOOD_PER_HOUR} emails from this address in an hour`);

  const waiting = async (note: string): Promise<Received> => {
    const emailId = await keep("INBOX", { note });
    await tell(await supportTeam(), "An email waits in the Support inbox", `${base.fromName ?? sender}: ${base.subject}`, "/tickets/inbox");
    return { state: "INBOX", emailId, note };
  };
  if (isForwardingConfirmation(sender)) return waiting("Gmail's forwarding confirmation: open the link in it to finish setting up forwarding");

  // ── 3. A reply ──────────────────────────────────────────────────────────────────────────────────
  const threadIds = [mail.inReplyTo, ...mail.references].filter((id): id is string => !!id);
  const threaded = threadIds.length
    ? await db.supportEmail.findFirst({ where: { messageId: { in: threadIds }, ticketId: { not: null } }, orderBy: { createdAt: "desc" }, select: { ticketId: true } })
    : null;
  const tagged = ticketSeqFromSubject(base.subject);
  const ticket = threaded?.ticketId
    ? await db.ticket.findUnique({ where: { id: threaded.ticketId }, include: { contact: { select: { email: true } } } })
    : tagged
      ? await db.ticket.findUnique({ where: { ticketSeq: tagged }, include: { contact: { select: { email: true } } } })
      : null;
  if (ticket) {
    const ref = formatTicketId(ticket.ticketSeq);
    if (!(await onTicket(ticket.id, ticket.contact?.email ?? null, sender))) {
      return waiting(`It answers ${ref}, from an address that isn't on that ticket`);
    }
    const reopens = ticket.status === "RESOLVED" || ticket.status === "CLOSED";
    const emailId = await keep("REPLY", { ticketId: ticket.id, contactId: ticket.contactId, note: reopens ? `${ref} opened again` : null });
    await db.ticket.update({
      where: { id: ticket.id },
      // A customer answering is activity on the ticket; answering a closed one means it isn't done.
      data: reopens ? { status: "OPEN", resolvedAt: null, closedAt: null } : { updatedAt: now },
    });
    const who = ticket.assignedToUserId ? [ticket.assignedToUserId] : await supportTeam();
    await tell(who, `${base.fromName ?? sender} replied on ${ref}`, reopens ? `${base.subject} — the ticket is open again` : base.subject, ticketPath(ticket.ticketSeq));
    return { state: "REPLY", emailId, ticketSeq: ticket.ticketSeq };
  }

  // ── 4. A new ticket ─────────────────────────────────────────────────────────────────────────────
  const contacts = await db.contact.findMany({
    where: { email: { equals: sender, mode: "insensitive" } },
    select: { id: true, companyId: true },
    orderBy: { createdAt: "asc" },
  });
  const companies = [...new Set(contacts.map((c) => c.companyId))];
  if (companies.length === 0) return waiting("The sender isn't a contact yet");
  if (companies.length > 1) return waiting(`The sender is a contact at ${companies.length} companies`);

  const settings = await db.supportMailSettings.findUnique({ where: { id: "global" } });
  const agent = settings?.defaultAssigneeUserId
    ? await db.user.findFirst({
        where: { id: settings.defaultAssigneeUserId, active: true, ...PEOPLE_ONLY, department: { isSupportTeam: true } },
        select: { id: true },
      })
    : null;
  const contact = contacts[0]!;
  const opener = await automationUserId();
  const { ticket: made, emailId } = await db.$transaction(async (tx) => {
    const created = await tx.ticket.create({
      data: {
        companyId: contact.companyId,
        contactId: contact.id,
        title: base.subject.slice(0, 200),
        description: visiblePart(base.body).visible.slice(0, 5000) || null,
        assignedToUserId: agent?.id ?? null,
        createdByUserId: opener,
      },
      select: { id: true, ticketSeq: true, title: true },
    });
    const row = await tx.supportEmail.create({
      data: { ...base, state: "NEW_TICKET", ticketId: created.id, contactId: contact.id, attachments: { create: mail.attachments } },
      select: { id: true },
    });
    return { ticket: created, emailId: row.id };
  });
  const ref = formatTicketId(made.ticketSeq);
  await recordAudit({ userId: opener, action: "CREATE", entityType: "Ticket", entityId: made.id, entityLabel: `${ref} — ${made.title} (by email from ${sender})` });

  if (settings?.acknowledge ?? true) {
    await sendSupportEmail({
      ticket: made,
      to: sender,
      sentByUserId: null,
      answering: { messageId: base.messageId, references: base.references },
      body: [
        `Hello${base.fromName ? ` ${base.fromName}` : ""},`,
        "",
        `Thank you for writing to us. We've opened ticket ${ref} for your request, and we'll get back to you soon.`,
        "",
        "To add anything, just reply to this email.",
      ].join("\n"),
    });
  }
  await tell(agent ? [agent.id] : await supportTeam(), `New ticket by email: ${ref}`, `${base.fromName ?? sender}: ${made.title}`, ticketPath(made.ticketSeq));
  return { state: "NEW_TICKET", emailId, ticketSeq: made.ticketSeq };
}
