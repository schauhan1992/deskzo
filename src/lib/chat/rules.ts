/**
 * Team chat's rules, without a database: limits, the ticks, a chat's preview line, the links that
 * become record cards. Plain, so the server, the browser and `check:chat` share one answer.
 *
 * Chat is the workspace's own: messages and files stay in its database, notifications say who and
 * where but never what, and only a chat's members read it (owner, 15 Oct 2026 — see
 * src/lib/chat/server.ts).
 */

/** The longest message, in characters — a long email's worth. */
export const MAX_BODY = 4000;
/** Files on one message. */
export const MAX_FILES = 5;
/** All of one message's files together. Server actions take 6 MB (next.config.ts), less the form's own overhead. */
export const MAX_FILES_BYTES = 5 * 1024 * 1024;
export const MAX_GROUP_NAME = 60;
export const MAX_GROUP_MEMBERS = 256;
/** How long after sending a message may be changed, as WhatsApp allows. */
export const EDIT_WINDOW_MS = 15 * 60_000;
/** How long after sending a message may be deleted for everyone. */
export const DELETE_WINDOW_MS = 60 * 60_000;
/** One page of a conversation. */
export const PAGE_SIZE = 50;
/** How long "is typing…" shows after the last keystroke was reported. */
export const TYPING_SHOWN_MS = 5000;

/** The reactions offered, WhatsApp's six. Nothing else is taken, so a reaction is never free text. */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export function isReaction(emoji: string): boolean {
  return (REACTIONS as readonly string[]).includes(emoji);
}

/** Messages pinned in one chat at a time; pinning another unpins the oldest. */
export const MAX_PINS = 3;

/** Settings → Chat's retention choices, in days; null keeps everything. */
export const RETENTION_CHOICES: readonly { days: number | null; label: string }[] = [
  { days: null, label: "Keep messages for good" },
  { days: 90, label: "Delete messages older than 90 days" },
  { days: 365, label: "Delete messages older than 1 year" },
  { days: 1095, label: "Delete messages older than 3 years" },
];

export function isRetentionChoice(days: number | null): boolean {
  return RETENTION_CHOICES.some((c) => c.days === days);
}

/**
 * The files a chat takes: pictures, PDFs, office documents, text and archives. Nothing a browser would
 * run — no HTML or SVG, which can carry script, and no programs.
 */
const FILE_TYPES: Record<string, readonly string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
  "text/plain": ["txt", "log"],
  "text/csv": ["csv"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.ms-powerpoint": ["ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "application/zip": ["zip"],
  "application/x-zip-compressed": ["zip"],
};

/** What a file is, from its type and its name's extension together, or null when the chat won't take it. */
export function chatFileType(mimeType: string, fileName: string): string | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const declared = FILE_TYPES[mimeType];
  if (declared?.includes(ext)) return mimeType;
  // Browsers often send an empty or generic type; the extension then decides, alone.
  if (!mimeType || mimeType === "application/octet-stream") {
    const found = Object.entries(FILE_TYPES).find(([, exts]) => exts.includes(ext));
    if (found) return found[0];
  }
  return null;
}

/** Shown inline in the conversation rather than as a file chip. */
export function isPicture(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/** Opened in a browser tab when the workspace keeps files view-only. */
export function opensInBrowser(mimeType: string): boolean {
  return isPicture(mimeType) || mimeType === "application/pdf" || mimeType === "text/plain";
}

export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One direct chat per pair, whoever starts it: the two ids sorted. */
export function directKeyFor(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/** A member's reading position, as the ticks need it. Times are ISO strings or Dates. */
export type ReceiptMember = {
  userId: string;
  joinedAt: string | Date;
  leftAt: string | Date | null;
  lastDeliveredAt: string | Date | null;
  lastReadAt: string | Date | null;
};

export type Tick = "sent" | "delivered" | "read";

const ms = (t: string | Date | null | undefined) => (t ? new Date(t).getTime() : null);

/**
 * The ticks on a message somebody sent: read once everyone else who was in the chat when it was sent
 * has read up to it, delivered once it has reached all of them, sent until then. A chat with nobody
 * else in it (everyone else has left) shows sent.
 */
export function tickFor(message: { senderId: string | null; createdAt: string | Date }, members: readonly ReceiptMember[]): Tick {
  const at = ms(message.createdAt)!;
  const others = members.filter((m) => {
    if (m.userId === message.senderId) return false;
    const joined = ms(m.joinedAt)!;
    const left = ms(m.leftAt);
    return joined <= at && (left === null || left >= at);
  });
  if (others.length === 0) return "sent";
  if (others.every((m) => (ms(m.lastReadAt) ?? -1) >= at)) return "read";
  if (others.every((m) => Math.max(ms(m.lastDeliveredAt) ?? -1, ms(m.lastReadAt) ?? -1) >= at)) return "delivered";
  return "sent";
}

/** The people a group member's message has been read by, for the message's info. */
export function readBy(message: { senderId: string | null; createdAt: string | Date }, members: readonly ReceiptMember[]): string[] {
  const at = ms(message.createdAt)!;
  return members.filter((m) => m.userId !== message.senderId && (ms(m.lastReadAt) ?? -1) >= at && ms(m.joinedAt)! <= at).map((m) => m.userId);
}

/** The line under a chat's name in the list: the newest message, shortened. */
export function previewOf(message: { kind: string; body: string; deletedAt: string | Date | null; attachmentCount: number; senderName: string | null } | null, opts: { group: boolean; mine: boolean }): string {
  if (!message) return "";
  if (message.deletedAt) return opts.mine ? "You deleted this message" : "This message was deleted";
  const text = message.body.replace(/\s+/g, " ").trim();
  const what = text || (message.attachmentCount > 1 ? `${message.attachmentCount} files` : message.attachmentCount === 1 ? "A file" : "");
  if (message.kind === "SYSTEM") return what;
  const who = opts.mine ? "You" : opts.group ? message.senderName?.split(/\s+/)[0] ?? null : null;
  const line = who ? `${who}: ${what}` : what;
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** The record pages a message can show as a card: the readable addresses src/lib/record-links.ts makes. */
export const RECORD_LINK_KINDS = ["companies", "leads", "orders", "tickets"] as const;
export type RecordLinkKind = (typeof RECORD_LINK_KINDS)[number];

/**
 * The record links in a message, in order, at most three: "/companies/C-0042", pasted bare or as a full
 * address with the workspace's host in front.
 */
export function recordLinksIn(body: string): { kind: RecordLinkKind; ref: string; path: string }[] {
  const found: { kind: RecordLinkKind; ref: string; path: string }[] = [];
  const pattern = /(?:https?:\/\/[^\s/]+)?\/(companies|leads|orders|tickets)\/([A-Za-z0-9-]+)(?=[\s?#.,;:!)]|$)/g;
  for (const match of body.matchAll(pattern)) {
    const kind = match[1] as RecordLinkKind;
    const ref = match[2]!;
    const path = `/${kind}/${ref}`;
    if (!found.some((f) => f.path === path)) found.push({ kind, ref, path });
    if (found.length === 3) break;
  }
  return found;
}

/**
 * The people a message @mentions, from the members the composer offered: "@Priya Sharma" in the text
 * for a member named Priya Sharma. Longest names first, so "@Priya Sharma" is not read as "@Priya".
 */
export function mentionsIn(body: string, members: readonly { id: string; name: string }[]): string[] {
  const lower = body.toLowerCase();
  const ids: string[] = [];
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  let rest = lower;
  for (const m of byLength) {
    const token = `@${m.name.toLowerCase()}`;
    if (rest.includes(token)) {
      ids.push(m.id);
      rest = rest.split(token).join(" ");
    }
  }
  return ids;
}

/** Whether a member's mute is in force now. */
export function isMuted(mutedUntil: string | Date | null | undefined, now = Date.now()): boolean {
  const until = ms(mutedUntil);
  return until !== null && until > now;
}

/** The mute lengths offered, in hours; "always" is a date far enough away to mean it. */
export const MUTE_CHOICES: readonly { hours: number; label: string }[] = [
  { hours: 8, label: "8 hours" },
  { hours: 24 * 7, label: "1 week" },
  { hours: 24 * 365 * 100, label: "Always" },
];
