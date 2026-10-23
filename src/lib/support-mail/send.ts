import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { getOrganisation } from "@/lib/organisation";
import { sendPlatformMail, type PlatformMail } from "@/lib/platform/mailer";
import { deliverNow, emailRouteFor } from "@/lib/marketing/pipeline";
import { textToHtml } from "@/lib/marketing/html";
import { currentTenant } from "@/lib/tenancy/resolve";
import { inboundDomain, workspaceSupportAddress } from "@/lib/support-mail/config";
import { replySubject } from "@/lib/support-mail/rules";
import { companyAddressing, deskzoAddressing, isReplyFrom, type ReplyFrom } from "@/lib/support-mail/reply-from";
import { helpdeskFromOwnAddress } from "@/lib/platform/helpdesk-from";
import { screenAddresses } from "@/lib/calendar/invitees";
import { helpdeskMailRefusal, recordHelpdeskSend } from "@/lib/documents/deskzo-mail-allowance";

/**
 * An email from the helpdesk to a customer: an agent's reply, or the acknowledgement of a new ticket.
 *
 * Always under the company's name — "Wroffy Support" — and through the route Settings → Support email
 * chose (src/lib/support-mail/reply-from.ts):
 *
 *   · Deskzo's Support mail — from the helpdesk address itself where the platform sends for its domain,
 *     else from the platform's address with Reply-To the helpdesk address;
 *   · the company's own mail server — from its support address, falling back to Deskzo's mail, with a
 *     note on the email, when that server isn't set up or refuses it.
 *
 * Either way the customer's answer comes back to the helpdesk address and lands on the same ticket: by
 * its In-Reply-To and References, or failing those (a provider that writes its own Message-ID) by the
 * [TCK-…] tag in the subject. Every email sent is kept in the ticket's conversation, and one no mail
 * server took is kept as FAILED with the reason.
 *
 * Screened as any mail sent for the company is (src/lib/calendar/invitees.ts — owner, 18 Oct 2026):
 * never to an address that bounced or reported the company's mail as spam, nor to a reseller's customer,
 * who hears from their reseller. Not sent then — the acknowledgement as much as a reply — and kept on the
 * ticket as FAILED with the reason; somebody copied who can't be is left off, and the email says so.
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

/** The workspace's choice under Settings → Support email; Deskzo's mail before it made one, or before its table has the columns. */
export async function supportReplySettings(): Promise<{ replyFrom: ReplyFrom; companyFrom: string | null }> {
  try {
    const row = await db.supportMailSettings.findUnique({ where: { id: "global" }, select: { replyFrom: true, companyFrom: true } });
    return { replyFrom: isReplyFrom(row?.replyFrom) ? row.replyFrom : "DESKZO", companyFrom: row?.companyFrom ?? null };
  } catch (err) {
    if (notMigratedYet(err)) return { replyFrom: "DESKZO", companyFrom: null };
    throw err;
  }
}

/** Whether mail sent to this address has reached the helpdesk — forwarding from it works, so replies can go back to it. */
export async function forwardsHere(address: string): Promise<boolean> {
  return (await db.supportEmail.count({ where: { direction: "INBOUND", toAddresses: { has: address } } })) > 0;
}

/** A refusal in words safe to keep and show: one short line, or a plain "refused". */
function inWords(err: unknown, fallback: string): string {
  const said = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /^[\w .,:;'()@/?!—–-]{1,240}$/.test(said) ? said : fallback;
}

export async function sendSupportEmail(input: SupportSend): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const domain = inboundDomain();
  const helpdesk = await workspaceSupportAddress();
  if (!domain || !helpdesk) return { ok: false, error: "Support email isn't set up on this platform yet, so a reply couldn't come back to the ticket." };

  const messageId = `<${randomUUID()}@${domain}>`;
  const references = [...(input.answering?.references ?? []), ...(input.answering?.messageId ? [input.answering.messageId] : [])].slice(-20);
  const subject = replySubject(input.ticket.title, input.ticket.ticketSeq);
  const fromName = await supportFromName();
  const cc = (input.cc ?? []).filter((a) => a && a !== input.to);
  const settings = await supportReplySettings();
  const screened = await screenAddresses([input.to, ...cc]);
  // Somebody who has left their company still gets an answer where they wrote from.
  const stopped = (address: string) => {
    const verdict = screened.find((v) => v.email === address.trim().toLowerCase());
    return verdict && !verdict.ok && !verdict.left ? verdict.reason : null;
  };
  const leftOff = cc.filter((a) => stopped(a));
  const copied = cc.filter((a) => !stopped(a));

  let failure: string | null = stopped(input.to);
  /** Why it went another way than the one chosen, kept on the email. */
  let note: string | null = leftOff.length ? `Not copied to ${leftOff.join(", ")}: ${stopped(leftOff[0]!)}` : null;
  let fromAddress: string | null = failure ? helpdesk : null;

  if (!failure && settings.replyFrom === "COMPANY") {
    const route = await emailRouteFor("TRANSACTIONAL");
    if (!route) {
      note = "Your mail server isn't set up in Settings › Messaging, so this went through Deskzo's mail.";
    } else {
      const addressing = companyAddressing(settings.companyFrom, settings.companyFrom ? await forwardsHere(settings.companyFrom) : false, helpdesk);
      const sent = await deliverNow(
        {
          to: input.to,
          ...(copied.length ? { cc: copied } : {}),
          subject,
          text: input.body,
          html: textToHtml(input.body),
          fromName,
          fromEmail: addressing.from,
          replyTo: addressing.replyTo,
          headers: {
            "Message-ID": messageId,
            ...(input.answering?.messageId ? { "In-Reply-To": input.answering.messageId } : {}),
            ...(references.length ? { References: references.join(" ") } : {}),
          },
        },
        "TRANSACTIONAL",
        { delivering: true },
      );
      if (sent.ok) fromAddress = sent.fromEmail ?? addressing.from ?? route.fromEmail ?? helpdesk;
      else note = `Your mail server didn't take it (${inWords(sent.error, "refused")}), so this went through Deskzo's mail.`;
    }
  }

  // Through Deskzo's own mail only within the day's helpdesk allowance (security review, 23 Oct 2026): nothing limited
  // these, so a ticket's replies could carry anything to anybody from Deskzo's address.
  const recipients = 1 + copied.length;
  if (!fromAddress) {
    const over = await helpdeskMailRefusal(input.sentByUserId, recipients);
    if (over) {
      failure = over;
      fromAddress = helpdesk;
    }
  }
  const viaDeskzo = !fromAddress;
  if (!fromAddress) {
    const mail: PlatformMail = { type: "SUPPORT", to: input.to, cc: copied, subject, text: input.body, fromName, messageId, inReplyTo: input.answering?.messageId ?? undefined, references };
    const own = deskzoAddressing(await helpdeskFromOwnAddress(), helpdesk);
    try {
      const used = await sendPlatformMail({ ...mail, ...(own.from ? { fromAddress: own.from } : {}), ...(own.replyTo ? { replyTo: own.replyTo } : {}) });
      fromAddress = used ?? own.from ?? helpdesk;
    } catch (err) {
      if (own.from) {
        // The service wouldn't send as the helpdesk address: once more from its own, answers still coming back here.
        try {
          const used = await sendPlatformMail({ ...mail, replyTo: helpdesk });
          fromAddress = used ?? helpdesk;
          note = [note, `Deskzo's mail couldn't send from ${helpdesk} (${inWords(err, "refused")}), so it went from Deskzo's own address.`].filter(Boolean).join(" ");
        } catch (again) {
          failure = inWords(again, "The mail server refused it.");
          fromAddress = helpdesk;
        }
      } else {
        failure = inWords(err, "The mail server refused it.");
        fromAddress = helpdesk;
      }
    }
  }

  if (viaDeskzo && !failure) await recordHelpdeskSend(input.sentByUserId, input.ticket.id, recipients);

  const row = await db.supportEmail.create({
    data: {
      direction: "OUTBOUND",
      state: failure ? "FAILED" : "SENT",
      ticketId: input.ticket.id,
      fromAddress,
      fromName,
      toAddresses: [input.to],
      ccAddresses: copied,
      subject,
      body: input.body,
      messageId,
      inReplyTo: input.answering?.messageId ?? null,
      references,
      note: [note, failure].filter(Boolean).join(" ") || null,
      sentByUserId: input.sentByUserId,
    },
    select: { id: true },
  });
  return failure ? { ok: false, error: `It wasn't sent: ${failure}` } : { ok: true, id: row.id };
}
