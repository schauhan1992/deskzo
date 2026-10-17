import { mailboxState, sendAsUser } from "@/lib/mail/mailbox";
import { deliverNow, emailRouteFor } from "@/lib/marketing/pipeline";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { calendarAttachment, type CalendarPart } from "@/lib/marketing/providers/types";
import { deskzoAllowance, recordDeskzoSend } from "@/lib/documents/deskzo-mail-allowance";
import { senderDisplayName } from "@/lib/documents/mail-route-labels";
import { MAIL_NAMES } from "@/lib/workplace/providers";

/**
 * How an invitation to one of Deskzo's own meetings goes out (owner, 17 Oct 2026): from the organiser's
 * own mailbox when they have one connected (it's their meeting, and their Sent folder), otherwise the
 * company's mail server (Settings › Messaging's route for transactional mail) in their name, and when the
 * company has none, Deskzo's mail on the company's behalf — the "Workspace documents" stream, inside the
 * same daily limits as documents sent that way. Replies go to the organiser either way.
 */

export type InviteChoice = "OWN" | "COMPANY" | "DESKZO";
export type InviteRoute = { choice: InviteChoice; from: string };

export async function inviteRoute(userId: string): Promise<InviteRoute> {
  const mailbox = await mailboxState(userId);
  if (mailbox.state === "connected") return { choice: "OWN", from: `${mailbox.mailbox}, your ${MAIL_NAMES[mailbox.provider]}` };
  const company = await emailRouteFor("TRANSACTIONAL");
  if (company) return { choice: "COMPANY", from: `${company.fromEmail ?? company.label}, the company's mail server, in your name` };
  return { choice: "DESKZO", from: "Deskzo's mail service, on your company's behalf, in your name" };
}

/** How many more people Deskzo's mail may invite for this person today — null when it isn't the way. */
export async function invitesLeft(userId: string, route: InviteRoute): Promise<number | null> {
  return route.choice === "DESKZO" ? (await deskzoAllowance(userId)).left : null;
}

export type Invitation = {
  senderId: string;
  senderName: string;
  senderEmail: string;
  companyName: string;
  to: { email: string; name: string | null }[];
  subject: string;
  text: string;
  html: string;
  calendar: CalendarPart;
};

export type InviteSent = { ok: true; from: string; via: InviteChoice } | { ok: false; error: string; lasting: boolean };

/** Sends one invitation, or cancellation, to everybody on it. Never throws: a failure comes back in words. */
export async function sendInvitation(route: InviteRoute, mail: Invitation): Promise<InviteSent> {
  if (mail.to.length === 0) return { ok: true, from: "", via: route.choice };
  const fromName = senderDisplayName(mail.senderName, mail.companyName);
  const [first, ...rest] = mail.to;

  if (route.choice === "OWN") {
    const sent = await sendAsUser(mail.senderId, {
      subject: mail.subject,
      html: mail.html,
      to: mail.to,
      attachments: [(({ filename, contentType, content }) => ({ name: filename, contentType, bytes: content }))(calendarAttachment(mail.calendar))],
    });
    return sent.ok ? { ok: true, from: sent.mailbox, via: "OWN" } : { ok: false, error: `Your mailbox didn't send it: ${sent.error}`, lasting: sent.reconnect };
  }

  if (route.choice === "COMPANY") {
    const sent = await deliverNow(
      { to: first!.email, toName: first!.name, moreTo: rest, fromName, replyTo: mail.senderEmail || null, subject: mail.subject, html: mail.html, text: mail.text, calendar: mail.calendar },
      "TRANSACTIONAL",
      { delivering: true },
    );
    return sent.ok ? { ok: true, from: sent.fromEmail ?? sent.provider, via: "COMPANY" } : { ok: false, error: `The company's mail server didn't take it: ${sent.error}`, lasting: false };
  }

  // Deskzo's mail carries Deskzo's reputation: what one person and one company send through it in a day is limited.
  const allowance = await deskzoAllowance(mail.senderId);
  if (allowance.person.limit === 0 || allowance.workspace.limit === 0) {
    return { ok: false, error: "Deskzo's mail isn't sending for workspaces at the moment, so nobody could be invited. Set up a mail server (Settings › Messaging) to send invitations.", lasting: true };
  }
  if (mail.to.length > allowance.left) {
    const room = allowance.left === 0 ? "none are left today" : `only ${allowance.left} more ${allowance.left === 1 ? "is" : "are"} left today`;
    return { ok: false, error: `Invitations through Deskzo's mail count towards its daily limit, and ${room}. Set up a mail server (Settings › Messaging) to send without the limit, or invite fewer people.`, lasting: true };
  }
  try {
    const from = await sendPlatformMail({
      type: "DOCUMENTS",
      to: first!.email,
      moreTo: rest.map((r) => r.email),
      fromName: `${fromName} via Deskzo`,
      ...(mail.senderEmail ? { replyTo: mail.senderEmail } : {}),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      calendar: mail.calendar,
      // The log keeps the recipients; what the meeting is about stays the workspace's.
      logSubject: "A workspace's meeting invitation",
    });
    await recordDeskzoSend(mail.senderId, null, mail.to.length);
    return { ok: true, from: from ?? "Deskzo", via: "DESKZO" };
  } catch (err) {
    return { ok: false, error: `Deskzo's mail service couldn't send it just now (${err instanceof Error ? err.message : "no reason given"}). Try again in a minute.`, lasting: false };
  }
}
