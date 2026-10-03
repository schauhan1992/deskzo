"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import type { TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, viewAsContext } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { getTradeDocument } from "@/actions/trade-document";
import { getBranding } from "@/actions/branding";
import { getOrganisation } from "@/lib/organisation";
import { formatMoney } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import { approvalDocumentFor, approvalPolicyFor } from "@/lib/documents/approval-policy";
import { approvalRequirement } from "@/lib/documents/approval";
import { canSend } from "@/lib/marketing/suppression";
import { mintRenderGrant } from "@/lib/documents/render-grant";
import { RENDER_PARAM } from "@/lib/documents/render-token";
import { PDF_MAX_BYTES, PdfError, renderPdf } from "@/lib/documents/pdf";
import { mailboxState, sendAsUser } from "@/lib/mail/mailbox";
import { removeConnection } from "@/lib/mail/store";
import { mailProviders } from "@/lib/workplace/settings";
import { MAIL_NAMES, SIGN_IN_NAMES, sayEither } from "@/lib/workplace/providers";
import {
  DEFAULT_TEMPLATES,
  EMAILABLE_TYPES,
  attachmentName,
  isEmailable,
  mergeTemplate,
  recipientNames,
  toEmailHtml,
  type EmailableType,
  type MergeValues,
} from "@/lib/documents/email-template";
import type { ActionResult } from "@/actions/company";
import { renderTarget } from "@/lib/tenancy/render-target";

/**
 * Emailing a document to the customer — the Mail button on a proposal, proforma, tax invoice or
 * credit note.
 *
 * It goes out from the sender's own mailbox — Outlook, Gmail or Zoho Mail, whichever they connected
 * (src/lib/mail/mailbox.ts) — with the document as a PDF
 * made from its own print page (src/lib/documents/pdf.ts), to the customer's contacts the sender
 * ticks. Every recipient is logged against the document, and the whole send is audited.
 */

const MAX_RECIPIENTS = 10;
const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;

const NOT_ALLOWED = "You can't email documents to customers.";

type Doc = NonNullable<Awaited<ReturnType<typeof getTradeDocument>>>;

/** Why this document can't go out as it is, or null. */
async function unsendable(doc: Doc): Promise<string | null> {
  if (!isEmailable(doc.docType)) return `A ${tradeDocumentLabels[doc.docType].toLowerCase()} isn't emailed to a customer from here.`;
  if (doc.status === "DRAFT") return "Issue it first — a draft has no number yet, and the customer would be sent a preview.";
  if (doc.status === "CANCELLED") return "It's cancelled. Send the document that replaced it instead.";
  const [policy, facts] = await Promise.all([approvalPolicyFor(doc.docType), approvalDocumentFor(doc.id)]);
  const needsSignOff = facts ? approvalRequirement(policy, facts).required : policy.enabled;
  if (needsSignOff && doc.approvalStatus !== "APPROVED") return "It's waiting for approval. It can be emailed once it's approved.";
  return null;
}

async function mergeValuesFor(doc: Doc, senderId: string): Promise<MergeValues> {
  const [sender, org, branding] = await Promise.all([
    db.user.findUnique({ where: { id: senderId }, select: { name: true, email: true, phone: true } }),
    getOrganisation(),
    getBranding(),
  ]);
  // A document's dates are calendar days, held as midnight UTC: the day typed, in any zone.
  const day = (d: string | Date | null | undefined) => (d ? formatCalendarDay(d) : null);
  return {
    "customer.name": doc.company.name,
    "document.type": tradeDocumentLabels[doc.docType],
    "document.number": doc.docNumber,
    "document.date": day(doc.issueDate),
    "document.total": formatMoney(doc.total, doc.currency),
    "document.dueDate": day(doc.dueDate),
    "document.validUntil": day(doc.validUntil),
    "sender.name": sender?.name ?? null,
    "sender.email": sender?.email ?? null,
    "sender.phone": sender?.phone ?? null,
    "company.name": org.tradeName || org.legalName || branding.appName,
  };
}

async function templateFor(docType: EmailableType): Promise<{ subject: string; body: string }> {
  const row = await db.documentEmailTemplate.findUnique({ where: { docType } });
  return row ? { subject: row.subject, body: row.body } : DEFAULT_TEMPLATES[docType];
}

/** The company's contacts, each with whether mail can go to them — worked out before anybody presses send. */
async function recipientsFor(companyId: string) {
  const [company, contacts] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { managedByResellerId: true } }),
    db.contact.findMany({
      where: { companyId },
      orderBy: [{ receivesDocuments: "desc" }, { isPrimary: "desc" }, { name: "asc" }],
      select: { id: true, name: true, email: true, phone: true, designation: true, isPrimary: true, receivesDocuments: true, emailStatus: true, emailCheckedValue: true },
    }),
  ]);
  const addresses = contacts.map((c) => c.email?.trim().toLowerCase()).filter((e): e is string => !!e);
  const domains = [...new Set(addresses.map((a) => a.split("@")[1]).filter(Boolean))];
  const now = new Date();
  // Only the suppressions a transactional mail respects — a bounce or a complaint. An unsubscribe
  // from offers does not stop somebody receiving the invoice they owe.
  const suppressions = await db.suppression.findMany({
    where: {
      reason: { in: ["HARD_BOUNCE", "COMPLAINT"] },
      OR: [
        { scope: "EMAIL", value: { in: addresses } },
        { scope: "CONTACT", value: { in: contacts.map((c) => c.id) } },
        { scope: "COMPANY", value: companyId },
        { scope: "DOMAIN", value: { in: domains } },
      ],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    select: { scope: true, value: true, reason: true },
  });

  return contacts.map((c) => {
    const address = c.email?.trim().toLowerCase() ?? null;
    const domain = address?.split("@")[1] ?? null;
    const verdict = canSend(
      {
        company: { managedByResellerId: company?.managedByResellerId ?? null },
        contact: { email: c.email, phone: c.phone, emailStatus: c.emailStatus, emailCheckedValue: c.emailCheckedValue },
        suppressions: suppressions
          .filter(
            (s) =>
              (s.scope === "EMAIL" && s.value === address) ||
              (s.scope === "CONTACT" && s.value === c.id) ||
              s.scope === "COMPANY" ||
              (s.scope === "DOMAIN" && s.value === domain),
          )
          .map((s) => ({ reason: s.reason })),
        consent: null,
        signals: { unansweredFeedback: 0, daysOverdue: null, breachedTickets: 0, sentInLastWeek: 0 },
      },
      // Transactional: only the hard stops apply. Topic and limits are the marketing half, unused here.
      { messageClass: "TRANSACTIONAL", channel: "EMAIL", topic: "SERVICE", limits: { maxPerContactPerWeek: 0, overdueDaysBlock: 0, requireVerifiedAddress: false } },
    );
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      designation: c.designation,
      isPrimary: c.isPrimary,
      receivesDocuments: c.receivesDocuments,
      canReceive: verdict.ok,
      blockedBecause: verdict.ok ? null : verdict.detail,
    };
  });
}

// ─── The dialog ──────────────────────────────────────────────────────────────────────────────────

export type { MailboxState } from "@/lib/mail/mailbox";

export async function prepareDocumentEmail(documentId: string) {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await can(user.id, "documents.send"))) return { ok: false as const, error: NOT_ALLOWED };
  const doc = await getTradeDocument(String(documentId));
  if (!doc) return { ok: false as const, error: "That document isn't there, or isn't one you can see." };
  const blocked = await unsendable(doc);
  if (blocked) return { ok: false as const, error: blocked };

  const [contacts, template, values, mailbox] = await Promise.all([
    recipientsFor(doc.companyId),
    templateFor(doc.docType as EmailableType),
    mergeValuesFor(doc, user.id),
    mailboxState(user.id),
  ]);
  // Ticked for invoices first; with nobody ticked, the primary contact — whoever can receive it.
  const ticked = contacts.filter((c) => c.receivesDocuments && c.canReceive).map((c) => c.id);
  const preselected = ticked.length > 0 ? ticked : contacts.filter((c) => c.isPrimary && c.canReceive).map((c) => c.id);

  return toPlain({
    ok: true as const,
    document: {
      id: doc.id,
      label: tradeDocumentLabels[doc.docType],
      number: doc.docNumber,
      customer: doc.company.name,
      lastEmailedAt: (doc as { lastEmailedAt?: Date | string | null }).lastEmailedAt ?? null,
    },
    contacts,
    preselected,
    template,
    values,
    mailbox,
    viewingAs: !!(await viewAsContext()),
  });
}

export type SendDocumentInput = { documentId: string; contactIds: string[]; subject: string; body: string };

export async function sendDocumentEmail(input: SendDocumentInput): Promise<ActionResult<{ sentTo: string[]; from: string; mailName: string }>> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const blockedWhileViewing = await refuseWhileViewingAs();
  if (blockedWhileViewing) return { ok: false, error: blockedWhileViewing };
  if (!(await can(user.id, "documents.send"))) return { ok: false, error: NOT_ALLOWED };

  const doc = await getTradeDocument(String(input?.documentId ?? ""));
  if (!doc) return { ok: false, error: "That document isn't there, or isn't one you can see." };
  const blocked = await unsendable(doc);
  if (blocked) return { ok: false, error: blocked };

  // Recipients: this customer's own contacts, each still able to receive mail.
  const wanted = [...new Set(Array.isArray(input.contactIds) ? input.contactIds.map(String) : [])];
  if (wanted.length === 0) return { ok: false, error: "Tick at least one person to send it to." };
  if (wanted.length > MAX_RECIPIENTS) return { ok: false, error: `Send it to ${MAX_RECIPIENTS} people at most.` };
  const contacts = await recipientsFor(doc.companyId);
  const chosen = wanted.map((id) => contacts.find((c) => c.id === id));
  if (chosen.some((c) => !c)) return { ok: false, error: "One of those people isn't a contact of this customer." };
  const refused = chosen.find((c) => !c!.canReceive);
  if (refused) return { ok: false, error: `${refused!.name} can't be sent this: ${refused!.blockedBecause}` };
  const recipients = chosen as NonNullable<(typeof chosen)[number]>[];

  // The words: merged here, authoritatively, whatever the dialog showed.
  const values: MergeValues = { ...(await mergeValuesFor(doc, user.id)), "recipient.names": recipientNames(recipients.map((r) => r.name)) };
  const subjectIn = typeof input.subject === "string" ? input.subject.trim() : "";
  const bodyIn = typeof input.body === "string" ? input.body.trim() : "";
  if (!subjectIn) return { ok: false, error: "Give the email a subject." };
  if (!bodyIn) return { ok: false, error: "Write the message." };
  if (subjectIn.length > SUBJECT_MAX || bodyIn.length > BODY_MAX) return { ok: false, error: "The message is too long." };
  const subject = mergeTemplate(subjectIn, values);
  if (!subject.ok) return { ok: false, error: subject.error };
  const body = mergeTemplate(bodyIn, values);
  if (!body.ok) return { ok: false, error: body.error };
  if (/[\r\n]/.test(subject.text)) return { ok: false, error: "The subject has to be one line." };

  // A connection before the PDF: no point making one to find there's nothing to send it with.
  const mailbox = await mailboxState(user.id);
  if (mailbox.state !== "connected") {
    return {
      ok: false,
      error:
        mailbox.state === "app-missing"
          ? "Your company hasn't set up Microsoft 365, Google Workspace or Zoho for mail yet (Settings → Security). Ask an admin."
          : mailbox.state === "broken"
            ? `${SIGN_IN_NAMES[mailbox.provider]} stopped accepting your ${MAIL_NAMES[mailbox.provider]} connection. Connect it again from My profile.`
            : `Connect your ${sayEither(mailbox.providers.map((p) => MAIL_NAMES[p]))} first — it's what the email is sent from.`,
    };
  }

  // The PDF, from the document's own print page, printed as this person would see it.
  let pdf: Buffer;
  try {
    const token = await mintRenderGrant(doc.id, user.id);
    const target = await renderTarget(`/documents/${doc.id}/print?${RENDER_PARAM}=${encodeURIComponent(token)}`);
    pdf = await renderPdf(target.url, { hostRules: target.hostRules });
  } catch (e) {
    return { ok: false, error: e instanceof PdfError ? e.message : "The PDF couldn't be made. Nothing was sent." };
  }
  if (pdf.length > PDF_MAX_BYTES) return { ok: false, error: "The PDF is over 3 MB — too big to send this way. Nothing was sent." };

  const html = toEmailHtml(body.text);
  const outcome = await sendAsUser(user.id, {
    subject: subject.text,
    html,
    to: recipients.map((r) => ({ name: r.name, email: r.email! })),
    attachments: [{ name: attachmentName(tradeDocumentLabels[doc.docType], doc.docNumber), contentType: "application/pdf", bytes: pdf }],
  });

  // Logged either way, one row per person, so the document's history and the mail log both say
  // exactly who it went to — or who it did not reach, and why.
  const now = new Date();
  await db.marketingMessage.createMany({
    data: recipients.map((r) => ({
      token: randomBytes(24).toString("base64url"),
      companyId: doc.companyId,
      contactId: r.id,
      channel: "EMAIL" as const,
      messageClass: "TRANSACTIONAL" as const,
      subject: subject.text,
      body: html,
      textBody: body.text,
      toEmail: r.email,
      status: outcome.ok ? ("SENT" as const) : ("FAILED" as const),
      error: outcome.ok ? null : outcome.error,
      scheduledFor: now,
      sentAt: outcome.ok ? now : null,
      attempts: 1,
      sentByUserId: user.id,
      tradeDocumentId: doc.id,
      fromEmail: outcome.ok ? outcome.mailbox : mailbox.mailbox,
    })),
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };

  await db.tradeDocument.update({ where: { id: doc.id }, data: { lastEmailedAt: now } });
  const to = recipients.map((r) => r.email!);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: doc.id,
    entityLabel: `${tradeDocumentLabels[doc.docType]} ${doc.docNumber ?? ""} emailed to ${to.join(", ")} from ${outcome.mailbox}`.slice(0, 500),
  });
  revalidatePath(`/documents/${doc.id}`);
  return { ok: true, data: { sentTo: to, from: outcome.mailbox, mailName: MAIL_NAMES[outcome.provider] } };
}


/** Every time this document was emailed from here: when, by whom, from which mailbox, to whom. */
export async function listDocumentEmails(documentId: string) {
  await requireModuleUser(["sales_documents", "purchase_documents"]);
  const doc = await getTradeDocument(String(documentId));
  if (!doc) return [];
  const rows = await db.marketingMessage.findMany({
    where: { tradeDocumentId: doc.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      createdAt: true,
      sentAt: true,
      status: true,
      error: true,
      toEmail: true,
      fromEmail: true,
      subject: true,
      contact: { select: { name: true } },
      sentBy: { select: { name: true } },
    },
  });
  return toPlain(rows);
}

// ─── The sender's own mailbox ────────────────────────────────────────────────────────────────────

export async function getMailConnection() {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  // Viewing as somebody shows nothing: whose mailbox is connected is theirs to see.
  if (await viewAsContext()) return null;
  const [connection, providers] = await Promise.all([
    db.mailConnection.findUnique({
      where: { userId: user.id },
      select: { provider: true, mailbox: true, displayName: true, connectedAt: true, lastUsedAt: true, brokenAt: true, lastError: true },
    }),
    mailProviders(),
  ]);
  return toPlain({ providers, connection });
}

export async function disconnectMailbox(): Promise<ActionResult<null>> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const blockedWhileViewing = await refuseWhileViewingAs();
  if (blockedWhileViewing) return { ok: false, error: blockedWhileViewing };
  const had = await removeConnection(user.id);
  if (had) {
    await recordAudit({ userId: user.id, action: "DELETE", entityType: "MailConnection", entityId: user.id, entityLabel: `${MAIL_NAMES[had.provider]} disconnected: ${had.mailbox}` });
  }
  revalidatePath("/profile");
  return { ok: true, data: null };
}

// ─── Templates ───────────────────────────────────────────────────────────────────────────────────

export async function getDocumentEmailTemplates() {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await can(user.id, "settings.manage"))) return null;
  const rows = await db.documentEmailTemplate.findMany({ include: { updatedBy: { select: { name: true } } } });
  return toPlain(
    EMAILABLE_TYPES.map((docType) => {
      const row = rows.find((r) => r.docType === docType);
      return {
        docType,
        label: tradeDocumentLabels[docType],
        subject: row?.subject ?? DEFAULT_TEMPLATES[docType].subject,
        body: row?.body ?? DEFAULT_TEMPLATES[docType].body,
        customised: !!row,
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy?.name ?? null,
      };
    }),
  );
}

export async function saveDocumentEmailTemplate(input: { docType: TradeDocumentType; subject: string; body: string }): Promise<ActionResult<null>> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change the document email wording." };
  if (!input || !isEmailable(input.docType)) return { ok: false, error: "That document type isn't emailed." };
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!subject || !body) return { ok: false, error: "A template needs a subject and a message." };
  if (subject.length > SUBJECT_MAX || body.length > BODY_MAX) return { ok: false, error: "That's too long for an email." };

  // Checked against sample values, so a misspelt field is caught here and not on somebody's send.
  const sample: MergeValues = {
    "recipient.names": "Rahul",
    "customer.name": "Acme",
    "document.type": "Tax invoice",
    "document.number": "INV-1",
    "document.date": "1 Oct 2026",
    "document.total": "₹1.00",
    "document.dueDate": "1 Nov 2026",
    "document.validUntil": "1 Nov 2026",
    "sender.name": "Sender",
    "sender.email": "sender@example.com",
    "sender.phone": "+91 90000 00000",
    "company.name": "Us",
  };
  for (const part of [subject, body]) {
    const checked = mergeTemplate(part, sample);
    if (!checked.ok) return { ok: false, error: checked.error };
  }

  await db.documentEmailTemplate.upsert({
    where: { docType: input.docType },
    create: { docType: input.docType, subject, body, updatedById: user.id },
    update: { subject, body, updatedById: user.id },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "DocumentEmailTemplate", entityId: input.docType, entityLabel: `${tradeDocumentLabels[input.docType]} email wording changed` });
  revalidatePath("/settings/document-emails");
  return { ok: true, data: null };
}

export async function resetDocumentEmailTemplate(docType: TradeDocumentType): Promise<ActionResult<null>> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change the document email wording." };
  if (!isEmailable(docType)) return { ok: false, error: "That document type isn't emailed." };
  await db.documentEmailTemplate.deleteMany({ where: { docType } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "DocumentEmailTemplate", entityId: docType, entityLabel: `${tradeDocumentLabels[docType]} email wording reset to the default` });
  revalidatePath("/settings/document-emails");
  return { ok: true, data: null };
}
