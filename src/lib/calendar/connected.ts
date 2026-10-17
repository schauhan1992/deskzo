import { db } from "@/lib/db";
import { mailboxState } from "@/lib/mail/mailbox";

/**
 * Whether a person's meetings go into a provider's calendar — Outlook, Google or Zoho connected, its
 * calendar allowed and working, the Calendar page's "ready" — or into Deskzo's own (native.ts). Asked of
 * the database only: nothing here calls the provider.
 */
export async function hasWorkingCalendar(userId: string): Promise<boolean> {
  const [mailbox, account] = await Promise.all([
    mailboxState(userId),
    db.calendarAccount.findUnique({ where: { userId }, select: { provider: true, brokenAt: true, calendarId: true } }),
  ]);
  if (mailbox.state !== "connected" || !account || account.brokenAt || account.provider !== mailbox.provider) return false;
  return account.provider !== "ZOHO" || !!account.calendarId;
}
