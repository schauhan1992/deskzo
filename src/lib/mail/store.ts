import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import type { WorkplaceProvider } from "@/lib/workplace/providers";
import type { TokenSet } from "@/lib/mail/types";
import { forgetCalendar } from "@/lib/calendar/account";

/**
 * Keeping a person's connected mailbox (MailConnection): one per person, whichever provider — connecting
 * Gmail after Outlook replaces it. Tokens are encrypted with encryptSecret and never leave the server.
 */
export async function saveMailbox(
  userId: string,
  provider: WorkplaceProvider,
  p: { mailbox: string; displayName: string | null; tokens: TokenSet & { refreshToken: string }; zoho?: { accountsServer: string; accountId: string } },
) {
  const data = {
    provider,
    mailbox: p.mailbox,
    displayName: p.displayName,
    refreshTokenCipher: await encryptSecret(p.tokens.refreshToken),
    accessTokenCipher: await encryptSecret(p.tokens.accessToken),
    accessTokenExpiresAt: p.tokens.expiresAt,
    scopes: p.tokens.scope,
    brokenAt: null,
    lastError: null,
    // Zoho's columns are written only for a Zoho mailbox: a workspace still waiting for them
    // (20261018100000_workplace_sign_in_and_mail) goes on connecting Outlook as before.
    ...(p.zoho ? { zohoAccountsServer: p.zoho.accountsServer, zohoMailAccountId: p.zoho.accountId } : {}),
  };
  await db.mailConnection.upsert({
    where: { userId },
    create: { userId, ...data },
    update: { ...data, connectedAt: new Date() },
  });
}

/**
 * Set when the provider refuses the stored token — a changed password, a revoked consent, an account
 * disabled. Nothing is sent until the person connects again.
 */
/**
 * The person's connection taken down — their mailbox, and the calendar that came with it (the meetings
 * scheduled from records stay on the records). What was connected, or null when nothing was.
 */
export async function removeConnection(userId: string): Promise<{ provider: WorkplaceProvider; mailbox: string } | null> {
  const had = await db.mailConnection.findUnique({ where: { userId }, select: { provider: true, mailbox: true } });
  const removed = await db.mailConnection.deleteMany({ where: { userId } });
  await forgetCalendar(userId);
  return removed.count > 0 ? had : null;
}

export async function markMailboxBroken(userId: string, error: string) {
  await db.mailConnection.update({ where: { userId }, data: { brokenAt: new Date(), lastError: error.slice(0, 300) } });
}
