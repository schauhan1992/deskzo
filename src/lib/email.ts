import type { NotificationType } from "@prisma/client";
import { db } from "@/lib/db";
import { companyMailAllowed, platformMailerReplaced, sendPlatformMail } from "@/lib/platform/mailer";
import { currentTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import { isEmailed } from "@/lib/notifications/email-settings";
import { notificationLabel } from "@/lib/notifications/catalogue";

/**
 * A notification by email (owner, 18 Oct 2026): every kind the workspace's admins have switched on
 * under Settings › Email notifications (src/lib/notifications/email-settings.ts) — to begin with the
 * two that went by email before, a proforma issued on your deal and AI credits running low. One email
 * per notification, sent as it's raised, to the person's own address with a link to open it.
 *
 * It goes through the company's own mail server — Settings › Mail & messaging's route for
 * transactional mail — when one is set up, in the company's name; otherwise through Deskzo's "Alerts"
 * mail (console › Settings › Mail), in the company's name via Deskzo. If the company's server refuses
 * it, Deskzo sends it instead: the notification is for the person, and a broken server is the admin's
 * to fix, not the person's to miss it over.
 */

/** Why the person is getting it, at the foot of the email. AI_CREDITS: running low or used up (owner, 17 Oct 2026). */
const BECAUSE: Partial<Record<NotificationType, string>> = {
  PROFORMA_ISSUED: "You're getting this because it's one of your deals.",
  AI_CREDITS: "You're getting this because you manage this workspace's plan and billing.",
};

export type NotificationEmailRoute = "COMPANY" | "DESKZO";

/** The company's name as its mail shows it: its trade name, its legal name, or the workspace's own. */
async function companyName(): Promise<string> {
  const row = await db.organisationSettings.findUnique({ where: { id: "global" }, select: { tradeName: true, legalName: true } }).catch(() => null);
  return row?.tradeName?.trim() || row?.legalName.trim() || (await currentTenant()).name;
}

/**
 * An address at a domain reserved for examples and tests (RFC 2606, RFC 6761), which no mail reaches:
 * not sent at all, rather than bounced back to the company's server or Deskzo's. Check suites make
 * their people at these, so a run against a real workspace that emails a kind sends nothing — while
 * one that replaces the mailer still sees what would have gone.
 */
export function undeliverable(address: string): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return /(^|\.)(invalid|test|example|localhost)$/.test(domain) || /(^|\.)example\.(com|net|org)$/.test(domain);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type Composed = { to: string; toName: string; subject: string; text: string; html: string; company: string; label: string };

/**
 * The company's server when one is set up and takes it, Deskzo's otherwise; null for an address no mail
 * reaches. While a check has replaced Deskzo's mailer, its stand-in sees every address, and the company's
 * server is used only if the check says that server is a fake of its own (src/lib/platform/mailer.ts).
 * Throws only what Deskzo's says.
 */
async function deliver(mail: Composed): Promise<NotificationEmailRoute | null> {
  if (!platformMailerReplaced() && undeliverable(mail.to)) return null;
  if (companyMailAllowed()) {
    const { emailRouteFor, deliverNow } = await import("@/lib/marketing/pipeline");
    if (await emailRouteFor("TRANSACTIONAL")) {
      const sent = await deliverNow({ to: mail.to, toName: mail.toName, fromName: mail.company, subject: mail.subject, html: mail.html, text: mail.text }, "TRANSACTIONAL", { delivering: true });
      if (sent.ok) return "COMPANY";
      console.error("[email] the company's mail server didn't take a notification, so Deskzo sends it:", sent.error);
    }
  }
  await sendPlatformMail({
    type: "ALERTS",
    to: mail.to,
    fromName: `${mail.company} via Deskzo`,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    // The log keeps who it went to; what it said stays the workspace's.
    logSubject: `A workspace notification: ${mail.label}`,
  });
  return "DESKZO";
}

/**
 * Emails one notification if the workspace emails its kind; the way it went, or null when it didn't.
 * Never throws: a notification never fails the work that raised it.
 */
export async function sendEmailNotification(params: { userId: string; type: NotificationType; subject: string; body: string; link?: string | null }): Promise<NotificationEmailRoute | null> {
  try {
    if (!(await isEmailed(params.type))) return null;
    const user = await db.user.findUnique({ where: { id: params.userId }, select: { name: true, email: true, active: true, kind: true } });
    // Members only: a support login or the workspace's automation has no inbox of its own to tell.
    if (!user?.active || !user.email || user.kind !== "MEMBER") return null;
    const [origin, company] = await Promise.all([tenantOrigin(), companyName()]);
    const url = params.link ? `${origin}${params.link}` : null;
    const body = params.body.trim();
    const footer = `${BECAUSE[params.type] ?? "You're getting this because it was addressed to you in Deskzo."} Your workspace's admins choose which notifications are emailed, under Settings › Email notifications.`;
    const text = [`Hello ${user.name},`, ...(body ? ["", body] : []), ...(url ? ["", `Open it: ${url}`] : []), "", `— ${company}, on Deskzo`, "", footer].join("\n");
    const html = [
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937">`,
      `<p>Hello ${escapeHtml(user.name)},</p>`,
      body ? `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>` : "",
      url ? `<p><a href="${escapeHtml(url)}">Open it in Deskzo</a></p>` : "",
      `<p>— ${escapeHtml(company)}, on Deskzo</p>`,
      `<p style="font-size:12px;color:#6b7280">${escapeHtml(footer)}</p>`,
      `</div>`,
    ].join("");
    return await deliver({ to: user.email, toName: user.name, subject: params.subject, text, html, company, label: notificationLabel(params.type) });
  } catch (err) {
    // The in-app one, where there is one, is already there.
    console.error("[email] notification email not sent", err instanceof Error ? err.message : err);
    return null;
  }
}
