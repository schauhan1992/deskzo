import { createSign } from "node:crypto";

/**
 * Gmail signatures through domain-wide delegation: the company makes a service account in its own
 * Google Cloud project and, in its Google Admin console, lets it act for the domain's people with the
 * one scope gmail.settings.basic. Deskzo signs a token for each person with the account's key and
 * updates their address's signature — the person does nothing, and can't be asked to forget.
 *
 * Plain fetch, no SDK. The hosts can be swapped for stand-ins (`setTestGoogleHosts`, check:signature-sync).
 */

export const GMAIL_SIGNATURE_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";

const LIVE = { token: "https://oauth2.googleapis.com/token", gmail: "https://gmail.googleapis.com" };
let hosts = LIVE;

export function setTestGoogleHosts(next: typeof LIVE | null) {
  hosts = next ?? LIVE;
}

export type ServiceAccount = { clientEmail: string; privateKey: string };

/** A service account's key file, as Google hands it out — checked, never trusted to be one. */
export function readServiceAccount(raw: string): ServiceAccount | { error: string } {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { error: "That isn't a key file. Paste the whole JSON file Google gave you when you made the key." };
  }
  if (json.type !== "service_account") return { error: "That key isn't a service account's. Make the key on a service account, in Google Cloud." };
  const clientEmail = typeof json.client_email === "string" ? json.client_email.trim() : "";
  const privateKey = typeof json.private_key === "string" ? json.private_key : "";
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(clientEmail)) return { error: "The key file has no service account address." };
  if (!privateKey.includes("BEGIN PRIVATE KEY")) return { error: "The key file has no private key in it." };
  return { clientEmail, privateKey };
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The signed request for a token that acts as `subject`, good for an hour. */
export function signAssertion(sa: ServiceAccount, subject: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.clientEmail, sub: subject, scope: GMAIL_SIGNATURE_SCOPE, aud: LIVE.token, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${b64url(signer.sign(sa.privateKey))}`;
}

export type GoogleOutcome = { ok: true } | { ok: false; error: string; /** Wrong for everybody — the connection, not the person. */ setup: boolean };

async function tokenFor(sa: ServiceAccount, subject: string): Promise<{ ok: true; token: string } | (GoogleOutcome & { ok: false })> {
  let assertion: string;
  try {
    assertion = signAssertion(sa, subject);
  } catch {
    return { ok: false, error: "The service account's private key couldn't be read. Make a new key and paste it again.", setup: true };
  }
  let res: Response;
  try {
    res = await fetch(hosts.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "Google didn't answer. It is tried again on its own.", setup: false };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok && typeof body.access_token === "string") return { ok: true, token: body.access_token };
  const code = typeof body.error === "string" ? body.error : "";
  const description = typeof body.error_description === "string" ? body.error_description : "";
  if (code === "unauthorized_client") {
    return { ok: false, error: "Google hasn't let this service account act for your domain. In the Admin console, add its client ID under Domain-wide delegation with the gmail.settings.basic scope.", setup: true };
  }
  if (code === "invalid_grant" && /email|user/i.test(description)) {
    return { ok: false, error: "Google Workspace has no such user — their Deskzo email isn't an address in your Google domain.", setup: false };
  }
  if (code === "invalid_grant") return { ok: false, error: "Google refused the service account's key. Make a new key and paste it again.", setup: true };
  return { ok: false, error: `Google refused (${code || res.status}).`, setup: false };
}

/** Put a signature on a person's own address in Gmail. */
export async function setGmailSignature(sa: ServiceAccount, email: string, html: string): Promise<GoogleOutcome> {
  const token = await tokenFor(sa, email);
  if (!token.ok) return token;
  const address = encodeURIComponent(email);
  let res: Response;
  try {
    res = await fetch(`${hosts.gmail}/gmail/v1/users/${address}/settings/sendAs/${address}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: JSON.stringify({ signature: html }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "Gmail didn't answer. It is tried again on its own.", setup: false };
  }
  if (res.ok) return { ok: true };
  if (res.status === 404) return { ok: false, error: "Gmail has no such address for this person.", setup: false };
  if (res.status === 403) return { ok: false, error: "Gmail refused — the delegation may be missing the gmail.settings.basic scope.", setup: true };
  return { ok: false, error: `Gmail refused (${res.status}).`, setup: false };
}

/** The connection, tried as one person (the administrator who set it up): a token, and their send-as list read. */
export async function checkGoogle(sa: ServiceAccount, email: string): Promise<GoogleOutcome> {
  const token = await tokenFor(sa, email);
  if (!token.ok) return token;
  try {
    const address = encodeURIComponent(email);
    const res = await fetch(`${hosts.gmail}/gmail/v1/users/${address}/settings/sendAs`, { headers: { authorization: `Bearer ${token.token}` }, signal: AbortSignal.timeout(20_000) });
    if (res.ok) return { ok: true };
    return { ok: false, error: res.status === 403 ? "Gmail refused — the delegation may be missing the gmail.settings.basic scope." : `Gmail refused (${res.status}).`, setup: true };
  } catch {
    return { ok: false, error: "Gmail didn't answer. Try again in a minute.", setup: false };
  }
}
