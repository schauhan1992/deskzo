"use server";

import { revalidatePath } from "next/cache";
import type { TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, viewAsContext } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { getTradeDocument } from "@/actions/trade-document";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import { mailboxState } from "@/lib/mail/mailbox";
import { documentSender, documentSendMode, isDocumentSendMode, type DocumentSendMode, type SenderChoice } from "@/lib/documents/mail-route";
import { deskzoAllowance } from "@/lib/documents/deskzo-mail-allowance";
import { removeConnection } from "@/lib/mail/store";
import { mailProviders } from "@/lib/workplace/settings";
import { MAIL_NAMES } from "@/lib/workplace/providers";
import { DEFAULT_TEMPLATES, EMAILABLE_TYPES, isEmailable, mergeTemplate, type EmailableType, type MergeValues } from "@/lib/documents/email-template";
import {
  BODY_MAX,
  SUBJECT_MAX,
  deliverDocumentSend,
  mergeValuesFor,
  preselectedRecipients,
  prepareDocumentSend,
  recipientsFor,
  templateFor,
  unsendable,
} from "@/lib/documents/send-email";
import type { ActionResult } from "@/actions/company";

/**
 * Emailing a document to the customer — the Mail button on a proposal, proforma, tax invoice or
 * credit note.
 *
 * It goes out from the sender's own mailbox, the company's mail server or Deskzo's, as the company
 * chose (src/lib/documents/mail-route.ts), with the document as a PDF made from its own print page, to
 * the customer's contacts the sender ticks. What a send is lives in src/lib/documents/send-email.ts,
 * shared with Automate's workflows; this file is the dialog, the settings and the templates.
 */

const NOT_ALLOWED = "You can't email documents to customers.";

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
  const sender = await documentSender(mailbox);
  // Through Deskzo's mail, today's limits (src/lib/platform/document-mail-limits.ts) — for the dialog to say.
  const deskzo = sender.choice === "DESKZO" ? await deskzoAllowance(user.id) : null;
  // Ticked for invoices first; with nobody ticked, the primary contact — whoever can receive it.
  const preselected = preselectedRecipients(contacts);

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
    // How it would go out (src/lib/documents/mail-route.ts): their mailbox, the company's server, or Deskzo.
    sender,
    deskzo: deskzo ? { left: deskzo.left, personLimit: deskzo.person.limit, workspaceLimit: deskzo.workspace.limit } : null,
    viewingAs: !!(await viewAsContext()),
  });
}

export type SendDocumentInput = { documentId: string; contactIds: string[]; subject: string; body: string };

export async function sendDocumentEmail(input: SendDocumentInput): Promise<ActionResult<{ sentTo: string[]; from: string; mailName: string; via: SenderChoice }>> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const blockedWhileViewing = await refuseWhileViewingAs();
  if (blockedWhileViewing) return { ok: false, error: blockedWhileViewing };
  if (!(await can(user.id, "documents.send"))) return { ok: false, error: NOT_ALLOWED };

  const doc = await getTradeDocument(String(input?.documentId ?? ""));
  if (!doc) return { ok: false, error: "That document isn't there, or isn't one you can see." };

  // What a send is — the checks, the words, the PDF, the send and the log — is shared with Automate's
  // workflows (src/lib/documents/send-email.ts).
  const prepared = await prepareDocumentSend(user, doc, {
    contactIds: Array.isArray(input.contactIds) ? input.contactIds.map(String) : [],
    subject: typeof input.subject === "string" ? input.subject : "",
    body: typeof input.body === "string" ? input.body : "",
  });
  if (!prepared.ok) return prepared;
  const sent = await deliverDocumentSend(prepared.prepared);
  if (!sent.ok) return { ok: false, error: sent.error };
  revalidatePath(`/documents/${doc.id}`);
  return { ok: true, data: sent.data };
}

// ─── Where documents go out from ─────────────────────────────────────────────────────────────────

/** The company's choice of where emailed documents go out from (Settings → Document emails). */
export async function getDocumentSendMode(): Promise<DocumentSendMode | null> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await can(user.id, "settings.manage"))) return null;
  return documentSendMode();
}

export async function saveDocumentSendMode(mode: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only somebody who can change organisation settings can change this." };
  if (!isDocumentSendMode(mode)) return { ok: false, error: "Pick one of the options offered." };
  await db.documentMailSettings.upsert({ where: { id: "global" }, create: { id: "global", sendFrom: mode, updatedById: user.id }, update: { sendFrom: mode, updatedById: user.id } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "DocumentMailSettings", entityId: "global", entityLabel: `Documents are emailed from: ${mode}` });
  revalidatePath("/settings/document-emails");
  return { ok: true, data: null };
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
