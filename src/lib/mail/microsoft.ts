import { createHash, randomBytes } from "crypto";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getCachedSecuritySettings } from "@/lib/security-settings";

/**
 * Sending as a person, from their own Microsoft 365 mailbox — Microsoft Graph, delegated.
 *
 * Each person connects once (My profile → Outlook), approving `Mail.Send` for themselves. What comes
 * back is a refresh token for *their* mailbox only; it is stored encrypted and used to send the
 * documents they email from here, which then sit in their Sent Items like any mail they wrote. The
 * ERP can never send as anybody who has not connected, and never as anybody but the person connected.
 *
 * The Microsoft app is the one already set up for sign-in (Settings → Security): same tenant, same
 * client id and secret. IT adds the delegated `Mail.Send` permission to it and the redirect address
 * below; nothing else changes.
 *
 * No SDK: three token calls and two Graph calls are plain HTTPS, and every one of them can be pointed
 * at a local stand-in by a check script, which is how the suite tests this without Microsoft.
 */

export const MAIL_SCOPES = "offline_access User.Read Mail.Send";
export const CALLBACK_PATH = "/api/mail/microsoft/callback";
export const CONNECT_PATH = "/api/mail/microsoft/connect";

let endpoints = { login: "https://login.microsoftonline.com", graph: "https://graph.microsoft.com" };

/** For check scripts only: point every call at a local stand-in. */
export function setTestMicrosoftEndpoints(next: { login: string; graph: string } | null) {
  endpoints = next ?? { login: "https://login.microsoftonline.com", graph: "https://graph.microsoft.com" };
}

export type MicrosoftApp = { tenantId: string; clientId: string; clientSecret: string };

/** The sign-in app's settings, or null while they are incomplete. */
export async function microsoftApp(): Promise<MicrosoftApp | null> {
  const s = await getCachedSecuritySettings();
  if (!s?.microsoftTenantId || !s.microsoftClientId || !s.microsoftClientSecretCipher) return null;
  try {
    return { tenantId: s.microsoftTenantId, clientId: s.microsoftClientId, clientSecret: decryptSecret(s.microsoftClientSecretCipher) };
  } catch {
    // A secret encrypted under a different AUTH_SECRET — as good as none.
    return null;
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(app: MicrosoftApp, p: { redirectUri: string; state: string; challenge: string; loginHint?: string | null }): string {
  const url = new URL(`${endpoints.login}/${encodeURIComponent(app.tenantId)}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MAIL_SCOPES);
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Straight to the right account, but still asking — somebody signed in to a personal account in
  // the same browser must not connect that one by accident.
  url.searchParams.set("prompt", "select_account");
  if (p.loginHint) url.searchParams.set("login_hint", p.loginHint);
  return url.toString();
}

type TokenSet = { accessToken: string; refreshToken: string | null; expiresAt: Date; scope: string };
type TokenFailure = { ok: false; error: string; revoked: boolean };

async function tokenRequest(app: MicrosoftApp, form: Record<string, string>): Promise<{ ok: true; tokens: TokenSet } | TokenFailure> {
  let res: Response;
  try {
    res = await fetch(`${endpoints.login}/${encodeURIComponent(app.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, scope: MAIL_SCOPES, ...form }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "Microsoft didn't answer. Try again in a minute.", revoked: false };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : "";
    // These mean the stored consent is gone — a changed password, a revoked grant, a disabled
    // account. Retrying will not help; connecting again will.
    const revoked = code === "invalid_grant" || code === "interaction_required" || code === "consent_required";
    const said = typeof body.error_description === "string" ? body.error_description.split("\r\n")[0].slice(0, 200) : "";
    return { ok: false, error: said || `Microsoft refused (${code || res.status}).`, revoked };
  }
  return {
    ok: true,
    tokens: {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      expiresAt: new Date(Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000),
      scope: typeof body.scope === "string" ? body.scope : MAIL_SCOPES,
    },
  };
}

export function exchangeCode(app: MicrosoftApp, p: { code: string; verifier: string; redirectUri: string }) {
  return tokenRequest(app, { grant_type: "authorization_code", code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri });
}

export type GraphMe = { mail: string | null; userPrincipalName: string | null; displayName: string | null };

export async function fetchMe(accessToken: string): Promise<GraphMe | null> {
  try {
    const res = await fetch(`${endpoints.graph}/v1.0/me?$select=mail,userPrincipalName,displayName`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const me = (await res.json()) as Partial<GraphMe>;
    return { mail: me.mail ?? null, userPrincipalName: me.userPrincipalName ?? null, displayName: me.displayName ?? null };
  } catch {
    return null;
  }
}

/**
 * The mailbox this person may connect: the one whose address is on their account here. Either the
 * mail address or the sign-in name may carry it — they differ in plenty of tenants.
 */
export function mailboxFor(userEmail: string, me: GraphMe): string | null {
  const mine = userEmail.trim().toLowerCase();
  for (const candidate of [me.mail, me.userPrincipalName]) {
    if (candidate && candidate.trim().toLowerCase() === mine) return candidate.trim();
  }
  return null;
}

export async function saveConnection(userId: string, mailbox: string, displayName: string | null, tokens: TokenSet & { refreshToken: string }) {
  const data = {
    mailbox,
    displayName,
    refreshTokenCipher: encryptSecret(tokens.refreshToken),
    accessTokenCipher: encryptSecret(tokens.accessToken),
    accessTokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scope,
    brokenAt: null,
    lastError: null,
  };
  await db.mailConnection.upsert({
    where: { userId },
    create: { userId, ...data },
    update: { ...data, connectedAt: new Date() },
  });
}

// ─── Sending ─────────────────────────────────────────────────────────────────────────────────────

export type OutgoingMail = {
  subject: string;
  html: string;
  to: { name: string | null; email: string }[];
  attachments: { name: string; contentType: string; bytes: Buffer }[];
};

export type SendOutcome = { ok: true; mailbox: string } | { ok: false; error: string; reconnect: boolean };

async function markBroken(userId: string, error: string) {
  await db.mailConnection.update({ where: { userId }, data: { brokenAt: new Date(), lastError: error.slice(0, 300) } });
}

/** A usable access token, refreshing — and storing the new refresh token Microsoft rotates in — when due. */
async function accessTokenFor(userId: string, force = false): Promise<{ ok: true; token: string; mailbox: string } | { ok: false; error: string; reconnect: boolean }> {
  const connection = await db.mailConnection.findUnique({ where: { userId } });
  if (!connection) return { ok: false, error: "Connect your Outlook first — My profile → Outlook mailbox.", reconnect: true };
  if (connection.brokenAt) return { ok: false, error: "Microsoft stopped accepting your Outlook connection. Connect it again from My profile.", reconnect: true };

  const fresh = connection.accessTokenCipher && connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() > Date.now() + 60_000;
  if (fresh && !force) {
    try {
      return { ok: true, token: decryptSecret(connection.accessTokenCipher!), mailbox: connection.mailbox };
    } catch {
      /* fall through to a refresh */
    }
  }

  const app = await microsoftApp();
  if (!app) return { ok: false, error: "The Microsoft app isn't set up any more (Settings → Security). Ask an admin.", reconnect: false };
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(connection.refreshTokenCipher);
  } catch {
    await markBroken(userId, "The stored token could not be read.");
    return { ok: false, error: "Your Outlook connection can't be read any more. Connect it again from My profile.", reconnect: true };
  }
  const refreshed = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: refreshToken });
  if (!refreshed.ok) {
    if (refreshed.revoked) {
      await markBroken(userId, refreshed.error);
      return { ok: false, error: "Microsoft stopped accepting your Outlook connection. Connect it again from My profile.", reconnect: true };
    }
    return { ok: false, error: refreshed.error, reconnect: false };
  }
  await db.mailConnection.update({
    where: { userId },
    data: {
      accessTokenCipher: encryptSecret(refreshed.tokens.accessToken),
      accessTokenExpiresAt: refreshed.tokens.expiresAt,
      // Microsoft usually hands back a new refresh token; the old one keeps working for a while, but
      // the newest is the one to keep.
      ...(refreshed.tokens.refreshToken ? { refreshTokenCipher: encryptSecret(refreshed.tokens.refreshToken) } : {}),
    },
  });
  return { ok: true, token: refreshed.tokens.accessToken, mailbox: connection.mailbox };
}

export async function sendAsUser(userId: string, mail: OutgoingMail): Promise<SendOutcome> {
  const payload = JSON.stringify({
    message: {
      subject: mail.subject,
      body: { contentType: "HTML", content: mail.html },
      toRecipients: mail.to.map((r) => ({ emailAddress: { address: r.email, ...(r.name ? { name: r.name } : {}) } })),
      attachments: mail.attachments.map((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.name,
        contentType: a.contentType,
        contentBytes: a.bytes.toString("base64"),
      })),
    },
    saveToSentItems: true,
  });

  for (const force of [false, true]) {
    const access = await accessTokenFor(userId, force);
    if (!access.ok) return access;
    let res: Response;
    try {
      res = await fetch(`${endpoints.graph}/v1.0/me/sendMail`, {
        method: "POST",
        headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      return { ok: false, error: "Outlook didn't answer. Nothing was sent — try again in a minute.", reconnect: false };
    }
    if (res.status === 202 || res.ok) {
      await db.mailConnection.update({ where: { userId }, data: { lastUsedAt: new Date(), lastError: null } });
      return { ok: true, mailbox: access.mailbox };
    }
    // An access token Microsoft has stopped honouring early: one fresh token, one more try.
    if (res.status === 401 && !force) continue;
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const said = body.error?.message?.slice(0, 200) ?? `Outlook refused the message (${res.status}).`;
    await db.mailConnection.update({ where: { userId }, data: { lastError: said } });
    return { ok: false, error: said, reconnect: res.status === 401 || res.status === 403 };
  }
  return { ok: false, error: "Outlook kept refusing the connection. Connect it again from My profile.", reconnect: true };
}
