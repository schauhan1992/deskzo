import type { NotificationType } from "@prisma/client";
import { db } from "@/lib/db";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * A notification by email, for the kinds that go by email — so far only one (owner, 8 Oct 2026): a
 * salesperson's proforma issued by accounts, ready to send to the client. It goes through the platform's
 * "Alerts" mail (console › Settings › Mail), to the person's own address, with a link to open it.
 *
 * Every other kind stays in the app only, whatever its email preference says: switching email on for
 * all of them at once would bury people. A kind is added here when somebody asks for it by email.
 */
export const EMAILED_NOTIFICATIONS: ReadonlySet<NotificationType> = new Set<NotificationType>(["PROFORMA_ISSUED"]);

export async function sendEmailNotification(params: { userId: string; type: NotificationType; subject: string; body: string; link?: string | null }) {
  if (!EMAILED_NOTIFICATIONS.has(params.type)) return;
  try {
    const user = await db.user.findUnique({ where: { id: params.userId }, select: { name: true, email: true, active: true } });
    if (!user?.active || !user.email) return;
    const url = params.link ? `${await tenantOrigin()}${params.link}` : null;
    await sendPlatformMail({
      type: "ALERTS",
      to: user.email,
      subject: params.subject,
      text: [`Hello ${user.name},`, "", params.body, ...(url ? ["", `Open it: ${url}`] : []), "", "— Deskzo", "", "You're getting this because it's one of your deals. Turn these emails off under Notifications › Preferences."].join("\n"),
    });
  } catch (err) {
    // A notification never fails the work that raised it — the in-app one is already there.
    console.error("[email] notification email not sent", err instanceof Error ? err.message : err);
  }
}
