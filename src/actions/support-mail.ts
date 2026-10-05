"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { viaCompanyScope } from "@/lib/authz/company-scope";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { PEOPLE_ONLY } from "@/lib/people";
import { formatTicketId } from "@/lib/tickets";
import { parseSeqQuery } from "@/lib/order-id";
import { inboundDomain, workspaceSupportAddress } from "@/lib/support-mail/config";
import { normalizeAddress, visiblePart } from "@/lib/support-mail/rules";
import { sendSupportEmail } from "@/lib/support-mail/send";
import type { ActionResult } from "@/actions/company";

/**
 * Tickets by email, from inside the workspace (src/lib/support-mail): its address and settings, the
 * Support inbox, and an agent's reply from a ticket. Receiving is the platform's
 * (src/app/api/platform/inbound-email); nothing here takes mail in.
 *
 *   · The settings are `settings.manage`'s, as the rest of Settings.
 *   · The inbox is for whoever may open tickets (`tickets.create`): deciding where an email belongs is
 *     opening one.
 *   · A ticket's conversation, and replying on it, follow the ticket: `tickets.view` and the account
 *     scope, the same `where` `getTicket` uses — a ticket the agent can't open is one they can't email
 *     from.
 */

const SUPPORT_TEAM = { active: true, ...PEOPLE_ONLY, department: { isSupportTeam: true } } as const;

/** The emails' files as the screens list them: never their contents, which come through the download route. */
const ATTACHMENT_SUMMARY = { select: { id: true, fileName: true, mimeType: true, sizeBytes: true } } as const;

// ─── Settings ────────────────────────────────────────────────────────────────────────────────────

export type SupportMailSetup = {
  /** Null where the platform receives no mail yet. */
  address: string | null;
  acknowledge: boolean;
  defaultAssigneeUserId: string | null;
  agents: { id: string; name: string }[];
  lastReceivedAt: string | null;
  /** Gmail's latest "confirm forwarding" email, so setting up forwarding can be finished from here. */
  gmailConfirmation: { body: string; receivedAt: string } | null;
};

export async function getSupportMailSetup(): Promise<SupportMailSetup | null> {
  const user = await requireModuleUser("helpdesk");
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return null;
  const [address, settings, agents, last, gmail] = await Promise.all([
    workspaceSupportAddress(),
    db.supportMailSettings.findUnique({ where: { id: "global" } }),
    db.user.findMany({ where: SUPPORT_TEAM, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.supportEmail.findFirst({ where: { direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    db.supportEmail.findFirst({
      where: { direction: "INBOUND", fromAddress: "forwarding-noreply@google.com" },
      orderBy: { createdAt: "desc" },
      select: { body: true, createdAt: true },
    }),
  ]);
  return {
    address,
    acknowledge: settings?.acknowledge ?? true,
    defaultAssigneeUserId: settings?.defaultAssigneeUserId ?? null,
    agents,
    lastReceivedAt: last?.createdAt.toISOString() ?? null,
    gmailConfirmation: gmail ? { body: gmail.body.slice(0, 4000), receivedAt: gmail.createdAt.toISOString() } : null,
  };
}

export async function saveSupportMailSettings(input: { acknowledge: boolean; defaultAssigneeUserId: string | null }): Promise<ActionResult<null>> {
  const user = await requireModuleUser("helpdesk");
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return { ok: false, error: "You can't change support email settings." };
  const assignee = input?.defaultAssigneeUserId ? String(input.defaultAssigneeUserId) : null;
  if (assignee && !(await db.user.findFirst({ where: { id: assignee, ...SUPPORT_TEAM }, select: { id: true } }))) {
    return { ok: false, error: "A new ticket can only go to somebody in a support team." };
  }
  const data = { acknowledge: input?.acknowledge !== false, defaultAssigneeUserId: assignee };
  await db.supportMailSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "SupportMailSettings", entityId: "global", entityLabel: "Support email settings" });
  revalidatePath("/settings/support-email");
  return { ok: true, data: null };
}

// ─── The Support inbox ──────────────────────────────────────────────────────────────────────────

async function inboxUser() {
  const user = await requireModuleUser("helpdesk");
  return { user, allowed: await hasEffectivePermission(user.id, "tickets.create") };
}

export async function listSupportInbox() {
  const { allowed } = await inboxUser();
  if (!allowed) return null;
  const rows = await db.supportEmail.findMany({
    where: { direction: "INBOUND", state: "INBOX" },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      fromAddress: true,
      fromName: true,
      subject: true,
      body: true,
      note: true,
      createdAt: true,
      attachments: ATTACHMENT_SUMMARY,
    },
  });
  // Contacts already holding each sender's address — the companies the email might belong to.
  const senders = [...new Set(rows.map((r) => r.fromAddress))];
  const known = senders.length
    ? await db.contact.findMany({
        where: { OR: senders.map((s) => ({ email: { equals: s, mode: "insensitive" as const } })) },
        select: { email: true, company: { select: { id: true, name: true } } },
      })
    : [];
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    body: visiblePart(r.body).visible.slice(0, 20_000),
    companies: known.filter((k) => normalizeAddress(k.email) === r.fromAddress).map((k) => k.company),
  }));
}

/** The inbox email, still waiting — or why it can't be acted on. */
async function waitingEmail(emailId: string) {
  const email = await db.supportEmail.findUnique({ where: { id: String(emailId ?? "") } });
  if (!email || email.direction !== "INBOUND") return { ok: false as const, error: "That email no longer exists." };
  if (email.state !== "INBOX") return { ok: false as const, error: "Somebody has already dealt with that email." };
  return { ok: true as const, email };
}

/**
 * Opens a ticket from an inbox email, at the company the agent chose. With `saveContact`, the sender is
 * added to that company as a contact, so their next email opens its ticket by itself.
 */
export async function createTicketFromEmail(input: { emailId: string; companyId: string; saveContact: boolean; contactName?: string }): Promise<ActionResult<{ ticketSeq: number }>> {
  const { user, allowed } = await inboxUser();
  if (!allowed) return { ok: false, error: "You can't open tickets." };
  const found = await waitingEmail(input?.emailId);
  if (!found.ok) return { ok: false, error: found.error };
  const { email } = found;
  const company = await db.company.findFirst({ where: { id: String(input?.companyId ?? ""), ...(await viaCompanyScope(user.id)) }, select: { id: true } });
  if (!company) return { ok: false, error: "Choose a company you can see." };

  const ticket = await db.$transaction(async (tx) => {
    let contactId: string | null =
      (await tx.contact.findFirst({ where: { companyId: company.id, email: { equals: email.fromAddress, mode: "insensitive" } }, select: { id: true } }))?.id ?? null;
    if (!contactId && input.saveContact) {
      const name = String(input.contactName ?? "").trim() || email.fromName || email.fromAddress.split("@")[0]!;
      contactId = (await tx.contact.create({ data: { companyId: company.id, name: name.slice(0, 120), email: email.fromAddress }, select: { id: true } })).id;
    }
    const made = await tx.ticket.create({
      data: {
        companyId: company.id,
        contactId,
        title: email.subject.slice(0, 200),
        description: visiblePart(email.body).visible.slice(0, 5000) || null,
        createdByUserId: user.id,
      },
      select: { id: true, ticketSeq: true, title: true },
    });
    await tx.supportEmail.update({
      where: { id: email.id },
      data: { state: "NEW_TICKET", ticketId: made.id, contactId, handledById: user.id, handledAt: new Date() },
    });
    return made;
  });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Ticket", entityId: ticket.id, entityLabel: `${formatTicketId(ticket.ticketSeq)} — ${ticket.title} (from the Support inbox)` });
  revalidatePath("/tickets");
  revalidatePath("/tickets/inbox");
  return { ok: true, data: { ticketSeq: ticket.ticketSeq } };
}

/** Adds an inbox email to a ticket the agent names — "TCK-001234" or "1234" — and can open. */
export async function addEmailToTicket(input: { emailId: string; ticket: string }): Promise<ActionResult<{ ticketSeq: number }>> {
  const { user, allowed } = await inboxUser();
  if (!allowed) return { ok: false, error: "You can't change tickets." };
  const found = await waitingEmail(input?.emailId);
  if (!found.ok) return { ok: false, error: found.error };
  const seq = parseSeqQuery(String(input?.ticket ?? ""));
  const ticket = seq ? await db.ticket.findFirst({ where: { ticketSeq: seq, ...(await viaCompanyScope(user.id)) }, select: { id: true, ticketSeq: true } }) : null;
  if (!ticket) return { ok: false, error: "No ticket you can open has that number." };
  await db.supportEmail.update({ where: { id: found.email.id }, data: { state: "REPLY", ticketId: ticket.id, handledById: user.id, handledAt: new Date() } });
  await db.ticket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });
  revalidatePath("/tickets/inbox");
  return { ok: true, data: { ticketSeq: ticket.ticketSeq } };
}

/** Leaves an inbox email out — spam, or nothing to do. It stays on record, as IGNORED. */
export async function ignoreSupportEmail(emailId: string): Promise<ActionResult<null>> {
  const { user, allowed } = await inboxUser();
  if (!allowed) return { ok: false, error: "You can't change the Support inbox." };
  const found = await waitingEmail(emailId);
  if (!found.ok) return { ok: false, error: found.error };
  await db.supportEmail.update({ where: { id: found.email.id }, data: { state: "IGNORED", note: "Left out from the Support inbox", handledById: user.id, handledAt: new Date() } });
  revalidatePath("/tickets/inbox");
  return { ok: true, data: null };
}

// ─── A ticket's conversation ────────────────────────────────────────────────────────────────────

/** The ticket, if this person may open it — `getTicket`'s rule. */
async function visibleTicket(userId: string, ticketId: string) {
  if (!(await hasEffectivePermission(userId, "tickets.view"))) return null;
  return db.ticket.findFirst({
    where: { id: String(ticketId ?? ""), ...(await viaCompanyScope(userId)) },
    select: { id: true, ticketSeq: true, title: true, contact: { select: { email: true } } },
  });
}

/**
 * The ticket's emails, oldest first, and who a reply goes to: whoever wrote to it last, else its contact.
 * `canReply` is false where the platform receives no mail — a reply nobody could answer.
 */
export async function ticketEmails(ticketId: string) {
  const user = await requireModuleUser("helpdesk");
  const ticket = await visibleTicket(user.id, ticketId);
  if (!ticket) return null;
  const emails = await db.supportEmail.findMany({
    where: { ticketId: ticket.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      direction: true,
      state: true,
      fromAddress: true,
      fromName: true,
      toAddresses: true,
      ccAddresses: true,
      subject: true,
      body: true,
      note: true,
      createdAt: true,
      sentBy: { select: { name: true } },
      attachments: ATTACHMENT_SUMMARY,
    },
  });
  const lastIn = [...emails].reverse().find((e) => e.direction === "INBOUND");
  return {
    emails: emails.map((e) => ({ ...e, createdAt: e.createdAt.toISOString(), ...visiblePart(e.body) })),
    replyTo: lastIn?.fromAddress ?? (ticket.contact?.email ? normalizeAddress(ticket.contact.email) : null),
    canReply: inboundDomain() !== null,
  };
}

export async function replyToTicketByEmail(input: { ticketId: string; body: string; cc?: string[] }): Promise<ActionResult<null>> {
  const user = await requireModuleUser("helpdesk");
  const ticket = await visibleTicket(user.id, input?.ticketId);
  if (!ticket) return { ok: false, error: "That ticket no longer exists." };
  const body = String(input?.body ?? "").trim();
  if (!body) return { ok: false, error: "Write the reply first." };
  if (body.length > 20_000) return { ok: false, error: "That reply is too long for one email." };
  const cc = (input?.cc ?? []).map(normalizeAddress).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)).slice(0, 10);

  const lastIn = await db.supportEmail.findFirst({
    where: { ticketId: ticket.id, direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    select: { fromAddress: true, messageId: true, references: true },
  });
  const to = lastIn?.fromAddress ?? (ticket.contact?.email ? normalizeAddress(ticket.contact.email) : null);
  if (!to) return { ok: false, error: "Nobody to email: the ticket's contact has no email address." };

  const sender = await db.user.findUnique({ where: { id: user.id }, select: { name: true } });
  const sent = await sendSupportEmail({
    ticket,
    to,
    cc,
    sentByUserId: user.id,
    answering: lastIn ? { messageId: lastIn.messageId, references: lastIn.references } : null,
    body: `${body}\n\n${sender?.name ?? ""}`.trimEnd(),
  });
  revalidatePath(`/tickets/${ticket.id}`);
  return sent.ok ? { ok: true, data: null } : sent;
}

/** One email's file, if this person may see the email it came with — for the download route. */
export async function supportEmailAttachment(id: string) {
  const user = await requireModuleUser("helpdesk");
  const file = await db.supportEmailAttachment.findUnique({
    where: { id: String(id ?? "") },
    select: { fileName: true, mimeType: true, dataUrl: true, email: { select: { ticketId: true, state: true } } },
  });
  if (!file) return null;
  if (file.email.ticketId) {
    if (!(await visibleTicket(user.id, file.email.ticketId))) return null;
  } else if (!(await hasEffectivePermission(user.id, "tickets.create"))) {
    return null;
  }
  return { fileName: file.fileName, mimeType: file.mimeType, dataUrl: file.dataUrl };
}
