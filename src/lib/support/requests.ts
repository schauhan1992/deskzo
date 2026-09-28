import { randomBytes } from "node:crypto";
import type { Prisma } from "@wroffy/control-client";
import { controlDb } from "@/lib/platform/control-db";
import { ATTACHMENT_EXPIRED, SupportRefused } from "@/lib/support/refused";
import { claimStaged, deleteRequestFiles, readStaged, validId, type StagedMeta } from "@/lib/support/storage";
import {
  LIMITS,
  MOBILE_PATTERN,
  SUPPORT_PRIORITIES,
  type ConsoleEntry,
  type PerfSnapshot,
  type SupportPriorityKey,
  type SupportUploadKind,
} from "@/lib/support/types";

/**
 * Making a support request: checking what the dialog sent, and writing it to the control plane with
 * its files. The workspace's server action (src/actions/support.ts) calls this; the console reads
 * requests through src/lib/support/console.ts.
 *
 * Imported from every workspace that sends a request, so it imports little — no console guard, no
 * provisioning, no billing — for the reason src/lib/platform/announcements.ts gives.
 *
 * Everything from the browser is re-checked here: text is plain and within its limits, ids are ids,
 * and what the browser says about itself is cut to size and kept apart from what the server knows.
 */

// ─── Checking what was sent ──────────────────────────────────────────────────────────────────────

/** A character nobody means to send: control characters (bar the newline, where one is allowed), the bidi overrides. */
function unwanted(code: number, newline: boolean): boolean {
  if (code === 10) return !newline;
  return code < 32 || code === 127 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function clean(value: unknown, newline: boolean): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  // Bounded before any work: a megabyte of subject is not a subject.
  const raw = String(value).slice(0, 50_000).replace(/\r\n?/g, "\n").replace(/\t/g, " ");
  let out = "";
  for (const ch of raw) out += unwanted(ch.codePointAt(0) ?? 0, newline) ? " " : ch;
  return out;
}

/** One line: whitespace collapsed, trimmed. */
export function oneLine(value: unknown): string {
  return clean(value, false).replace(/\s+/g, " ").trim();
}

/** Plain text keeping its line breaks, without trailing spaces or runs of blank lines. */
export function plainText(value: unknown): string {
  return clean(value, true)
    .replace(/[ ]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** Characters as the database's CHECKs count them — code points, so an emoji is one. */
const chars = (s: string) => [...s].length;
/** Cut to `max` code points, never through the middle of one. */
const cap = (s: string, max: number) => (chars(s) > max ? [...s].slice(0, max).join("").trim() : s);
const optional = (s: string) => s || null;

export type CleanClientContext = {
  page: string | null;
  userAgent: string | null;
  screen: string | null;
  viewport: string | null;
  timezone: string | null;
  language: string | null;
};

/** What the browser said about itself, capped: the page as a path only, no query or hash. Never refuses — a bad value is left out. */
export function cleanClientContext(input: unknown): CleanClientContext {
  const x = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const path = oneLine(x.page).split(/[?#]/)[0] ?? "";
  const timezone = cap(oneLine(x.timezone), 64);
  const language = cap(oneLine(x.language), 20);
  return {
    page: path.startsWith("/") ? cap(path, 300) : null,
    userAgent: optional(cap(oneLine(x.userAgent), 400)),
    screen: optional(cap(oneLine(x.screen), 40)),
    viewport: optional(cap(oneLine(x.viewport), 40)),
    timezone: /^[A-Za-z0-9_+/-]+$/.test(timezone) ? timezone : null,
    language: /^[A-Za-z0-9-]+$/.test(language) ? language : null,
  };
}

/** The browser's console messages from a recording: at most 200, each at most 500 characters, with a real time and a known level. */
export function cleanConsoleLog(input: unknown): ConsoleEntry[] {
  if (!Array.isArray(input)) return [];
  const out: ConsoleEntry[] = [];
  for (const item of input.slice(0, LIMITS.consoleEntries * 2)) {
    if (out.length >= LIMITS.consoleEntries) break;
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const at = typeof e.at === "string" && e.at.length <= 40 ? new Date(e.at) : null;
    const level = e.level === "error" || e.level === "warn" ? e.level : null;
    const message = cap(plainText(e.message), LIMITS.consoleEntryChars);
    if (!at || Number.isNaN(at.getTime()) || !level || !message) continue;
    out.push({ at: at.toISOString(), level, message });
  }
  return out;
}

/** Page-load timings: whole, non-negative numbers of a sane size; anything else left out. Null when none is left. */
export function cleanPerf(input: unknown): PerfSnapshot | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const x = input as Record<string, unknown>;
  const out: PerfSnapshot = {};
  const take = (key: keyof PerfSnapshot, max: number) => {
    const v = x[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max) out[key] = Math.round(v);
  };
  // Ten minutes is not a page load; ten gigabytes is not a page.
  for (const key of ["dns", "tcp", "ttfb", "domContentLoaded", "load"] as const) take(key, 600_000);
  take("transferSize", 10_000_000_000);
  return Object.keys(out).length ? out : null;
}

export type CleanSubmission = {
  subject: string;
  body: string;
  mobile: string | null;
  priority: SupportPriorityKey;
  /** File upload ids: unique, at most five, the recording's left out. */
  uploadIds: string[];
  recording: { uploadId: string; durationMs: number; consoleLog: ConsoleEntry[]; perf: PerfSnapshot | null } | null;
  client: CleanClientContext;
};

/** A few seconds' grace on the five minutes: the recorder's own stop lands just after. */
const RECORDING_GRACE_MS = 5_000;

/**
 * The dialog's fields as they will be stored, or a SupportRefused saying what to fix. Pure: whether
 * the attachments exist, and whose they are, is `stagedAttachments`; whether recording is allowed at
 * all is the action's.
 */
export function cleanSubmission(input: unknown): CleanSubmission {
  if (!input || typeof input !== "object") throw new SupportRefused("There's nothing to send.");
  const x = input as Record<string, unknown>;

  const subject = oneLine(x.subject);
  if (!subject) throw new SupportRefused("Give your request a subject.");
  if (chars(subject) > LIMITS.subject) throw new SupportRefused(`Keep the subject to ${LIMITS.subject} characters.`);
  const body = plainText(x.body);
  if (!body) throw new SupportRefused("Tell us in detail what's happening.");
  if (chars(body) > LIMITS.body) throw new SupportRefused(`Keep the details to ${LIMITS.body.toLocaleString("en-IN")} characters.`);

  const mobile = oneLine(x.mobile);
  if (mobile && !MOBILE_PATTERN.test(mobile)) throw new SupportRefused("That mobile number doesn't look right — digits, spaces, brackets, + and - only.");

  const priority = typeof x.priority === "string" && (SUPPORT_PRIORITIES as readonly string[]).includes(x.priority) ? (x.priority as SupportPriorityKey) : null;
  if (!priority) throw new SupportRefused("Choose how critical your request is.");

  let recording: CleanSubmission["recording"] = null;
  if (x.recording !== undefined && x.recording !== null) {
    const r = (typeof x.recording === "object" ? x.recording : {}) as Record<string, unknown>;
    // Consent is the whole point of the dialog before recording: without it, nothing of the recording is kept.
    if (r.consent !== true) throw new SupportRefused("A recording needs your consent — tick the box before you record.", 403);
    if (!validId(r.uploadId)) throw new SupportRefused(ATTACHMENT_EXPIRED);
    const durationMs = typeof r.durationMs === "number" && Number.isFinite(r.durationMs) ? Math.round(r.durationMs) : NaN;
    if (!(durationMs > 0)) throw new SupportRefused("That recording has no length — record it again.");
    if (durationMs > LIMITS.recordingMs + RECORDING_GRACE_MS) throw new SupportRefused("A recording can be at most 5 minutes long.");
    recording = { uploadId: r.uploadId, durationMs: Math.min(durationMs, LIMITS.recordingMs), consoleLog: cleanConsoleLog(r.consoleLog), perf: cleanPerf(r.perf) };
  }

  if (x.uploadIds !== undefined && x.uploadIds !== null && !Array.isArray(x.uploadIds)) throw new SupportRefused(ATTACHMENT_EXPIRED);
  const given = (Array.isArray(x.uploadIds) ? x.uploadIds : []).slice(0, 100);
  if (!given.every(validId)) throw new SupportRefused(ATTACHMENT_EXPIRED);
  const uploadIds = [...new Set(given as string[])].filter((id) => id !== recording?.uploadId);
  if (uploadIds.length > LIMITS.files) throw new SupportRefused(`Attach at most ${LIMITS.files} files.`);

  return { subject, body, mobile: optional(mobile), priority, uploadIds, recording, client: cleanClientContext(x.context) };
}

// ─── Attachments ─────────────────────────────────────────────────────────────────────────────────

export type StagedAttachment = { uploadId: string; kind: "FILE" | "RECORDING"; meta: StagedMeta; durationMs: number | null };

/**
 * The staged uploads a request names, each checked to be this person's, in this workspace, of the
 * kind it is sent as. One that isn't — another person's, another workspace's, swept, already sent —
 * refuses the whole request with the same words, so an id is never a probe.
 */
export async function stagedAttachments(tenantId: string, userId: string, uploadIds: string[], recording: { uploadId: string; durationMs: number } | null): Promise<StagedAttachment[]> {
  const wanted: { uploadId: string; kind: SupportUploadKind; durationMs: number | null }[] = [
    ...uploadIds.map((uploadId) => ({ uploadId, kind: "file" as const, durationMs: null })),
    ...(recording ? [{ uploadId: recording.uploadId, kind: "recording" as const, durationMs: recording.durationMs }] : []),
  ];
  const out: StagedAttachment[] = [];
  for (const w of wanted) {
    const meta = await readStaged(tenantId, w.uploadId);
    if (!meta || meta.userId !== userId || meta.tenantId !== tenantId || meta.kind !== w.kind) throw new SupportRefused(ATTACHMENT_EXPIRED);
    out.push({ uploadId: w.uploadId, kind: w.kind === "recording" ? "RECORDING" : "FILE", meta, durationMs: w.durationMs });
  }
  return out;
}

// ─── Writing it ──────────────────────────────────────────────────────────────────────────────────

/** An id for a row made here — cuid-shaped (lower-case letters and digits), so it names a folder too. */
function newId(): string {
  return `c${Date.now().toString(36)}${randomBytes(10).toString("hex")}`;
}

export type NewSupportRequest = {
  tenantId: string;
  requester: { userId: string; name: string; email: string; role: string | null };
  mobile: string | null;
  subject: string;
  body: string;
  priority: SupportPriorityKey;
  /** Built by the action: the server's facts and the browser's, capped. */
  context: Prisma.InputJsonValue;
  /** Only with a consented recording. */
  consoleLog: ConsoleEntry[] | null;
  recordingConsentAt: Date | null;
  ip: string | null;
  attachments: StagedAttachment[];
};

/**
 * Writes the request and its attachments in one go, then moves each staged file under it. If a move
 * fails — the upload was claimed by another send a moment ago, or swept — the rows and the files moved
 * so far are deleted, and the refusal says to add the attachment again. Returns its id and number.
 */
export async function createSupportRequest(input: NewSupportRequest): Promise<{ id: string; number: number }> {
  const requestId = newId();
  const planned = input.attachments.map((a) => ({ ...a, id: newId() }));
  const created = await controlDb().supportRequest.create({
    data: {
      id: requestId,
      tenantId: input.tenantId,
      requesterUserId: input.requester.userId,
      requesterName: cap(oneLine(input.requester.name), 200) || input.requester.email,
      requesterEmail: input.requester.email,
      requesterRole: input.requester.role ? cap(oneLine(input.requester.role), 60) : null,
      mobile: input.mobile,
      subject: input.subject,
      body: input.body,
      priority: input.priority,
      context: input.context,
      ...(input.consoleLog ? { consoleLog: input.consoleLog as unknown as Prisma.InputJsonValue } : {}),
      recordingConsentAt: input.recordingConsentAt,
      ip: input.ip,
      attachments: {
        create: planned.map((a) => ({
          id: a.id,
          kind: a.kind,
          filename: a.meta.filename,
          mime: a.meta.mime,
          size: a.meta.size,
          sha256: a.meta.sha256,
          storageKey: `${input.tenantId}/${requestId}/${a.id}`,
          durationMs: a.durationMs,
        })),
      },
    },
    select: { id: true, number: true },
  });

  try {
    for (const a of planned) await claimStaged(input.tenantId, input.requester.userId, a.uploadId, requestId, a.id);
  } catch (err) {
    await controlDb()
      .supportRequest.delete({ where: { id: requestId } })
      .catch(() => {});
    await deleteRequestFiles(input.tenantId, requestId).catch(() => {});
    throw err instanceof SupportRefused ? err : new SupportRefused(ATTACHMENT_EXPIRED);
  }
  return created;
}
