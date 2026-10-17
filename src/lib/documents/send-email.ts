import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { STILL_THERE } from "@/lib/contacts/left";
import { recordAudit } from "@/lib/audit";
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
import { mailboxState } from "@/lib/mail/mailbox";
import { documentSender, sendDocumentMail, type SenderChoice } from "@/lib/documents/mail-route";
import { allowanceRefusal, deskzoAllowance, recordDeskzoSend } from "@/lib/documents/deskzo-mail-allowance";
import { MAIL_NAMES, SIGN_IN_NAMES, sayEither } from "@/lib/workplace/providers";
import { DEFAULT_TEMPLATES, attachmentName, isEmailable, mergeTemplate, recipientNames, toEmailHtml, type EmailableType, type MergeValues } from "@/lib/documents/email-template";
import { renderTarget } from "@/lib/tenancy/render-target";
import type { findTradeDocumentFor } from "@/lib/documents/load";

/**
 * Emailing a document to the customer — the one way it is done, from the Mail button on a document
 * (src/actions/document-mail.ts) or by a workflow's step (src/lib/automate/actions/document-email.ts).
 * Whether the person may send documents at all, and reaches this one, is the caller's question; this is
 * what a send is, in two parts:
 *
 *   · `prepareDocumentSend` — everything that can refuse it before anything is made: a document that
 *     is issued, approved if it must be, and emailable; this customer's own contacts, each able to
 *     receive it; the words merged; a way to send it; and today's allowance through Deskzo's mail.
 *   · `deliverDocumentSend` — the PDF from the document's own print page, the send, and the log: one
 *     row per person on the document's mail log, the document's last-emailed time, and the audit.
 */

export const MAX_RECIPIENTS = 10;
export const SUBJECT_MAX = 200;
export const BODY_MAX = 10_000;

export type EmailDoc = NonNullable<Awaited<ReturnType<typeof findTradeDocumentFor>>>;

/** Why this document can't go out as it is, or null. */
export async function unsendable(doc: EmailDoc): Promise<string | null> {
  if (!isEmailable(doc.docType)) return `A ${tradeDocumentLabels[doc.docType].toLowerCase()} isn't emailed to a customer from here.`;
  if (doc.status === "DRAFT") return "Issue it first — a draft has no number yet, and the customer would be sent a preview.";
  if (doc.status === "CANCELLED") return "It's cancelled. Send the document that replaced it instead.";
  const [policy, facts] = await Promise.all([approvalPolicyFor(doc.docType), approvalDocumentFor(doc.id)]);
  const needsSignOff = facts ? approvalRequirement(policy, facts).required : policy.enabled;
  if (needsSignOff && doc.approvalStatus !== "APPROVED") return "It's waiting for approval. It can be emailed once it's approved.";
  return null;
}

export async function mergeValuesFor(doc: EmailDoc, senderId: string): Promise<MergeValues> {
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

export async function templateFor(docType: EmailableType): Promise<{ subject: string; body: string }> {
  const row = await db.documentEmailTemplate.findUnique({ where: { docType } });
  return row ? { subject: row.subject, body: row.body } : DEFAULT_TEMPLATES[docType];
}

/** The company's contacts, each with whether mail can go to them — worked out before anybody presses send. */
export async function recipientsFor(companyId: string) {
  const [company, contacts] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { managedByResellerId: true } }),
    db.contact.findMany({
      // Not anybody who has left the company: an invoice to a former employee is a leak.
      where: { companyId, ...STILL_THERE },
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

/** Who the dialog ticks to begin with: the people who receive documents, else the primary contact. */
export function preselectedRecipients(contacts: Awaited<ReturnType<typeof recipientsFor>>): string[] {
  const ticked = contacts.filter((c) => c.receivesDocuments && c.canReceive).map((c) => c.id);
  return ticked.length > 0 ? ticked : contacts.filter((c) => c.isPrimary && c.canReceive).map((c) => c.id);
}

export type PreparedDocumentSend = {
  senderId: string;
  senderName: string;
  senderEmail: string;
  doc: EmailDoc;
  recipients: { id: string; name: string; email: string }[];
  subject: string;
  text: string;
  html: string;
  companyName: string;
  choice: Exclude<SenderChoice, "CONNECT">;
  /** Where it would have gone from, for the log when it doesn't go. */
  triedFrom: string | null;
};

export type DocumentSendInput = { contactIds: string[]; subject: string; body: string };

/** Everything that can refuse the send before anything is made — and, when nothing does, the send ready to go. */
export async function prepareDocumentSend(
  sender: { id: string; name?: string | null; email?: string | null },
  doc: EmailDoc,
  input: DocumentSendInput,
): Promise<{ ok: true; prepared: PreparedDocumentSend } | { ok: false; error: string }> {
  const blocked = await unsendable(doc);
  if (blocked) return { ok: false, error: blocked };

  // Recipients: this customer's own contacts, each still able to receive mail.
  const wanted = [...new Set(input.contactIds.map(String))];
  if (wanted.length === 0) return { ok: false, error: "Tick at least one person to send it to." };
  if (wanted.length > MAX_RECIPIENTS) return { ok: false, error: `Send it to ${MAX_RECIPIENTS} people at most.` };
  const contacts = await recipientsFor(doc.companyId);
  const chosen = wanted.map((id) => contacts.find((c) => c.id === id));
  if (chosen.some((c) => !c)) return { ok: false, error: "One of those people isn't a contact of this customer." };
  const refused = chosen.find((c) => !c!.canReceive);
  if (refused) return { ok: false, error: `${refused.name} can't be sent this: ${refused.blockedBecause}` };
  const recipients = (chosen as NonNullable<(typeof chosen)[number]>[]).map((r) => ({ id: r.id, name: r.name, email: r.email! }));

  // The words: merged here, authoritatively, whatever the dialog showed.
  const values: MergeValues = { ...(await mergeValuesFor(doc, sender.id)), "recipient.names": recipientNames(recipients.map((r) => r.name)) };
  const subjectIn = input.subject.trim();
  const bodyIn = input.body.trim();
  if (!subjectIn) return { ok: false, error: "Give the email a subject." };
  if (!bodyIn) return { ok: false, error: "Write the message." };
  if (subjectIn.length > SUBJECT_MAX || bodyIn.length > BODY_MAX) return { ok: false, error: "The message is too long." };
  const subject = mergeTemplate(subjectIn, values);
  if (!subject.ok) return { ok: false, error: subject.error };
  const body = mergeTemplate(bodyIn, values);
  if (!body.ok) return { ok: false, error: body.error };
  if (/[\r\n]/.test(subject.text)) return { ok: false, error: "The subject has to be one line." };

  // A way to send it before the PDF: no point making one to find there's nothing to send it with.
  // Their own mailbox, the company's mail server, or Deskzo's — as the company chose (Settings → Document emails).
  const mailbox = await mailboxState(sender.id);
  const route = await documentSender(mailbox);
  if (route.choice === "CONNECT") {
    return {
      ok: false,
      // Only a mailbox the company offers but this person hasn't connected (or that broke) is CONNECT.
      error:
        mailbox.state === "broken"
          ? `${SIGN_IN_NAMES[mailbox.provider]} stopped accepting your ${MAIL_NAMES[mailbox.provider]} connection. Connect it again from My profile.`
          : mailbox.state === "not-connected"
            ? `Connect your ${sayEither(mailbox.providers.map((p) => MAIL_NAMES[p]))} first — it's what the email is sent from.`
            : "Connect your mailbox first — it's what the email is sent from.",
    };
  }

  // Deskzo's mail carries Deskzo's reputation: a day's sends are limited, per person and per company.
  if (route.choice === "DESKZO") {
    const over = allowanceRefusal(await deskzoAllowance(sender.id), recipients.length);
    if (over) return { ok: false, error: over };
  }

  const me = await db.user.findUnique({ where: { id: sender.id }, select: { name: true, email: true } });
  return {
    ok: true,
    prepared: {
      senderId: sender.id,
      senderName: me?.name ?? sender.name ?? "",
      senderEmail: me?.email ?? sender.email ?? "",
      doc,
      recipients,
      subject: subject.text,
      text: body.text,
      html: toEmailHtml(body.text),
      companyName: values["company.name"] ?? "",
      choice: route.choice,
      triedFrom: route.choice === "OWN" && mailbox.state === "connected" ? mailbox.mailbox : (route.company?.fromEmail ?? null),
    },
  };
}

export type DocumentSent = { sentTo: string[]; from: string; mailName: string; via: SenderChoice };

/**
 * The PDF, the send and the log. A failure here sent nothing; `lasting` says whether trying again could
 * help — a PDF over the size limit won't shrink.
 */
export async function deliverDocumentSend(prepared: PreparedDocumentSend, byline: string | null = null): Promise<{ ok: true; data: DocumentSent } | { ok: false; error: string; lasting: boolean }> {
  const { doc, recipients } = prepared;
  // The PDF, from the document's own print page, printed as the sender would see it.
  let pdf: Buffer;
  try {
    const token = await mintRenderGrant(doc.id, prepared.senderId);
    const target = await renderTarget(`/documents/${doc.id}/print?${RENDER_PARAM}=${encodeURIComponent(token)}`);
    pdf = await renderPdf(target.url, { hostRules: target.hostRules });
  } catch (e) {
    return { ok: false, error: e instanceof PdfError ? e.message : "The PDF couldn't be made. Nothing was sent.", lasting: false };
  }
  if (pdf.length > PDF_MAX_BYTES) return { ok: false, error: "The PDF is over 3 MB — too big to send this way. Nothing was sent.", lasting: true };

  const outcome = await sendDocumentMail(prepared.choice, {
    senderUserId: prepared.senderId,
    senderName: prepared.senderName,
    senderEmail: prepared.senderEmail,
    companyName: prepared.companyName,
    to: recipients.map((r) => ({ name: r.name, email: r.email })),
    subject: prepared.subject,
    html: prepared.html,
    text: prepared.text,
    attachment: { filename: attachmentName(tradeDocumentLabels[doc.docType], doc.docNumber), contentType: "application/pdf", content: pdf },
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
      subject: prepared.subject,
      body: prepared.html,
      textBody: prepared.text,
      toEmail: r.email,
      status: outcome.ok ? ("SENT" as const) : ("FAILED" as const),
      error: outcome.ok ? null : outcome.error,
      scheduledFor: now,
      sentAt: outcome.ok ? now : null,
      attempts: 1,
      sentByUserId: prepared.senderId,
      tradeDocumentId: doc.id,
      fromEmail: outcome.ok ? outcome.from : prepared.triedFrom,
    })),
  });
  if (!outcome.ok) return { ok: false, error: outcome.error, lasting: false };
  if (outcome.via === "DESKZO") await recordDeskzoSend(prepared.senderId, doc.id, recipients.length);

  await db.tradeDocument.update({ where: { id: doc.id }, data: { lastEmailedAt: now } });
  const to = recipients.map((r) => r.email);
  await recordAudit({
    userId: prepared.senderId,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: doc.id,
    entityLabel: `${tradeDocumentLabels[doc.docType]} ${doc.docNumber ?? ""} emailed to ${to.join(", ")} from ${outcome.from} (${outcome.label})${byline ? ` ${byline}` : ""}`.slice(0, 500),
  });
  return { ok: true, data: { sentTo: to, from: outcome.from, mailName: outcome.label, via: outcome.via } };
}
