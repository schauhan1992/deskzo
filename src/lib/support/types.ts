/**
 * Contact Support — the shapes and limits every side shares: the workspace's button and dialog, the
 * upload route, the server action, and the console's Support pages.
 *
 * Pure types and constants only, so a client component imports this file without pulling the control
 * plane, the file system or the session into its bundle. The string unions mirror the control plane's
 * enums (prisma/control/schema.prisma), so a row can be handed straight to a component.
 */

export type SupportPriorityKey = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type SupportStatusKey = "OPEN" | "IN_PROGRESS" | "WAITING" | "RESOLVED" | "CLOSED";
export type SupportAttachmentKindKey = "FILE" | "RECORDING";
export type SupportEntryKindKey = "REPLY" | "NOTE" | "STATUS" | "PRIORITY" | "ASSIGN";
/** What the upload route is told a body is (`x-support-kind`). */
export type SupportUploadKind = "file" | "recording";

export const SUPPORT_PRIORITIES: readonly SupportPriorityKey[] = ["LOW", "NORMAL", "HIGH", "URGENT"];
export const SUPPORT_STATUSES: readonly SupportStatusKey[] = ["OPEN", "IN_PROGRESS", "WAITING", "RESOLVED", "CLOSED"];

/** "How critical is your request?" — the dialog's choices, in the order it offers them. */
export const PRIORITY_OPTIONS: readonly { value: SupportPriorityKey; label: string }[] = [
  { value: "LOW", label: "Just a question" },
  { value: "NORMAL", label: "Something isn't working" },
  { value: "HIGH", label: "It's blocking my work" },
  { value: "URGENT", label: "Critical — our business is stopped" },
];
export const DEFAULT_PRIORITY: SupportPriorityKey = "NORMAL";

/** A priority in a word, for staff: tables, badges, email subjects. */
export const PRIORITY_LABELS: Record<SupportPriorityKey, string> = { LOW: "Low", NORMAL: "Normal", HIGH: "High", URGENT: "Urgent" };

export const STATUS_LABELS: Record<SupportStatusKey, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  WAITING: "Waiting on customer",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

/**
 * The limits, enforced on the server whatever the browser does — the dialog shows the same ones.
 * Characters are code points, as the database's CHECKs count them.
 */
export const LIMITS = {
  subject: 150,
  body: 5000,
  /** Files per request, besides one recording. */
  files: 5,
  fileBytes: 10 * 1024 * 1024,
  recordingBytes: 80 * 1024 * 1024,
  /** Five minutes: the recorder stops itself here. */
  recordingMs: 300_000,
  consoleEntries: 200,
  consoleEntryChars: 500,
} as const;

/** "+91 98765 43210", "(022) 2345-6789" — digits, spaces, brackets and hyphens, an optional leading +. */
export const MOBILE_PATTERN = /^\+?[0-9][0-9 ()-]{5,19}$/;

/** For `<input type="file" accept>`: a hint to the picker only — the server sniffs every file. */
export const ACCEPTED_FILE_TYPES = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.csv,.docx,.xlsx,.pptx,.zip";

/** The upload route (src/app/api/support/uploads/route.ts) and the headers it reads. */
export const UPLOAD_URL = "/api/support/uploads";
export const UPLOAD_HEADERS = {
  /** `file` or `recording`. */
  kind: "x-support-kind",
  /** The file's name, `encodeURIComponent`-ed. */
  fileName: "x-file-name",
  /** Always "1": a header a cross-site form cannot set. */
  marker: "x-support-upload",
} as const;

/** SR-1042. */
export function supportRef(number: number): string {
  return `SR-${number}`;
}

/** "SR-1042", "sr 1042", "#1042" or "1042" → 1042; null for anything else. */
export function parseSupportRef(text: string): number | null {
  const match = /^\s*(?:sr[\s-]?|#)?(\d{1,9})\s*$/i.exec(String(text ?? ""));
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ─── The workspace side ──────────────────────────────────────────────────────────────────────────

/**
 * What the browser says about itself, sent with every request (the dialog discloses it). Each is
 * optional and capped on the server; the server adds the workspace, the person and the address itself.
 */
export type ClientContext = {
  /** `location.pathname` — never the query or the hash. At most 300 characters. */
  page?: string;
  /** At most 400. */
  userAgent?: string;
  /** "1920×1080@2x". */
  screen?: string;
  /** "1440×900". */
  viewport?: string;
  /** The IANA zone, "Asia/Kolkata". At most 64. */
  timezone?: string;
  /** `navigator.language`, "en-IN". At most 20. */
  language?: string;
};

/** One browser console message caught while recording: at most 500 characters, at most 200 of them. */
export type ConsoleEntry = { at: string /* ISO */; level: "error" | "warn"; message: string };

/** The page's navigation timing, in whole milliseconds (transferSize in bytes). A field the browser can't give is left out. */
export type PerfSnapshot = {
  dns?: number;
  tcp?: number;
  ttfb?: number;
  domContentLoaded?: number;
  load?: number;
  transferSize?: number;
};

export type SupportRecordingInput = {
  /** From the upload route, sent with `x-support-kind: recording`. */
  uploadId: string;
  durationMs: number;
  /** Ticked in the consent dialog. The server refuses the recording without it. */
  consent: true;
  consoleLog: ConsoleEntry[];
  perf?: PerfSnapshot;
};

export type SupportSubmitInput = {
  subject: string;
  body: string;
  mobile?: string;
  priority: SupportPriorityKey;
  /** From the upload route, sent with `x-support-kind: file`. At most five. */
  uploadIds: string[];
  recording?: SupportRecordingInput;
  context: ClientContext;
};

export type SupportSubmitResult = { ok: true; number: number; email: string } | { ok: false; error: string };

/** Why the Record button is off: the console's switch, or this workspace's copy/print deterrents apply to them. */
export type RecordingBlockedReason = "setting" | "dlp" | null;

/**
 * What the dashboard layout hands the launcher — null (nothing rendered) for nobody signed in, a
 * view-as, a support account, support switched off, or no control plane.
 */
export type LauncherState = {
  /** The signed-in person's own address: where the answer goes. */
  email: string;
  /** Their User.phone, to prefill Mobile number. */
  phone: string | null;
  /** The platform's helpline and its hours (console settings); each null when unset. */
  helpline: string | null;
  hours: string | null;
  recordingAllowed: boolean;
  recordingBlockedReason: RecordingBlockedReason;
  /** "I agree to allow {brandName} to collect…". */
  brandName: string;
};

/** The upload route's answer: 200 with this, or an error status with `UploadError`. */
export type UploadResponse = { uploadId: string; filename: string; size: number; mime: string };
export type UploadError = { error: string };

// ─── The console side ────────────────────────────────────────────────────────────────────────────

/** A request's context as the console shows it: what the server knew, and what the browser said. */
export type SupportContextView = {
  workspace: { id: string; slug: string; name: string } | null;
  page: string | null;
  userAgent: string | null;
  /** "Chrome 129 on Windows", from the user agent; null when it can't be told. */
  browser: string | null;
  screen: string | null;
  viewport: string | null;
  timezone: string | null;
  language: string | null;
  ip: string | null;
  appVersion: string | null;
};

export type SupportAttachmentView = {
  id: string;
  kind: SupportAttachmentKindKey;
  filename: string;
  mime: string;
  size: number;
  durationMs: number | null;
  /** Removed by retention: listed, not openable. */
  purged: boolean;
  createdAt: Date;
  /** The console's file route: `/support-files/<id>`. */
  href: string;
};

type EntryBase = { id: string; at: Date; author: { id: string; name: string } | null };
export type SupportEntryView =
  | (EntryBase & { kind: "REPLY"; body: string; emailed: boolean; to: string | null; error: string | null })
  | (EntryBase & { kind: "NOTE"; body: string })
  | (EntryBase & { kind: "STATUS"; from: SupportStatusKey | null; to: SupportStatusKey | null })
  | (EntryBase & { kind: "PRIORITY"; from: SupportPriorityKey | null; to: SupportPriorityKey | null })
  /** Staff names, as they were when it was assigned; null is "nobody". */
  | (EntryBase & { kind: "ASSIGN"; from: string | null; to: string | null });

/** Staff a request may be assigned to: active, and allowed to act on requests. */
export type SupportAssigneeOption = { id: string; name: string; role: string };

export type SupportListRow = {
  id: string;
  number: number;
  /** SR-1042. */
  ref: string;
  subject: string;
  requesterName: string;
  requesterEmail: string;
  workspace: { id: string; slug: string; name: string };
  priority: SupportPriorityKey;
  status: SupportStatusKey;
  assignee: { id: string; name: string } | null;
  createdAt: Date;
  /** Every change and entry touches it. */
  lastActivityAt: Date;
  attachments: number;
  hasRecording: boolean;
};

export type SupportKpis = {
  /** OPEN and IN_PROGRESS. */
  open: number;
  /** Of those, URGENT. */
  urgentOpen: number;
  waiting: number;
  /** The median time to the first emailed reply, over requests made in the last 30 days that have one. */
  medianFirstResponseMs: number | null;
  /** How many requests that median is over. */
  firstResponseSample: number;
};

export type SupportDetail = {
  id: string;
  number: number;
  ref: string;
  subject: string;
  /** Plain text: render it as text (whitespace-pre-wrap), never as HTML. */
  body: string;
  priority: SupportPriorityKey;
  status: SupportStatusKey;
  assignee: { id: string; name: string } | null;
  requester: { userId: string; name: string; email: string; role: string | null; mobile: string | null };
  workspace: {
    id: string;
    slug: string;
    name: string;
    status: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "MIGRATING" | "DEPROVISIONED";
    plans: { key: string; name: string }[];
  };
  context: SupportContextView;
  /** Only with a consented recording. */
  consoleLog: ConsoleEntry[] | null;
  perf: PerfSnapshot | null;
  recordingConsentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  attachments: SupportAttachmentView[];
  /** Oldest first. */
  entries: SupportEntryView[];
  /** The workspace's live support-access grant, when there is one — "Enter workspace". */
  grant: { level: "READONLY" | "ADMIN"; expiresAt: Date; grantedByName: string } | null;
  assignees: SupportAssigneeOption[];
  /** The console setting, for the reply hint ("replies to it go to …"). */
  supportEmail: string;
};

/** One of a workspace's requests, for its 360 page. */
export type SupportTenantRow = {
  id: string;
  number: number;
  ref: string;
  subject: string;
  status: SupportStatusKey;
  priority: SupportPriorityKey;
  requesterName: string;
  createdAt: Date;
  lastActivityAt: Date;
};

/** Where new requests are announced until the console sets a real address. */
export const SUPPORT_EMAIL_PLACEHOLDER = "support@yourdomain.com";
/** How long after a request is closed its files are kept, in days. */
export const RETENTION_DAYS = { min: 30, max: 3650, fallback: 365 } as const;
/** The settings form's limits — the save checks them again (src/lib/support/settings.ts). */
export const SETTINGS_LIMITS = { email: 254, helpline: 30, hours: 80 } as const;
/** The helpline: the workspace helpline's own rule (src/actions/help.ts) — digits, spaces, brackets, + and -. */
export const HELPLINE_PATTERN = /^\+?[0-9][0-9 ()-]{5,28}$/;

/** The console's typed view of the support settings (src/lib/support/settings.ts). */
export type SupportSettingsView = {
  enabled: boolean;
  email: string;
  helpline: string | null;
  hours: string | null;
  recording: boolean;
  retentionDays: number;
};

/** What the console's Support settings form sends (`saveSupportSettings`); empty helpline or hours clears it. */
export type SupportSettingsInput = {
  enabled: boolean;
  email: string;
  helpline?: string | null;
  hours?: string | null;
  recording: boolean;
  /** Whole days, 30–3650. */
  retentionDays: number | string;
};
