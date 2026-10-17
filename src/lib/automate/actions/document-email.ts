import { z } from "zod";
import { findTradeDocumentFor } from "@/lib/documents/load";
import { isEmailable } from "@/lib/documents/email-template";
import { deliverDocumentSend, prepareDocumentSend, preselectedRecipients, recipientsFor, templateFor, unsendable } from "@/lib/documents/send-email";
import { ActionError, defineAction } from "@/lib/automate/action-types";
import { priorOutput, withOutsideEffect } from "@/lib/automate/effects";
import { byWorkflow, notReached, recordIdField } from "@/lib/automate/actions/shared";

/**
 * Email a document to the customer (Deskzo Automate, Phase 2) — a quote when it is issued, an invoice
 * when it falls due — exactly as the Mail button sends it (src/lib/documents/send-email.ts), as the
 * workflow's owner: from their mailbox, the company's mail server or Deskzo's, as the company chose; to
 * the customer's own contacts who can receive it; with the PDF of its print page; logged on the
 * document. An unapproved, draft or cancelled document is refused, as is a day past Deskzo's allowance.
 *
 * To whom: the contacts named, or — as the dialog ticks them — those set to receive documents, else the
 * primary contact. The words: the step's own, or the workspace's wording for that kind of document.
 */

type Output = { documentId: string; sentTo: number; via: string; from: string };

const input = z
  .object({
    documentId: recordIdField("document"),
    contactIds: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(10_000).optional(),
  })
  .strict();

export const documentEmail = defineAction({
  key: "document.email",
  label: "Email a document",
  description: "Emails a quote, proforma, invoice or credit note to the customer, with its PDF.",
  module: "sales_documents",
  permission: "documents.send",
  risk: "irreversible",
  input,
  preview: (i) => `Would email the document to ${i.contactIds?.length ? `${i.contactIds.length} named contact${i.contactIds.length === 1 ? "" : "s"}` : "the customer's document contacts"}${i.subject ? `: "${i.subject}"` : ", in the workspace's wording"}.`,
  async run(ctx, i): Promise<Output> {
    // Sent on an earlier try: that stands, whatever has changed since.
    const done = await priorOutput<Output>(ctx);
    if (done) return done.output;

    const doc = await findTradeDocumentFor(ctx.actorId, i.documentId);
    if (!doc) throw notReached("document");
    const blocked = await unsendable(doc);
    if (blocked || !isEmailable(doc.docType)) throw new ActionError(blocked ?? "That kind of document isn't emailed.", "PERMANENT");

    const contactIds = i.contactIds?.length ? i.contactIds : preselectedRecipients(await recipientsFor(doc.companyId));
    if (contactIds.length === 0) throw new ActionError("Nobody at the customer can receive it — set a contact to receive documents.", "PERMANENT");
    const wording = await templateFor(doc.docType);
    const prepared = await prepareDocumentSend({ id: ctx.actorId }, doc, { contactIds, subject: i.subject ?? wording.subject, body: i.body ?? wording.body });
    if (!prepared.ok) throw new ActionError(prepared.error, "PERMANENT");

    const { output } = await withOutsideEffect<Output>(ctx, async () => {
      const sent = await deliverDocumentSend(prepared.prepared, byWorkflow(ctx));
      if (!sent.ok) return { ok: false, error: sent.error, kind: sent.lasting ? "PERMANENT" : "TRANSIENT" };
      return { ok: true, output: { documentId: doc.id, sentTo: sent.data.sentTo.length, via: sent.data.via, from: sent.data.from }, recordType: "document", recordId: doc.id };
    });
    return output;
  },
});
