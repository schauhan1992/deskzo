import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { whatsappNumber } from "@/lib/marketing/providers/whatsapp";

/**
 * WhatsApp for the Customer inbox (owner, 24 Oct 2026): Meta's Cloud API both ways. The access token is
 * the workspace's WhatsApp provider's (Settings › Mail & messaging — one Meta app, one token for every
 * number in its WhatsApp Business account); each inbox number sends as itself, by its phone number ID.
 *
 * Inbound calls come to the workspace's own address (src/app/api/inbox/public/whatsapp), signed by the
 * Meta app with its secret: `verifySignature` checks every one before anything is read.
 *
 * WhatsApp's rule: free text only within 24 hours of the customer's last message; after that, an
 * approved template (src/lib/inbox/settings.ts `whatsappWindowOpen`). The caller decides which; this
 * sends what it is given.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

export type WhatsAppOutbound =
  | { phoneNumberId: string; to: string; text: string }
  | { phoneNumberId: string; to: string; template: { name: string; variables: string[] } };

export type WhatsAppSent = { ok: true; id: string | null } | { ok: false; error: string };

type Sender = (message: WhatsAppOutbound) => Promise<WhatsAppSent>;
let testSender: Sender | null = null;

/** For the checks: every send goes here instead of to Meta. Null puts Meta back. */
export function setTestWhatsAppSender(sender: Sender | null) {
  testSender = sender;
}

/**
 * The workspace's WhatsApp token and template language, or null when WhatsApp isn't set up: the inbox's
 * own (Settings › Customer inbox), else the WhatsApp provider's in Mail & messaging — the same Meta app.
 */
export async function whatsappCredentials(): Promise<{ token: string; language: string } | null> {
  const own = await db.inboxSettings.findUnique({ where: { id: "global" }, select: { whatsappTokenCipher: true, whatsappLanguage: true } }).catch(() => null);
  const ownToken = own?.whatsappTokenCipher ? await decryptSecret(own.whatsappTokenCipher).catch(() => null) : null;
  if (ownToken) return { token: ownToken, language: own?.whatsappLanguage?.trim() || "en" };
  const row = await db.messagingProvider.findFirst({ where: { kind: "WHATSAPP", key: "whatsapp_cloud", enabled: true }, select: { config: true, secretCipher: true } });
  if (!row?.secretCipher) return null;
  const token = await decryptSecret(row.secretCipher).catch(() => null);
  if (!token) return null;
  const config = (row.config as Record<string, unknown> | null) ?? {};
  return { token, language: own?.whatsappLanguage?.trim() || String(config.languageCode ?? "en").trim() || "en" };
}

/** Whether WhatsApp can send from this workspace at all — for the settings page and the inbox's composer. */
export async function whatsappReady(): Promise<boolean> {
  if (testSender) return true;
  return (await whatsappCredentials()) !== null;
}

export async function sendWhatsApp(message: WhatsAppOutbound): Promise<WhatsAppSent> {
  if (testSender) return testSender(message);
  const credentials = await whatsappCredentials();
  if (!credentials) return { ok: false, error: "WhatsApp isn't set up — add the WhatsApp provider in Settings › Mail & messaging." };
  const to = whatsappNumber(message.to);
  if (!to) return { ok: false, error: "That isn't a usable phone number." };
  const body =
    "text" in message
      ? { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: message.text } }
      : {
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: message.template.name,
            language: { code: credentials.language },
            components: message.template.variables.length ? [{ type: "body", parameters: message.template.variables.map((text) => ({ type: "text", text })) }] : undefined,
          },
        };
  try {
    const response = await fetch(`${GRAPH}/${encodeURIComponent(message.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const answer = (await response.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } };
    if (!response.ok) return { ok: false, error: answer.error?.message?.slice(0, 300) ?? `WhatsApp answered ${response.status}.` };
    return { ok: true, id: answer.messages?.[0]?.id ?? null };
  } catch (err) {
    return { ok: false, error: `WhatsApp couldn't be reached: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
}

type ReadMarker = (input: { phoneNumberId: string; messageId: string; typing: boolean }) => Promise<boolean>;
let testRead: ReadMarker | null = null;

/** For the checks: every read receipt and typing indicator goes here instead of to Meta. Null puts Meta back. */
export function setTestWhatsAppRead(marker: ReadMarker | null) {
  testRead = marker;
}

/**
 * A customer's message marked read — the blue ticks they see — and, with `typing`, "typing…" shown to
 * them until the reply goes (Meta shows it for up to 25 seconds). What a person on the phone would show.
 * True when Meta took it. Never throws.
 */
export async function markWhatsAppRead(input: { phoneNumberId: string; messageId: string; typing: boolean }): Promise<boolean> {
  if (testRead) return testRead(input);
  const credentials = await whatsappCredentials().catch(() => null);
  if (!credentials) return false;
  try {
    const response = await fetch(`${GRAPH}/${encodeURIComponent(input.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: input.messageId, ...(input.typing ? { typing_indicator: { type: "text" } } : {}) }),
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** WhatsApp's own ceiling for what a customer can send (16 MB for media; documents allow more, which aren't kept). */
export const MEDIA_LIMIT = 16 * 1024 * 1024;

export type FetchedMedia = { ok: true; bytes: Buffer; mime: string } | { ok: false; error: string };
type MediaFetcher = (mediaId: string) => Promise<FetchedMedia>;
let testMedia: MediaFetcher | null = null;

/** For the checks: every media fetch comes from here instead of Meta. Null puts Meta back. */
export function setTestWhatsAppMedia(fetcher: MediaFetcher | null) {
  testMedia = fetcher;
}

/** Where Meta keeps media: the link it hands back must point there, so a forged answer can't send the fetch elsewhere. */
const MEDIA_HOSTS = /(^|\.)(fbsbx\.com|facebook\.com|whatsapp\.net|fbcdn\.net)$/i;

/**
 * A customer's file from Meta: its media id gives a short-lived link, fetched with the token. Only from
 * Meta's own hosts, only https, no redirects, and nothing over `MEDIA_LIMIT`.
 */
export async function fetchWhatsAppMedia(mediaId: string): Promise<FetchedMedia> {
  if (testMedia) return testMedia(mediaId);
  const credentials = await whatsappCredentials();
  if (!credentials) return { ok: false, error: "WhatsApp isn't set up." };
  const auth = { Authorization: `Bearer ${credentials.token}` };
  try {
    const meta = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(15_000) });
    const info = (await meta.json().catch(() => ({}))) as { url?: string; mime_type?: string; file_size?: number; error?: { message?: string } };
    if (!meta.ok || !info.url) return { ok: false, error: info.error?.message?.slice(0, 200) ?? "WhatsApp no longer has this file." };
    if (typeof info.file_size === "number" && info.file_size > MEDIA_LIMIT) return { ok: false, error: "The file is over 16 MB." };
    const url = new URL(info.url);
    if (url.protocol !== "https:" || !MEDIA_HOSTS.test(url.hostname)) return { ok: false, error: "WhatsApp gave an unexpected address for the file." };
    const file = await fetch(url, { headers: auth, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!file.ok) return { ok: false, error: `WhatsApp answered ${file.status} for the file.` };
    if (Number(file.headers.get("content-length") ?? 0) > MEDIA_LIMIT) return { ok: false, error: "The file is over 16 MB." };
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > MEDIA_LIMIT) return { ok: false, error: "The file is over 16 MB." };
    const mime = (info.mime_type ?? file.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    return { ok: true, bytes, mime };
  } catch (err) {
    return { ok: false, error: `WhatsApp couldn't be reached: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200) };
  }
}

/** `X-Hub-Signature-256: sha256=<hex>` — the Meta app's HMAC of the raw body. */
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=") || !appSecret) return false;
  const given = Buffer.from(header.slice(7), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A photo, document, voice note, video or sticker: Meta's id for it, fetched only when somebody opens it. */
export type InboundMedia = { id: string; mime: string | null; name: string | null };

export type InboundWhatsApp = { phoneNumberId: string; from: string; profileName: string | null; id: string; at: Date; text: string; media?: InboundMedia | null };
export type WhatsAppStatus = { id: string; status: "SENT" | "DELIVERED" | "READ" | "FAILED"; error: string | null };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** What a message says, as text: its words, a button's, or what was sent ("[Photo] the caption"). Media isn't fetched. */
export function inboundText(message: Obj): string {
  const type = s(message.type);
  const caption = (field: string) => s(obj(message[field]).caption).trim();
  switch (type) {
    case "text":
      return s(obj(message.text).body);
    case "button":
      return s(obj(message.button).text);
    case "interactive": {
      const i = obj(message.interactive);
      return s(obj(i.button_reply).title) || s(obj(i.list_reply).title) || "[A reply]";
    }
    case "image":
      return `[Photo]${caption("image") ? ` ${caption("image")}` : ""}`;
    case "video":
      return `[Video]${caption("video") ? ` ${caption("video")}` : ""}`;
    case "document": {
      const d = obj(message.document);
      return `[Document${s(d.filename) ? `: ${s(d.filename)}` : ""}]${caption("document") ? ` ${caption("document")}` : ""}`;
    }
    case "audio":
      return "[Voice message]";
    case "sticker":
      return "[Sticker]";
    case "location": {
      const l = obj(message.location);
      return `[Location] ${[s(l.name), s(l.address)].filter(Boolean).join(", ") || `${s(l.latitude)}, ${s(l.longitude)}`}`.trim();
    }
    case "contacts":
      return "[A contact card]";
    case "reaction":
      return "";
    default:
      return `[${type || "Message"}]`;
  }
}

const MEDIA_TYPES = ["image", "video", "document", "audio", "sticker"] as const;

/** The file a message carries, if any. */
export function inboundMedia(message: Obj): InboundMedia | null {
  const type = s(message.type);
  if (!(MEDIA_TYPES as readonly string[]).includes(type)) return null;
  const m = obj(message[type]);
  const id = s(m.id);
  if (!id) return null;
  return { id, mime: s(m.mime_type).split(";")[0]!.trim().toLowerCase() || null, name: s(m.filename).slice(0, 200) || null };
}

const STATUS: Record<string, WhatsAppStatus["status"]> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };

/** Meta's webhook body, flattened: the messages customers sent, and receipts for ours. Anything else is ignored. */
export function parseWebhook(body: unknown): { messages: InboundWhatsApp[]; statuses: WhatsAppStatus[] } {
  const messages: InboundWhatsApp[] = [];
  const statuses: WhatsAppStatus[] = [];
  const root = obj(body);
  if (s(root.object) !== "whatsapp_business_account") return { messages, statuses };
  for (const entry of arr(root.entry)) {
    for (const change of arr(obj(entry).changes)) {
      const value = obj(obj(change).value);
      const phoneNumberId = s(obj(value.metadata).phone_number_id);
      if (!phoneNumberId) continue;
      const names = new Map(arr(value.contacts).map((c) => [s(obj(c).wa_id), s(obj(obj(c).profile).name)]));
      for (const raw of arr(value.messages)) {
        const m = obj(raw);
        const from = s(m.from).replace(/\D/g, "");
        const id = s(m.id);
        const text = inboundText(m).trim();
        if (!from || !id || !text) continue;
        const ts = Number(s(m.timestamp));
        messages.push({ phoneNumberId, from, profileName: names.get(from)?.trim() || null, id, at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(), text, media: inboundMedia(m) });
      }
      for (const raw of arr(value.statuses)) {
        const st = obj(raw);
        const status = STATUS[s(st.status)];
        if (!status || !s(st.id)) continue;
        const error = arr(st.errors).map((e) => s(obj(e).title) || s(obj(e).message)).filter(Boolean)[0] ?? null;
        statuses.push({ id: s(st.id), status, error });
      }
    }
  }
  return { messages, statuses };
}
