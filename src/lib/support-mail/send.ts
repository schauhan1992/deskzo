import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getOrganisation } from "@/lib/organisation";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { currentTenant } from "@/lib/tenancy/resolve";
import { inboundDomain, workspaceSupportAddress } from "@/lib/support-mail/config";
import { replySubject } from "@/lib/support-mail/rules";

/**
 * An email from the helpdesk to a customer: an agent's reply, or the acknowledgement of a new ticket.
 *
 * Sent through the platform's mail server under the company's name — "Wroffy Support" — from the
 * platform's own address, with Reply-To the workspace's helpdesk address. So the customer's answer comes
 * back through the forwarding address and lands on the same ticket: by its In-Reply-To and References,
 * or failing those by the [TCK-…] tag in the subject. Every email sent is kept in the ticket's
 * conversation, and one the mail server refused is kept as FAILED with the reason.
 */

export type SupportSend = {
  ticket: { id: string; ticketSeq: number; title: string };
  to: string;
  cc?: string[];
  body: string;
  /** Who wrote it — null for the automatic acknowledgement. */
  sentByUserId: string | null;
  /** The email this answers, to thread under. */
  answering?: { messageId: string | null; references: string[] } | null;
};

/** The company the customer knows: its trade name, its legal name, or the workspace's. */
export async function supportFromName(): Promise<string> {
  const organisation = await getOrganisation().catch(() => null);
  const company = organisation?.tradeName || organisation?.legalName || (await currentTenant()).name;
  return `${company} Support`;
}

export async function sendSupportEmail(input: SupportSend): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const domain = inboundDomain();
  const replyTo = await workspaceSupportAddress();
  if (!domain || !replyTo) return { ok: false, error: "Support email isn't set up on this platform yet, so a reply couldn't come back to the ticket." };

  const messageId = `<${randomUUID()}@${domain}>`;
  const references = [...(input.answering?.references ?? []), ...(input.answering?.messageId ? [input.answering.messageId] : [])].slice(-20);
  const subject = replySubject(input.ticket.title, input.ticket.ticketSeq);
  const fromName = await supportFromName();
  const cc = (input.cc ?? []).filter((a) => a && a !== input.to);

  let failure: string | null = null;
  try {
    await sendPlatformMail({
      type: "SUPPORT",
      to: input.to,
      cc,
      subject,
      text: input.body,
      replyTo,
      fromName,
      messageId,
      inReplyTo: input.answering?.messageId ?? undefined,
      references,
    });
  } catch (err) {
    failure = err instanceof Error && /^[\w .,:'-]{1,200}$/.test(err.message) ? err.message : "The mail server refused it.";
  }

  const row = await db.supportEmail.create({
    data: {
      direction: "OUTBOUND",
      state: failure ? "FAILED" : "SENT",
      ticketId: input.ticket.id,
      fromAddress: replyTo,
      fromName,
      toAddresses: [input.to],
      ccAddresses: cc,
      subject,
      body: input.body,
      messageId,
      inReplyTo: input.answering?.messageId ?? null,
      references,
      note: failure,
      sentByUserId: input.sentByUserId,
    },
    select: { id: true },
  });
  return failure ? { ok: false, error: `It wasn't sent: ${failure}` } : { ok: true, id: row.id };
}
