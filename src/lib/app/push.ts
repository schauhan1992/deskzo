import { createSign } from "node:crypto";
import { db } from "@/lib/db";

/**
 * Pushes to the Deskzo app (owner, 18 Oct 2026), through Firebase Cloud Messaging's HTTP v1 API — plain
 * fetch, no SDK. One Firebase project is Deskzo's, for every workspace: its service account is the
 * platform's, in `DESKZO_APP_FCM_SERVICE_ACCOUNT` (the JSON Google gives, as it is or base64). Without it
 * nothing is pushed, and a phone picks up what it was asked to dial the next time the app looks
 * (/api/app/calls/requests) — at once while it is open.
 *
 * A push carries only an id and what the phone shows — never the record behind it.
 */

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

function serviceAccount(): ServiceAccount | null {
  const raw = process.env.DESKZO_APP_FCM_SERVICE_ACCOUNT?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")) as Partial<ServiceAccount>;
    return parsed.project_id && parsed.client_email && parsed.private_key ? (parsed as ServiceAccount) : null;
  } catch {
    return null;
  }
}

export const pushConfigured = () => serviceAccount() !== null;

/** Google's access token for the service account — the platform's, for every workspace. */
let accessToken: { value: string; until: number } | null = null;
/** A stand-in for Firebase, set only by check scripts: the message, and the HTTP status Firebase would answer. */
let testSend: ((message: unknown) => Promise<number>) | null = null;

export function setTestPush(send: ((message: unknown) => Promise<number>) | null) {
  testSend = send;
}

async function googleToken(account: ServiceAccount): Promise<string> {
  if (accessToken && accessToken.until > Date.now() + 60_000) return accessToken.value;
  const now = Math.floor(Date.now() / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(account.private_key).toString("base64url")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Google answered ${res.status} for the push token`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  accessToken = { value: json.access_token, until: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

/**
 * A data message to one phone, delivered at once (high priority; dropped after two minutes unless `ttlSeconds` says
 * otherwise — a ring is no use later, a notice is): "sent";
 * "gone" when the address no longer reaches the app (uninstalled, or another Firebase project's) and should
 * be forgotten; "failed"; or "off" when pushes aren't set up here.
 */
export async function pushToPhone(pushToken: string, data: Record<string, string>, ttlSeconds = 120): Promise<"sent" | "gone" | "failed" | "off"> {
  const message = { message: { token: pushToken, data, android: { priority: "HIGH", ttl: `${ttlSeconds}s` } } };
  const verdict = (status: number) => (status >= 200 && status < 300 ? "sent" : status === 404 || status === 403 ? "gone" : "failed");
  if (testSend) return verdict(await testSend(message));
  const account = serviceAccount();
  if (!account) return "off";
  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${await googleToken(account)}`, "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    });
    return verdict(res.status);
  } catch (err) {
    console.error("[app] push failed", err);
    return "failed";
  }
}

/**
 * A Deskzo notification on the person's phones too (owner, 22 Oct 2026 — push in the native app's first phase):
 * a lead given to them, something waiting for their decision, a task, a ticket's reply — whatever their bell
 * says. Only its title and where it leads go, never what's behind it; the phone opens the record through
 * /api/app as anywhere else, so the person's access still decides. To each of their approved phones with a push
 * address; an address Firebase no longer knows is forgotten. Nothing goes while pushes aren't set up here.
 */
export async function pushNoticeToPhones(userId: string, notice: { id: string; type: string; title: string; link: string | null }): Promise<number> {
  if (!testSend && !pushConfigured()) return 0;
  const phones = await db.appDevice.findMany({ where: { userId, pushToken: { not: null }, device: { status: "APPROVED" } }, select: { id: true, pushToken: true } });
  let sent = 0;
  for (const phone of phones) {
    // Kept for a phone that's off for a while — six hours — not the two minutes a ring is.
    const verdict = await pushToPhone(phone.pushToken!, { type: "notice", notice: notice.id, kind: notice.type, title: notice.title.slice(0, 160), link: notice.link ?? "" }, 6 * 3600);
    if (verdict === "sent") sent += 1;
    if (verdict === "gone") await db.appDevice.update({ where: { id: phone.id }, data: { pushToken: null } }).catch(() => {});
  }
  return sent;
}
