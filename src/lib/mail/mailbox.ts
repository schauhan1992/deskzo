import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { microsoftApp, microsoftRefresh, sendWithGraph } from "@/lib/mail/microsoft";
import { googleRefresh, rawMessage, sendWithGmail } from "@/lib/mail/google";
import { regionOfAccountsServer, sendWithZoho, zohoRefresh } from "@/lib/mail/zoho";
import { markMailboxBroken } from "@/lib/mail/store";
import { googleApp, mailProviders, zohoApp } from "@/lib/workplace/settings";
import { MAIL_NAMES, PROVIDER_NAMES, SIGN_IN_NAMES, type WorkplaceProvider, type ZohoRegion } from "@/lib/workplace/providers";
import type { OutgoingMail, ProviderSend, SendOutcome, TokenOutcome } from "@/lib/mail/types";

/**
 * A person's own mailbox, whichever provider: Outlook (microsoft.ts), Gmail (google.ts) or Zoho Mail
 * (zoho.ts) — what the company offers is src/lib/workplace/settings.ts `mailProviders()`.
 *
 * Everything that sends as a person sends through `sendAsUser`, which takes care of the provider, a
 * fresh token (stored again when the provider rotates it), one retry when a token is refused early,
 * and marking the connection broken when the provider has withdrawn it.
 */

/** A mailbox as the email dialog and My profile see it. */
export type MailboxState =
  | { state: "connected"; provider: WorkplaceProvider; mailbox: string }
  | { state: "broken"; provider: WorkplaceProvider; mailbox: string; error: string | null }
  | { state: "not-connected"; providers: WorkplaceProvider[] }
  | { state: "app-missing" };

export async function mailboxState(userId: string): Promise<MailboxState> {
  const [providers, connection] = await Promise.all([
    mailProviders(),
    db.mailConnection.findUnique({ where: { userId }, select: { provider: true, mailbox: true, brokenAt: true, lastError: true } }),
  ]);
  // A mailbox with a provider the company no longer offers is no mailbox at all: connect one it does.
  if (connection && providers.includes(connection.provider)) {
    if (connection.brokenAt) return { state: "broken", provider: connection.provider, mailbox: connection.mailbox, error: connection.lastError };
    return { state: "connected", provider: connection.provider, mailbox: connection.mailbox };
  }
  return providers.length > 0 ? { state: "not-connected", providers } : { state: "app-missing" };
}

type Connection = { provider: WorkplaceProvider; mailbox: string; displayName: string | null; zoho: { region: ZohoRegion; accountId: string } | null };
type Access = { ok: true; token: string; connection: Connection } | { ok: false; error: string; reconnect: boolean };

const withdrawn = (p: WorkplaceProvider) => `${SIGN_IN_NAMES[p]} stopped accepting your ${MAIL_NAMES[p]} connection. Connect it again from My profile.`;

async function refreshFor(c: Connection, refreshToken: string): Promise<TokenOutcome | null> {
  switch (c.provider) {
    case "MICROSOFT": {
      const app = await microsoftApp();
      return app ? microsoftRefresh(app, refreshToken) : null;
    }
    case "GOOGLE": {
      const app = await googleApp();
      return app ? googleRefresh(app, refreshToken) : null;
    }
    case "ZOHO": {
      const app = await zohoApp();
      return app && c.zoho ? zohoRefresh(app, c.zoho.region, refreshToken) : null;
    }
  }
}

/** A usable access token, refreshing — and storing the new refresh token a provider rotates in — when due. */
async function accessTokenFor(userId: string, force = false): Promise<Access> {
  const c = await db.mailConnection.findUnique({
    where: { userId },
    select: { provider: true, mailbox: true, displayName: true, refreshTokenCipher: true, accessTokenCipher: true, accessTokenExpiresAt: true, brokenAt: true },
  });
  if (!c) return { ok: false, error: "Connect your mailbox first — My profile → Email.", reconnect: true };
  if (!(await mailProviders()).includes(c.provider)) {
    return { ok: false, error: `Your company doesn't send mail through ${PROVIDER_NAMES[c.provider]} any more. Connect the mailbox it uses from My profile.`, reconnect: true };
  }
  if (c.brokenAt) return { ok: false, error: withdrawn(c.provider), reconnect: true };

  let zoho: Connection["zoho"] = null;
  if (c.provider === "ZOHO") {
    // Read by name: only a Zoho mailbox has them (NOT_YET_EVERYWHERE).
    const z = await db.mailConnection.findUnique({ where: { userId }, select: { zohoAccountsServer: true, zohoMailAccountId: true } });
    const region = regionOfAccountsServer(z?.zohoAccountsServer);
    if (!region || !z?.zohoMailAccountId) {
      await markMailboxBroken(userId, "Its Zoho data centre or Mail account isn't recorded.");
      return { ok: false, error: withdrawn("ZOHO"), reconnect: true };
    }
    zoho = { region, accountId: z.zohoMailAccountId };
  }
  const connection: Connection = { provider: c.provider, mailbox: c.mailbox, displayName: c.displayName, zoho };

  const fresh = c.accessTokenCipher && c.accessTokenExpiresAt && c.accessTokenExpiresAt.getTime() > Date.now() + 60_000;
  if (fresh && !force) {
    try {
      return { ok: true, token: await decryptSecret(c.accessTokenCipher!), connection };
    } catch {
      /* fall through to a refresh */
    }
  }

  let refreshToken: string;
  try {
    refreshToken = await decryptSecret(c.refreshTokenCipher);
  } catch {
    await markMailboxBroken(userId, "The stored token could not be read.");
    return { ok: false, error: `Your ${MAIL_NAMES[c.provider]} connection can't be read any more. Connect it again from My profile.`, reconnect: true };
  }
  const refreshed = await refreshFor(connection, refreshToken);
  if (!refreshed) {
    return { ok: false, error: `The ${PROVIDER_NAMES[c.provider]} app isn't set up any more (Settings → Security). Ask an admin.`, reconnect: false };
  }
  if (!refreshed.ok) {
    if (refreshed.revoked) {
      await markMailboxBroken(userId, refreshed.error);
      return { ok: false, error: withdrawn(c.provider), reconnect: true };
    }
    return { ok: false, error: refreshed.error, reconnect: false };
  }
  await db.mailConnection.update({
    where: { userId },
    data: {
      accessTokenCipher: await encryptSecret(refreshed.tokens.accessToken),
      accessTokenExpiresAt: refreshed.tokens.expiresAt,
      // Microsoft usually hands back a new refresh token; the old one keeps working for a while, but
      // the newest is the one to keep. Google and Zoho keep the one they gave.
      ...(refreshed.tokens.refreshToken ? { refreshTokenCipher: await encryptSecret(refreshed.tokens.refreshToken) } : {}),
    },
  });
  return { ok: true, token: refreshed.tokens.accessToken, connection };
}

/** Sends as the person, from their own mailbox, into their own Sent folder. */
export async function sendAsUser(userId: string, mail: OutgoingMail): Promise<SendOutcome> {
  let raw: Buffer | null = null;
  let provider: WorkplaceProvider = "MICROSOFT";
  for (const force of [false, true]) {
    const access = await accessTokenFor(userId, force);
    if (!access.ok) return access;
    const { token, connection: c } = access;
    provider = c.provider;
    let sent: ProviderSend;
    if (c.provider === "GOOGLE") {
      raw ??= await rawMessage({ email: c.mailbox, name: c.displayName }, mail);
      sent = await sendWithGmail(token, raw);
    } else if (c.provider === "ZOHO") {
      sent = await sendWithZoho(c.zoho!.region, token, { accountId: c.zoho!.accountId, address: c.mailbox }, mail);
    } else {
      sent = await sendWithGraph(token, mail);
    }
    if (sent.ok) {
      await db.mailConnection.update({ where: { userId }, data: { lastUsedAt: new Date(), lastError: null } });
      return { ok: true, mailbox: c.mailbox, provider: c.provider };
    }
    // An access token the provider has stopped honouring early: one fresh token, one more try.
    if (sent.status === 401 && !force) continue;
    // No answer at all: nothing to record against the connection.
    if (sent.status === 0) return { ok: false, error: sent.error, reconnect: false };
    await db.mailConnection.update({ where: { userId }, data: { lastError: sent.error } });
    return { ok: false, error: sent.error, reconnect: sent.status === 401 || sent.status === 403 };
  }
  return { ok: false, error: `${MAIL_NAMES[provider]} kept refusing the connection. Connect it again from My profile.`, reconnect: true };
}
