import { createPrivateKey, createSign, sign, type KeyObject } from "node:crypto";
import http2 from "node:http2";
import { db } from "@/lib/db";

/**
 * Pushes to the Deskzo app (owner, 18 Oct 2026), through Firebase Cloud Messaging's HTTP v1 API — plain
 * fetch, no SDK. One Firebase project is Deskzo's, for every workspace: its service account is the
 * platform's, in `DESKZO_APP_FCM_SERVICE_ACCOUNT` (the JSON Google gives, as it is or base64). Without it
 * nothing is pushed, and a phone picks up what it was asked to dial the next time the app looks
 * (/api/app/calls/requests) — at once while it is open.
 *
 * An iPhone is pushed to through Apple's own service, APNs (owner, 22 Oct 2026): the platform's signing key,
 * in `DESKZO_APP_APNS_KEY`, and an alert the iPhone shows itself — iOS wakes no app to a silent message
 * the way Android does. `pushToDevice` picks the road by the phone's platform; Android's stays as it was.
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

/** What Apple answered: its HTTP status, and the reason it gave for a refusal ("BadDeviceToken", "Unregistered" …). */
export type ApnsAnswer = { status: number; reason?: string };

/** Google's access token for the service account — the platform's, for every workspace. */
let accessToken: { value: string; until: number } | null = null;
/**
 * A stand-in for Firebase and Apple, set only by check scripts: the message — `{ message }` for Firebase,
 * `{ apns: { host, token, headers, payload } }` for Apple, once per host tried — and the HTTP status the
 * service would answer, or for Apple a status with its reason.
 */
let testSend: ((message: unknown) => Promise<number | ApnsAnswer>) | null = null;

export function setTestPush(send: ((message: unknown) => Promise<number | ApnsAnswer>) | null) {
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

/** The channel the app's notifications arrive on (mobile/src/lib/push.ts). */
const APP_CHANNEL = "deskzo";

type PushOptions = {
  /** Dropped after this long undelivered — two minutes unless said: a ring is no use later, a notice is. */
  ttlSeconds?: number;
  /**
   * What the phone shows by itself, even with the app closed (the app's `deskzo` channel); without it, a data
   * message only the open app reads.
   */
  shown?: { title: string; body?: string };
  /** One shown with the same tag replaces the last — a new ring the one before it. */
  tag?: string;
};

/**
 * A message to one phone, delivered at once (high priority): "sent"; "gone" when the address no longer reaches the
 * app (uninstalled, or another Firebase project's) and should be forgotten; "failed"; or "off" when pushes aren't
 * set up here.
 */
export async function pushToPhone(pushToken: string, data: Record<string, string>, options: PushOptions = {}): Promise<"sent" | "gone" | "failed" | "off"> {
  const { ttlSeconds = 120, shown, tag } = options;
  const message = {
    message: {
      token: pushToken,
      data,
      ...(shown ? { notification: { title: shown.title, ...(shown.body ? { body: shown.body } : {}) } } : {}),
      android: {
        priority: "HIGH",
        ttl: `${ttlSeconds}s`,
        ...(shown ? { notification: { channel_id: APP_CHANNEL, ...(tag ? { tag } : {}) } } : {}),
      },
    },
  };
  const verdict = (status: number) => (status >= 200 && status < 300 ? "sent" : status === 404 || status === 403 ? "gone" : "failed");
  if (testSend) {
    const answer = await testSend(message);
    return verdict(typeof answer === "number" ? answer : answer.status);
  }
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

// ─── iPhones: APNs ────────────────────────────────────────────────────────────

/**
 * Deskzo's APNs signing key, in `DESKZO_APP_APNS_KEY` — `{ key_id, team_id, private_key, topic? }`, as it is or
 * base64, as the Firebase account is read. The .p8 key Apple gives once, from Certificates, IDs & Profiles ›
 * Keys with APNs on; `topic` is the app's bundle id. Read once for each value the variable holds; unset, or
 * anything that isn't such a key, and iPhones aren't pushed to.
 */
type ApnsKey = { keyId: string; teamId: string; privateKey: KeyObject; topic: string };

const APNS_TOPIC = "com.deskzo.app";
const APNS_PRODUCTION = "api.push.apple.com";
/** Where a development build's token belongs — Xcode's, or a build made with the development entitlement. */
const APNS_SANDBOX = "api.sandbox.push.apple.com";
const APNS_TIMEOUT_MS = 10_000;
/**
 * Apple refuses a provider token older than an hour, and one refreshed more often than every twenty minutes
 * (TooManyProviderTokenUpdates): each is used for fifty.
 */
const PROVIDER_TOKEN_MS = 50 * 60_000;

let keyRead: { raw: string; key: ApnsKey | null } | null = null;

function apnsKey(): ApnsKey | null {
  const raw = process.env.DESKZO_APP_APNS_KEY?.trim() ?? "";
  if (keyRead?.raw === raw) return keyRead.key;
  let key: ApnsKey | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
      const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
      // A key pasted with its line breaks written out as \n.
      const pem = text(parsed.private_key).replace(/\\n/g, "\n");
      const privateKey = pem ? createPrivateKey(pem) : null;
      if (text(parsed.key_id) && text(parsed.team_id) && privateKey?.asymmetricKeyType === "ec") {
        key = { keyId: text(parsed.key_id), teamId: text(parsed.team_id), privateKey, topic: text(parsed.topic) || APNS_TOPIC };
      }
    } catch {
      key = null;
    }
  }
  keyRead = { raw, key };
  return key;
}

export const apnsConfigured = () => apnsKey() !== null;

let providerToken: { value: string; key: string; at: number } | null = null;

/**
 * The provider token APNs is called with: a JWT signed ES256 with Deskzo's key — `{ alg, kid }` and
 * `{ iss: the team, iat }` — kept and used again for fifty minutes. Null when APNs is off here.
 */
export function apnsProviderToken(now = Date.now()): string | null {
  const key = apnsKey();
  if (!key) return null;
  const which = `${key.teamId}|${key.keyId}`;
  if (providerToken && providerToken.key === which && now >= providerToken.at && now - providerToken.at < PROVIDER_TOKEN_MS) return providerToken.value;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ alg: "ES256", kid: key.keyId })}.${part({ iss: key.teamId, iat: Math.floor(now / 1000) })}`;
  // A JWT's ES256 signature is the bare r and s, not the DER Node gives by default.
  const signature = sign("sha256", Buffer.from(unsigned), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  providerToken = { value: `${unsigned}.${signature.toString("base64url")}`, key: which, at: now };
  return providerToken.value;
}

/**
 * One HTTP/2 connection to each of Apple's hosts, kept open between pushes as Apple asks — Node's fetch doesn't
 * speak HTTP/2, which APNs requires. It holds the process open only while a push is on its way, and closes
 * after five quiet minutes; one Apple has closed, or that failed, is opened afresh next time.
 */
const sessions = new Map<string, http2.ClientHttp2Session>();
const busy = new WeakMap<http2.ClientHttp2Session, number>();

function sessionFor(host: string): http2.ClientHttp2Session {
  const open = sessions.get(host);
  if (open && !open.closed && !open.destroyed) return open;
  const session = http2.connect(`https://${host}`);
  const forget = () => {
    if (sessions.get(host) === session) sessions.delete(host);
  };
  session.on("error", (err) => {
    console.error("[app] APNs connection failed", err);
    forget();
  });
  session.on("goaway", forget);
  session.on("close", forget);
  session.setTimeout(5 * 60_000, () => session.close());
  session.unref();
  sessions.set(host, session);
  return session;
}

function hold(session: http2.ClientHttp2Session, by: 1 | -1) {
  const count = Math.max(0, (busy.get(session) ?? 0) + by);
  busy.set(session, count);
  if (session.destroyed) return;
  if (count > 0) session.ref();
  else session.unref();
}

type ApnsMessage = { host: string; token: string; headers: Record<string, string>; payload: Record<string, unknown> };

/** One push to one host: Apple's status and reason, or status 0 for no answer within ten seconds. Never throws. */
function deliver(message: ApnsMessage, bearer: string): Promise<ApnsAnswer> {
  return new Promise((resolve) => {
    let session: http2.ClientHttp2Session | null = null;
    let stream: http2.ClientHttp2Stream | null = null;
    let settled = false;
    let status = 0;
    const chunks: Buffer[] = [];
    const finish = (answer: ApnsAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (session) hold(session, -1);
      resolve(answer);
    };
    const timer = setTimeout(() => {
      stream?.close(http2.constants.NGHTTP2_CANCEL);
      finish({ status: 0, reason: "timeout" });
    }, APNS_TIMEOUT_MS);
    try {
      session = sessionFor(message.host);
      hold(session, 1);
      stream = session.request({
        ":method": "POST",
        ":path": `/3/device/${encodeURIComponent(message.token)}`,
        authorization: `bearer ${bearer}`,
        "content-type": "application/json",
        ...message.headers,
      });
      stream.on("response", (headers) => {
        status = Number(headers[":status"]) || 0;
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", (err) => {
        console.error("[app] APNs push failed", err);
        finish({ status: 0, reason: "network" });
      });
      stream.on("close", () => {
        let reason: string | undefined;
        try {
          reason = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: string }).reason;
        } catch {
          reason = undefined;
        }
        finish({ status, reason });
      });
      stream.end(JSON.stringify(message.payload));
    } catch (err) {
      console.error("[app] APNs push failed", err);
      finish({ status: 0, reason: "network" });
    }
  });
}

/**
 * What a phone is sent (owner, 22 Oct 2026): what the app routes on, and what the phone shows by itself — on Android,
 * through Firebase on the app's own channel; on an iPhone, as Apple's alert.
 */
export type PhonePush = {
  /** Ids and where it leads — never the record behind them. On Android the message's data; on an iPhone, the payload's `body`. */
  data: Record<string, string>;
  /** What the phone shows, even with the app closed. */
  title: string;
  body?: string;
  /** Dropped after this long undelivered — two minutes unless said: a ring is no use later, a notice is. */
  ttlSeconds?: number;
  /** One with the same group replaces the last still showing — a new ring the one before it, a chat's latest message. */
  group?: string;
  /** Shown together on an iPhone: a chat's messages. */
  thread?: string;
  /** The iPhone's buttons for it: "deskzo-call" offers Call. */
  category?: string;
};

/**
 * An alert to one iPhone: "sent"; "gone" when Apple says the token no longer reaches the app (410), or knows
 * it on neither its production nor its sandbox host; "failed" for anything else — no answer in ten seconds
 * included; "off" when APNs isn't set up here. A token Apple doesn't know on production is tried once on
 * the sandbox, where a development build's belongs.
 */
export async function pushToIphone(pushToken: string, push: PhonePush): Promise<"sent" | "gone" | "failed" | "off"> {
  const key = apnsKey();
  if (!testSend && !key) return "off";
  const headers: Record<string, string> = {
    "apns-topic": key?.topic ?? APNS_TOPIC,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(Date.now() / 1000) + (push.ttlSeconds ?? 120)),
    ...(push.group ? { "apns-collapse-id": push.group.slice(0, 64) } : {}),
  };
  // What the app routes on goes under `body`: expo-notifications reads a remote notification's data from that key
  // alone (its iOS NotificationRecords.swift, `userInfo["body"]`) — not to be confused with `aps.alert.body`, the text shown.
  const payload = {
    aps: {
      alert: { title: push.title, ...(push.body ? { body: push.body } : {}) },
      sound: "default",
      ...(push.category ? { category: push.category } : {}),
      ...(push.thread ? { "thread-id": push.thread } : {}),
    },
    body: { ...push.data },
  };
  try {
    for (const host of [APNS_PRODUCTION, APNS_SANDBOX]) {
      const message: ApnsMessage = { host, token: pushToken, headers, payload };
      let answer: ApnsAnswer;
      if (testSend) {
        const said = await testSend({ apns: message });
        answer = typeof said === "number" ? { status: said } : said;
      } else {
        const bearer = apnsProviderToken();
        if (!bearer) return "off";
        answer = await deliver(message, bearer);
        // A token Apple calls expired is made again on the next push, not used for the rest of the fifty minutes.
        if (answer.status === 403 && answer.reason === "ExpiredProviderToken") providerToken = null;
      }
      if (answer.status >= 200 && answer.status < 300) return "sent";
      if (answer.status === 410) return "gone";
      if (answer.status === 400 && answer.reason === "BadDeviceToken" && host === APNS_PRODUCTION) continue;
      return answer.status === 400 && answer.reason === "BadDeviceToken" ? "gone" : "failed";
    }
    return "failed";
  } catch (err) {
    console.error("[app] APNs push failed", err);
    return "failed";
  }
}

/**
 * A push to one phone, by its platform: an iPhone through APNs; an Android phone through Firebase, shown on the app's
 * channel with the group as its tag — the same message as before iPhones were pushed to.
 */
export async function pushToDevice(phone: { platform: string; pushToken: string }, push: PhonePush): Promise<"sent" | "gone" | "failed" | "off"> {
  if (phone.platform === "ios") return pushToIphone(phone.pushToken, push);
  return pushToPhone(phone.pushToken, push.data, { ttlSeconds: push.ttlSeconds, shown: { title: push.title, ...(push.body ? { body: push.body } : {}) }, ...(push.group ? { tag: push.group } : {}) });
}

/** Pushes to these phones, each its own way; a push address the phone's service no longer knows is forgotten. */
async function pushToPhones(phones: { id: string; platform: string; pushToken: string | null }[], push: PhonePush): Promise<number> {
  const verdicts = await Promise.all(
    phones.map(async (phone) => {
      const verdict = await pushToDevice({ platform: phone.platform, pushToken: phone.pushToken! }, push);
      // Only the address that was refused: one the phone sent since is kept.
      if (verdict === "gone") await db.appDevice.updateMany({ where: { id: phone.id, pushToken: phone.pushToken }, data: { pushToken: null } }).catch(() => {});
      return verdict;
    }),
  );
  return verdicts.filter((v) => v === "sent").length;
}

/** Whether anything can be pushed here: Firebase for Android phones, APNs for iPhones, or a check's stand-in. */
const anyPush = () => !!testSend || pushConfigured() || apnsConfigured();

/**
 * A Deskzo notification on the person's phones too (owner, 22 Oct 2026 — push in the native app's first phase):
 * a lead given to them, something waiting for their decision, a task, a ticket's reply — whatever their bell
 * says. Only its title and where it leads go, never what's behind it; the phone opens the record through
 * /api/app as anywhere else, so the person's access still decides. To each of their approved phones with a push
 * address — an Android phone through Firebase, an iPhone through Apple's APNs; an address its service no longer knows
 * is forgotten. Nothing goes while pushes aren't set up here.
 */
export async function pushNoticeToPhones(userId: string, notice: { id: string; type: string; title: string; link: string | null }): Promise<number> {
  if (!anyPush()) return 0;
  const phones = await db.appDevice.findMany({ where: { userId, pushToken: { not: null }, device: { status: "APPROVED" } }, select: { id: true, platform: true, pushToken: true } });
  // Shown by the phone itself, the title only; kept for a phone that's off for a while — six hours — not the two
  // minutes a ring is.
  const title = notice.title.slice(0, 160);
  return pushToPhones(phones, { data: { type: "notice", notice: notice.id, kind: notice.type, title, link: notice.link ?? "" }, title, ttlSeconds: 6 * 3600 });
}

/**
 * A chat message on the other members' phones (owner, 22 Oct 2026): who and where — "New message from Asha", "Asha in
 * Sales team" — never what, as the app's own chat banner; the message stays in the chat. One a chat on the phone, the
 * latest replacing the last; kept an hour. The caller leaves out whoever muted the chat.
 */
export async function pushChatToPhones(userIds: string[], chat: { id: string; title: string }): Promise<number> {
  if (userIds.length === 0 || !anyPush()) return 0;
  const phones = await db.appDevice.findMany({ where: { userId: { in: userIds }, pushToken: { not: null }, device: { status: "APPROVED" } }, select: { id: true, platform: true, pushToken: true } });
  const title = chat.title.slice(0, 160);
  return pushToPhones(phones, { data: { type: "chat", chat: chat.id, title, link: `/chat?c=${chat.id}` }, title, ttlSeconds: 3600, group: `chat-${chat.id}`, thread: chat.id });
}
