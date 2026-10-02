import MailComposer from "nodemailer/lib/mail-composer";
import type { GoogleApp } from "@/lib/workplace/settings";
import type { OutgoingMail, ProviderSend, TokenOutcome } from "@/lib/mail/types";

/**
 * Sending as a person from their own Gmail — Google Workspace, with the company's own Google app
 * (Settings → Security → Google Workspace; src/lib/workplace/settings.ts).
 *
 * Each person connects once from My profile, approving "send email on your behalf" for themselves;
 * what comes back is a refresh token for their mailbox alone, stored encrypted (src/lib/mail/mailbox.ts).
 * A message goes through the Gmail API as the whole message, so it lands in their Sent folder like any
 * mail they wrote.
 *
 * No SDK: two token calls, one profile call and one send are plain HTTPS, and every address can be
 * pointed at a local stand-in by a check script (check:workplace).
 */

export const GOOGLE_MAIL_SCOPES = "openid email profile https://www.googleapis.com/auth/gmail.send";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";

const LIVE = {
  accounts: "https://accounts.google.com",
  oauth2: "https://oauth2.googleapis.com",
  openid: "https://openidconnect.googleapis.com",
  gmail: "https://gmail.googleapis.com",
};
let endpoints = { ...LIVE };

/** For check scripts only: point every call at a local stand-in. */
export function setTestGoogleEndpoints(next: typeof LIVE | null) {
  endpoints = next ?? { ...LIVE };
}

export function googleAuthorizeUrl(app: GoogleApp, p: { redirectUri: string; state: string; challenge: string; loginHint?: string | null }): string {
  const url = new URL(`${endpoints.accounts}/o/oauth2/v2/auth`);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("scope", GOOGLE_MAIL_SCOPES);
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // A refresh token, every time — Google only hands one back on a consent it has just shown.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  if (app.domain) url.searchParams.set("hd", app.domain);
  if (p.loginHint) url.searchParams.set("login_hint", p.loginHint);
  return url.toString();
}

async function tokenRequest(app: GoogleApp, form: Record<string, string>): Promise<TokenOutcome> {
  let res: Response;
  try {
    res = await fetch(`${endpoints.oauth2}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...form }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "Google didn't answer. Try again in a minute.", revoked: false };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : "";
    // The stored consent is gone — revoked, a changed password, an account suspended. Connecting
    // again is the only thing that helps.
    const revoked = code === "invalid_grant";
    const said = typeof body.error_description === "string" ? body.error_description.slice(0, 200) : "";
    return { ok: false, error: said || `Google refused (${code || res.status}).`, revoked };
  }
  return {
    ok: true,
    tokens: {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      expiresAt: new Date(Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000),
      scope: typeof body.scope === "string" ? body.scope : "",
    },
  };
}

export function googleExchangeCode(app: GoogleApp, p: { code: string; verifier: string; redirectUri: string }) {
  return tokenRequest(app, { grant_type: "authorization_code", code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri });
}

export function googleRefresh(app: GoogleApp, refreshToken: string) {
  return tokenRequest(app, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Google lets a person untick a permission on its consent screen; sending needs this one. */
export function grantsGmailSend(scope: string): boolean {
  return scope.split(/\s+/).includes(GMAIL_SEND);
}

export type GoogleMe = { email: string | null; verified: boolean; name: string | null; hd: string | null };

export async function fetchGoogleMe(accessToken: string): Promise<GoogleMe | null> {
  try {
    const res = await fetch(`${endpoints.openid}/v1/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const me = (await res.json()) as Record<string, unknown>;
    return {
      email: typeof me.email === "string" ? me.email : null,
      verified: me.email_verified === true,
      name: typeof me.name === "string" ? me.name : null,
      hd: typeof me.hd === "string" ? me.hd : null,
    };
  } catch {
    return null;
  }
}

/** The whole message, as Gmail takes it: headers encoded for any language, the PDF attached. */
export async function rawMessage(from: { email: string; name: string | null }, mail: OutgoingMail): Promise<Buffer> {
  return new MailComposer({
    from: from.name ? { name: from.name, address: from.email } : from.email,
    to: mail.to.map((r) => (r.name ? { name: r.name, address: r.email } : r.email)),
    subject: mail.subject,
    html: mail.html,
    attachments: mail.attachments.map((a) => ({ filename: a.name, contentType: a.contentType, content: a.bytes })),
  })
    .compile()
    .build();
}

/** One send. A 401 is the caller's to retry with a fresh token. */
export async function sendWithGmail(accessToken: string, raw: Buffer): Promise<ProviderSend> {
  let res: Response;
  try {
    res = await fetch(`${endpoints.gmail}/upload/gmail/v1/users/me/messages/send?uploadType=media`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "message/rfc822" },
      body: new Uint8Array(raw),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return { ok: false, status: 0, error: "Gmail didn't answer. Nothing was sent — try again in a minute." };
  }
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return { ok: false, status: res.status, error: body.error?.message?.slice(0, 200) ?? `Gmail refused the message (${res.status}).` };
}
