import { authorizeUrl, exchangeCode, fetchMe, grantsCalendar, mailboxFor, microsoftApp, microsoftScopes, pkcePair, saveConnection } from "@/lib/mail/microsoft";
import { fetchGoogleMe, googleAuthorizeUrl, googleExchangeCode, googleScopes, grantsGmailSend, grantsGoogleCalendar } from "@/lib/mail/google";
import { accountsServerOf, fetchZohoMe, regionOfAccountsServer, zohoAuthorizeUrl, zohoExchangeCode, zohoMailAccount, zohoScopes } from "@/lib/mail/zoho";
import { saveMailbox } from "@/lib/mail/store";
import { calendarsWanted, forgetCalendar, saveCalendarAccount } from "@/lib/calendar/account";
import { zohoDefaultCalendar } from "@/lib/calendar/zoho";
import { googleApp, mailProviders, zohoApp } from "@/lib/workplace/settings";
import { accountAddress } from "@/lib/workplace/sign-in";
import type { WorkplaceProvider } from "@/lib/workplace/providers";

/**
 * Connecting a person's own mailbox, for each provider — the two halves of the round trip, behind
 * src/app/api/mail/[provider]/connect and …/callback.
 *
 * Every check happens before anything is stored: the provider is one the company offers for mail,
 * the code is good, the permission to send was granted, and the mailbox is the person's own — the
 * address on their account here. Somebody signed in to a personal account in the same browser can't
 * connect that one by accident, and nobody can connect anybody else's.
 *
 * With Calendar on in the workspace (Settings → Modules), the same round trip asks for the person's
 * calendar too, and a connection that brings it sets their calendar up (src/lib/calendar). The mailbox
 * is connected either way: somebody who unticks the calendar on the consent screen still sends mail,
 * and is told their calendar wasn't allowed ("no-calendar").
 */

export type ConnectStart = { ok: true; url: string; verifier: string } | { ok: false; outcome: "not-configured" };

/** Where to send the browser to approve it, and the PKCE verifier to keep for the way back. */
export async function startConnect(provider: WorkplaceProvider, p: { redirectUri: string; state: string; email: string | null }): Promise<ConnectStart> {
  if (!(await mailProviders()).includes(provider)) return { ok: false, outcome: "not-configured" };
  const calendar = await calendarsWanted();
  const { verifier, challenge } = pkcePair();
  if (provider === "MICROSOFT") {
    const app = await microsoftApp();
    return app
      ? { ok: true, verifier, url: authorizeUrl(app, { redirectUri: p.redirectUri, state: p.state, challenge, loginHint: p.email, scope: microsoftScopes(calendar) }) }
      : { ok: false, outcome: "not-configured" };
  }
  if (provider === "GOOGLE") {
    const app = await googleApp();
    return app
      ? { ok: true, verifier, url: googleAuthorizeUrl(app, { redirectUri: p.redirectUri, state: p.state, challenge, loginHint: p.email, scope: googleScopes(calendar) }) }
      : { ok: false, outcome: "not-configured" };
  }
  const app = await zohoApp();
  return app ? { ok: true, verifier, url: zohoAuthorizeUrl(app, { redirectUri: p.redirectUri, state: p.state, scope: zohoScopes(calendar) }) } : { ok: false, outcome: "not-configured" };
}

/** "no-calendar": the mailbox is connected, but the calendar asked for with it wasn't allowed. */
export type ConnectOutcome = "connected" | "no-calendar" | "failed" | "no-permission" | "mismatch" | "not-configured" | "no-mailbox";

/** After the mailbox is kept: the calendar, if it was asked for and granted — or, if not, none. */
async function settleCalendar(userId: string, provider: WorkplaceProvider, granted: boolean, calendarId: string | null = null): Promise<"connected" | "no-calendar"> {
  if (granted) {
    await saveCalendarAccount(userId, provider, calendarId);
    return "connected";
  }
  await forgetCalendar(userId);
  return "no-calendar";
}

type Finish = {
  user: { id: string; email: string };
  code: string;
  verifier: string;
  redirectUri: string;
  /** Zoho only: the accounts server Zoho said the account is in (`accounts-server`). */
  accountsServer?: string | null;
};

/** The way back: the code exchanged, the mailbox checked, and only then kept. */
export async function finishConnect(provider: WorkplaceProvider, f: Finish): Promise<{ outcome: ConnectOutcome; mailbox?: string }> {
  if (!(await mailProviders()).includes(provider)) return { outcome: "not-configured" };
  const mine = accountAddress(f.user.email);
  const calendar = await calendarsWanted();

  if (provider === "MICROSOFT") {
    const app = await microsoftApp();
    if (!app) return { outcome: "not-configured" };
    const exchanged = await exchangeCode(app, { code: f.code, verifier: f.verifier, redirectUri: f.redirectUri, scope: microsoftScopes(calendar) });
    if (!exchanged.ok || !exchanged.tokens.refreshToken) return { outcome: "failed" };
    if (!/\bMail\.Send\b/i.test(exchanged.tokens.scope)) return { outcome: "no-permission" };
    const me = await fetchMe(exchanged.tokens.accessToken);
    if (!me) return { outcome: "failed" };
    const mailbox = mailboxFor(mine, me);
    if (!mailbox) return { outcome: "mismatch" };
    await saveConnection(f.user.id, mailbox, me.displayName, { ...exchanged.tokens, refreshToken: exchanged.tokens.refreshToken });
    if (!calendar) return { outcome: "connected", mailbox };
    return { outcome: await settleCalendar(f.user.id, "MICROSOFT", grantsCalendar(exchanged.tokens.scope)), mailbox };
  }

  if (provider === "GOOGLE") {
    const app = await googleApp();
    if (!app) return { outcome: "not-configured" };
    const exchanged = await googleExchangeCode(app, { code: f.code, verifier: f.verifier, redirectUri: f.redirectUri });
    if (!exchanged.ok || !exchanged.tokens.refreshToken) return { outcome: "failed" };
    if (!grantsGmailSend(exchanged.tokens.scope)) return { outcome: "no-permission" };
    const me = await fetchGoogleMe(exchanged.tokens.accessToken);
    if (!me) return { outcome: "failed" };
    // An address Google hasn't verified proves nothing; and a workspace kept to its own domain stays there.
    if (!me.email || !me.verified || accountAddress(me.email) !== mine) return { outcome: "mismatch" };
    if (app.domain && (me.hd ?? "").toLowerCase() !== app.domain) return { outcome: "mismatch" };
    await saveMailbox(f.user.id, "GOOGLE", { mailbox: me.email.trim(), displayName: me.name, tokens: { ...exchanged.tokens, refreshToken: exchanged.tokens.refreshToken } });
    if (!calendar) return { outcome: "connected", mailbox: me.email.trim() };
    return { outcome: await settleCalendar(f.user.id, "GOOGLE", grantsGoogleCalendar(exchanged.tokens.scope)), mailbox: me.email.trim() };
  }

  const app = await zohoApp();
  if (!app) return { outcome: "not-configured" };
  // Zoho names the data centre the account is in, and the code can only be spent there. It has to be
  // one of Zoho's own: the token request carries the company's client secret.
  const region = f.accountsServer ? regionOfAccountsServer(f.accountsServer) : app.region;
  if (!region) return { outcome: "failed" };
  const exchanged = await zohoExchangeCode(app, region, { code: f.code, redirectUri: f.redirectUri });
  if (!exchanged.ok || !exchanged.tokens.refreshToken) return { outcome: "failed" };
  const me = await fetchZohoMe(region, exchanged.tokens.accessToken);
  if (!me) return { outcome: "failed" };
  if (!me.email || accountAddress(me.email) !== mine) return { outcome: "mismatch" };
  const account = await zohoMailAccount(region, exchanged.tokens.accessToken, mine);
  if (!account) return { outcome: "no-mailbox" };
  await saveMailbox(f.user.id, "ZOHO", {
    mailbox: account.address,
    displayName: me.name,
    tokens: { ...exchanged.tokens, refreshToken: exchanged.tokens.refreshToken },
    zoho: { accountsServer: accountsServerOf(region), accountId: account.accountId },
  });
  if (!calendar) return { outcome: "connected", mailbox: account.address };
  // Zoho doesn't say what was granted: the calendar is there if its default calendar can be read.
  const found = await zohoDefaultCalendar(region, exchanged.tokens.accessToken);
  const calendarId = found.ok ? found.value : null;
  return { outcome: await settleCalendar(f.user.id, "ZOHO", !!calendarId, calendarId), mailbox: account.address };
}
