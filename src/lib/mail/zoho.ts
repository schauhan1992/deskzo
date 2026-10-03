import { ZOHO_REGIONS, type ZohoRegion } from "@/lib/workplace/providers";
import type { ZohoApp } from "@/lib/workplace/settings";
import type { OutgoingMail, ProviderSend, TokenOutcome } from "@/lib/mail/types";

/**
 * Sending as a person from their own Zoho Mail, with the company's own Zoho app (Settings → Security →
 * Zoho; src/lib/workplace/settings.ts).
 *
 * Zoho keeps each account in one data centre, and everything for it happens there: the sign-in code is
 * spent at that data centre's accounts server, and mail goes through its Zoho Mail. Zoho says which
 * one on the way back (`accounts-server`); the token request carries the company's client secret, so
 * it only ever goes to an accounts server Zoho has — never to an address a redirect merely names.
 *
 * Each person connects once from My profile. What is kept (src/lib/mail/mailbox.ts): the refresh token,
 * encrypted, the accounts server, and their Zoho Mail account id. A message is sent from that account,
 * so it lands in their Sent folder like any mail they wrote.
 *
 * No SDK: plain HTTPS, and every address can be pointed at a local stand-in by a check script
 * (check:workplace).
 */

export const ZOHO_MAIL_SCOPES = "ZohoMail.messages.CREATE,ZohoMail.accounts.READ,AaaServer.profile.Read";
/** Added when the workspace has Calendar on: the person's calendars, their events, and Zoho Meeting links. */
export const ZOHO_CALENDAR_SCOPES = "ZohoCalendar.calendar.READ,ZohoCalendar.event.ALL,ZohoMeeting.meeting.ALL";

export function zohoScopes(calendar: boolean): string {
  return calendar ? `${ZOHO_MAIL_SCOPES},${ZOHO_CALENDAR_SCOPES}` : ZOHO_MAIL_SCOPES;
}

type Hosts = { accounts: string; mail: string; calendar: string };
const live = (): Record<ZohoRegion, Hosts> =>
  Object.fromEntries(Object.entries(ZOHO_REGIONS).map(([k, v]) => [k, { accounts: v.accounts, mail: v.mail, calendar: v.calendar }])) as Record<ZohoRegion, Hosts>;
let regions = live();

/**
 * For check scripts only: point every data centre at a local stand-in. A data centre given no calendar
 * host has one beside its accounts host — "…/z-in-accounts" becomes "…/z-in-calendar".
 */
export function setTestZohoRegions(next: Record<ZohoRegion, Omit<Hosts, "calendar"> & { calendar?: string }> | null) {
  regions = next
    ? (Object.fromEntries(
        Object.entries(next).map(([k, h]) => [k, { ...h, calendar: h.calendar ?? h.accounts.replace(/accounts(?!.*accounts)/, "calendar") }]),
      ) as Record<ZohoRegion, Hosts>)
    : live();
}

/** Zoho Calendar's address in a data centre, for src/lib/calendar/zoho.ts. */
export function zohoCalendarBase(region: ZohoRegion): string {
  return regions[region].calendar;
}

/** The data centre whose accounts server this is — only one of Zoho's own. */
export function regionOfAccountsServer(server: string | null | undefined): ZohoRegion | null {
  if (!server) return null;
  const wanted = server.replace(/\/+$/, "").toLowerCase();
  for (const [key, hosts] of Object.entries(regions) as [ZohoRegion, Hosts][]) {
    if (hosts.accounts.toLowerCase() === wanted) return key;
  }
  return null;
}

export function accountsServerOf(region: ZohoRegion): string {
  return regions[region].accounts;
}

export function zohoAuthorizeUrl(app: ZohoApp, p: { redirectUri: string; state: string; scope?: string }): string {
  const url = new URL(`${regions[app.region].accounts}/oauth/v2/auth`);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("scope", p.scope ?? ZOHO_MAIL_SCOPES);
  url.searchParams.set("state", p.state);
  // A refresh token, every time — Zoho gives one only for offline access on a consent it has just shown.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function tokenRequest(app: ZohoApp, region: ZohoRegion, form: Record<string, string>): Promise<TokenOutcome> {
  let res: Response;
  try {
    res = await fetch(`${regions[region].accounts}/oauth/v2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...form }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "Zoho didn't answer. Try again in a minute.", revoked: false };
  }
  // Zoho answers some refusals with a 200 and an `error` field.
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : "";
    // The stored grant is gone — revoked, or the account closed. Connecting again is what helps.
    const revoked = code === "invalid_code" || code === "access_denied";
    return { ok: false, error: `Zoho refused (${code || res.status}).`, revoked };
  }
  return {
    ok: true,
    tokens: {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      expiresAt: new Date(Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000),
      scope: typeof body.scope === "string" ? body.scope : ZOHO_MAIL_SCOPES,
    },
  };
}

export function zohoExchangeCode(app: ZohoApp, region: ZohoRegion, p: { code: string; redirectUri: string }) {
  return tokenRequest(app, region, { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri });
}

export function zohoRefresh(app: ZohoApp, region: ZohoRegion, refreshToken: string) {
  return tokenRequest(app, region, { grant_type: "refresh_token", refresh_token: refreshToken });
}

const zohoAuth = (token: string) => ({ authorization: `Zoho-oauthtoken ${token}` });

export type ZohoMe = { email: string | null; name: string | null };

export async function fetchZohoMe(region: ZohoRegion, accessToken: string): Promise<ZohoMe | null> {
  try {
    const res = await fetch(`${regions[region].accounts}/oauth/user/info`, { headers: zohoAuth(accessToken), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const me = (await res.json()) as Record<string, unknown>;
    const name = typeof me.Display_Name === "string" ? me.Display_Name : [me.First_Name, me.Last_Name].filter((x) => typeof x === "string").join(" ") || null;
    return { email: typeof me.Email === "string" ? me.Email : null, name };
  } catch {
    return null;
  }
}

/**
 * The person's Zoho Mail account whose address is the one on their account here — the account id
 * every send names, and the address it goes from. Null when they have none with that address.
 */
export async function zohoMailAccount(region: ZohoRegion, accessToken: string, email: string): Promise<{ accountId: string; address: string } | null> {
  try {
    const res = await fetch(`${regions[region].mail}/api/accounts`, { headers: zohoAuth(accessToken), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown };
    const wanted = email.trim().toLowerCase();
    for (const account of Array.isArray(body.data) ? body.data : []) {
      const a = account as { accountId?: unknown; primaryEmailAddress?: unknown; emailAddress?: { mailId?: unknown }[] };
      const addresses = [a.primaryEmailAddress, ...(Array.isArray(a.emailAddress) ? a.emailAddress.map((e) => e?.mailId) : [])];
      const match = addresses.find((x): x is string => typeof x === "string" && x.trim().toLowerCase() === wanted);
      if (match && (typeof a.accountId === "string" || typeof a.accountId === "number")) return { accountId: String(a.accountId), address: match.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

function zohoError(body: unknown, status: number, what: string): string {
  const s = (body as { status?: { description?: unknown }; data?: { moreInfo?: unknown } } | null) ?? null;
  const said = typeof s?.data?.moreInfo === "string" ? s.data.moreInfo : typeof s?.status?.description === "string" ? s.status.description : "";
  return said ? `${what}: ${said.slice(0, 200)}` : `${what} (${status}).`;
}

/** One send: each attachment uploaded to the account first, then the message naming them. A 401 is the caller's to retry. */
export async function sendWithZoho(region: ZohoRegion, accessToken: string, account: { accountId: string; address: string }, mail: OutgoingMail): Promise<ProviderSend> {
  const base = `${regions[region].mail}/api/accounts/${encodeURIComponent(account.accountId)}/messages`;
  try {
    const attachments: { storeName: string; attachmentPath: string; attachmentName: string }[] = [];
    for (const a of mail.attachments) {
      const form = new FormData();
      form.append("attach", new Blob([new Uint8Array(a.bytes)], { type: a.contentType }), a.name);
      const up = await fetch(`${base}/attachments?uploadType=multipart`, { method: "POST", headers: zohoAuth(accessToken), body: form, signal: AbortSignal.timeout(60_000) });
      const upBody = (await up.json().catch(() => null)) as { data?: unknown } | null;
      if (!up.ok) return { ok: false, status: up.status, error: zohoError(upBody, up.status, "Zoho Mail refused the attachment") };
      const stored = (Array.isArray(upBody?.data) ? upBody.data[0] : upBody?.data) as Record<string, unknown> | undefined;
      if (!stored || typeof stored.storeName !== "string" || typeof stored.attachmentPath !== "string") {
        return { ok: false, status: up.status, error: "Zoho Mail didn't keep the attachment. Nothing was sent." };
      }
      attachments.push({ storeName: stored.storeName, attachmentPath: stored.attachmentPath, attachmentName: typeof stored.attachmentName === "string" ? stored.attachmentName : a.name });
    }
    const res = await fetch(base, {
      method: "POST",
      headers: { ...zohoAuth(accessToken), "content-type": "application/json" },
      body: JSON.stringify({
        fromAddress: account.address,
        toAddress: mail.to.map((r) => r.email).join(","),
        subject: mail.subject,
        content: mail.html,
        mailFormat: "html",
        ...(attachments.length ? { attachments } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, error: zohoError(await res.json().catch(() => null), res.status, "Zoho Mail refused the message") };
  } catch {
    return { ok: false, status: 0, error: "Zoho Mail didn't answer. Nothing was sent — try again in a minute." };
  }
}
