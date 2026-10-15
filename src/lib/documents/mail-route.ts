import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { emailRouteFor, deliverNow } from "@/lib/marketing/pipeline";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { sendAsUser, type MailboxState } from "@/lib/mail/mailbox";
import { MAIL_NAMES } from "@/lib/workplace/providers";
import { chooseSender, isDocumentSendMode, senderDisplayName, type DocumentSendMode, type SenderChoice } from "@/lib/documents/mail-route-labels";

export { DOCUMENT_SEND_MODES, chooseSender, documentSendModeLabels, isDocumentSendMode, senderDisplayName } from "@/lib/documents/mail-route-labels";
export type { DocumentSendMode, SenderChoice } from "@/lib/documents/mail-route-labels";

/**
 * Where an emailed document goes out from (owner, 15 Oct 2026) — the company's choice under
 * Settings → Document emails (`DocumentMailSettings.sendFrom`):
 *
 * 1. OWN — the sender's own Outlook, Gmail or Zoho Mail, into their own Sent folder (as before).
 * 2. COMPANY — the company's mail server: Settings › Messaging's route for transactional mail (SMTP,
 *    Microsoft 365 SMTP, SES, Resend, Elastic Email). From its address with the sender's name on it;
 *    replies go to the sender, who gets a copy.
 * 3. OWN_THEN_COMPANY — their own mailbox if they have connected one, otherwise the company's.
 *
 * And when nothing the choice names is set up — no mailbox apps and no mail server — Deskzo sends it on
 * the company's behalf: the platform's "Workspace documents" mail, in the sender's and the company's
 * name, replies and a copy to the sender. A mailbox that is set up but not connected (or broken) is not
 * "nothing set up": the person connects it, as before, and nothing goes out in their place.
 */

/** The company's choice; "OWN" when none was made, or before the table exists. */
export async function documentSendMode(): Promise<DocumentSendMode> {
  try {
    const row = await db.documentMailSettings.findUnique({ where: { id: "global" }, select: { sendFrom: true } });
    return isDocumentSendMode(row?.sendFrom) ? row.sendFrom : "OWN";
  } catch (err) {
    if (notMigratedYet(err)) return "OWN";
    throw err;
  }
}

export type DocumentSender = {
  mode: DocumentSendMode;
  choice: SenderChoice;
  /** What the dialog says it goes from. */
  from: string;
  /** For COMPANY: the route's label and address; null otherwise. */
  company: { label: string; fromEmail: string | null } | null;
};

/** How this person's next document email would go out, for the dialog and the send. */
export async function documentSender(mailbox: MailboxState): Promise<DocumentSender> {
  const [mode, company] = await Promise.all([documentSendMode(), emailRouteFor("TRANSACTIONAL")]);
  const choice = chooseSender(mode, mailbox.state, !!company);
  const from =
    choice === "OWN" && mailbox.state === "connected"
      ? `${mailbox.mailbox} — your ${MAIL_NAMES[mailbox.provider]}`
      : choice === "COMPANY"
        ? `${company!.fromEmail ?? company!.label} — the company's mail server, in your name`
        : choice === "DESKZO"
          ? "Deskzo's mail service, on your company's behalf, in your name"
          : "";
  return { mode, choice, from, company: choice === "COMPANY" ? company : null };
}

export type DocumentMail = {
  senderUserId: string;
  senderName: string;
  senderEmail: string;
  /** The company's own name, beside the sender's. */
  companyName: string;
  to: { name: string | null; email: string }[];
  subject: string;
  html: string;
  text: string;
  attachment: { filename: string; contentType: string; content: Buffer };
};

export type DocumentMailOutcome = { ok: true; from: string; via: SenderChoice; label: string } | { ok: false; error: string };

/** Sends it the way `choice` says. Never throws: a failure comes back in words. */
export async function sendDocumentMail(choice: Exclude<SenderChoice, "CONNECT">, mail: DocumentMail): Promise<DocumentMailOutcome> {
  if (mail.to.length === 0) return { ok: false, error: "Nobody to send it to." };
  if (choice === "OWN") {
    const sent = await sendAsUser(mail.senderUserId, {
      subject: mail.subject,
      html: mail.html,
      to: mail.to,
      attachments: [{ name: mail.attachment.filename, contentType: mail.attachment.contentType, bytes: mail.attachment.content }],
    });
    return sent.ok ? { ok: true, from: sent.mailbox, via: "OWN", label: `your ${MAIL_NAMES[sent.provider]}` } : { ok: false, error: sent.error };
  }

  const fromName = senderDisplayName(mail.senderName, mail.companyName);
  const [first, ...rest] = mail.to;
  if (choice === "COMPANY") {
    const sent = await deliverNow(
      {
        to: first!.email,
        toName: first!.name,
        moreTo: rest,
        bcc: [mail.senderEmail],
        fromName,
        replyTo: mail.senderEmail,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        attachments: [mail.attachment],
      },
      "TRANSACTIONAL",
      { delivering: true },
    );
    return sent.ok
      ? { ok: true, from: sent.fromEmail ?? sent.provider, via: "COMPANY", label: "the company's mail server" }
      : { ok: false, error: `The company's mail server didn't take it: ${sent.error}` };
  }

  try {
    const from = await sendPlatformMail({
      type: "DOCUMENTS",
      to: first!.email,
      moreTo: rest.map((r) => r.email),
      bcc: [mail.senderEmail],
      fromName: `${fromName} via Deskzo`,
      replyTo: mail.senderEmail,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: [mail.attachment],
      // The log keeps the recipients; the subject (a customer's document number) stays the workspace's.
      logSubject: "A workspace's document",
    });
    return { ok: true, from: from ?? "Deskzo", via: "DESKZO", label: "Deskzo's mail service" };
  } catch (err) {
    return { ok: false, error: `Deskzo's mail service couldn't send it just now (${err instanceof Error ? err.message : "no reason given"}). Try again in a minute.` };
  }
}
