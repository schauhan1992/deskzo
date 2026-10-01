import type { Prisma } from "@deskzo/control-client";
import { deviceFromUserAgent } from "@/lib/console-shared/format";
import type { SupportFilters, SupportStatusTab } from "@/lib/console-shared/params";
import { SUPPORT_AGENTS } from "@/lib/console-shared/roles";
import { consoleAudit } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import type { Staff } from "@/lib/platform/staff-session";
import { activeSupportGrant } from "@/lib/platform/support";
import { SUPPORT_DEFAULTS, getSupportSettings } from "@/lib/support/settings";
import {
  SUPPORT_PRIORITIES,
  SUPPORT_STATUSES,
  parseSupportRef,
  supportRef,
  type ConsoleEntry,
  type PerfSnapshot,
  type SupportAssigneeOption,
  type SupportAttachmentKindKey,
  type SupportAttachmentView,
  type SupportContextView,
  type SupportDetail,
  type SupportEntryView,
  type SupportKpis,
  type SupportListRow,
  type SupportPriorityKey,
  type SupportStatusKey,
  type SupportTenantRow,
} from "@/lib/support/types";

/**
 * The console's reading of support requests: the inbox with its tabs and KPIs, one request with its
 * files and timeline, a workspace's requests for its 360, the Overview's count — and the attachment
 * lookup and audit the file route (/support-files/<id>) is built on.
 *
 * Console only: it imports the console guard. Workspaces write requests through
 * src/lib/support/requests.ts. The actions that change a request are src/actions/platform/console-support.ts.
 *
 * What a request says is returned as it was written — plain text, for the pages to render as text.
 */

const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;
/** "Open" in the inbox and on every count: not yet answered, and being worked. */
const OPEN_STATUSES: SupportStatusKey[] = ["OPEN", "IN_PROGRESS"];
const GONE_STAFF = "A former staff member";

const TAB_WHERE: Record<SupportStatusTab, Prisma.SupportRequestWhereInput> = {
  open: { status: { in: OPEN_STATUSES } },
  waiting: { status: "WAITING" },
  resolved: { status: "RESOLVED" },
  closed: { status: "CLOSED" },
  all: {},
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const statusOf = (v: unknown): SupportStatusKey | null => (typeof v === "string" && (SUPPORT_STATUSES as readonly string[]).includes(v) ? (v as SupportStatusKey) : null);
const priorityOf = (v: unknown): SupportPriorityKey | null => (typeof v === "string" && (SUPPORT_PRIORITIES as readonly string[]).includes(v) ? (v as SupportPriorityKey) : null);

// ─── The inbox ───────────────────────────────────────────────────────────────────────────────────

/** Everything but the status tab: priority, workspace, assignee and the search. */
function filterWhere(f: SupportFilters, viewerId: string): Prisma.SupportRequestWhereInput {
  const and: Prisma.SupportRequestWhereInput[] = [];
  if (f.priority) and.push({ priority: f.priority });
  if (f.workspace) and.push({ tenant: { slug: f.workspace } });
  if (f.assignee === "me") and.push({ assigneeId: viewerId });
  if (f.assignee === "unassigned") and.push({ assigneeId: null });
  const q = f.q?.trim();
  if (q) {
    const number = parseSupportRef(q);
    and.push({
      OR: [
        ...(number !== null ? [{ number }] : []),
        { subject: { contains: q, mode: "insensitive" as const } },
        { requesterEmail: { contains: q, mode: "insensitive" as const } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

const LIST_SELECT = {
  id: true,
  number: true,
  subject: true,
  requesterName: true,
  requesterEmail: true,
  priority: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  tenant: { select: { id: true, slug: true, name: true } },
  assignee: { select: { id: true, name: true } },
  _count: { select: { attachments: true } },
  attachments: { where: { kind: "RECORDING" }, select: { id: true }, take: 1 },
} as const satisfies Prisma.SupportRequestSelect;

type ListRecord = Prisma.SupportRequestGetPayload<{ select: typeof LIST_SELECT }>;

function toListRow(r: ListRecord): SupportListRow {
  return {
    id: r.id,
    number: r.number,
    ref: supportRef(r.number),
    subject: r.subject,
    requesterName: r.requesterName,
    requesterEmail: r.requesterEmail,
    workspace: r.tenant,
    priority: r.priority,
    status: r.status,
    assignee: r.assignee,
    createdAt: r.createdAt,
    lastActivityAt: r.updatedAt,
    attachments: r._count.attachments,
    hasRecording: r.attachments.length > 0,
  };
}

export type SupportInbox = {
  rows: SupportListRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Each tab's count under the other filters, so a tab never undercounts what it would show. */
  counts: Record<SupportStatusTab, number>;
  kpis: SupportKpis;
  /** The workspace filter's choices: workspaces that have asked for support, by name. */
  workspaces: { slug: string; name: string }[];
  assignees: SupportAssigneeOption[];
};

/**
 * The Support inbox: 50 a page, the most critical first and then the oldest — what should be looked
 * at next is at the top. `viewerId` is who "assigned to me" means.
 */
export async function supportInbox(f: SupportFilters, viewerId: string, now = new Date()): Promise<SupportInbox> {
  const table = controlDb().supportRequest;
  const base = filterWhere(f, viewerId);
  const where = (tab: SupportStatusTab): Prisma.SupportRequestWhereInput => ({ AND: [base, TAB_WHERE[tab]] });
  const [open, waiting, resolved, closed, all, kpis, workspaces, assignees] = await Promise.all([
    table.count({ where: where("open") }),
    table.count({ where: where("waiting") }),
    table.count({ where: where("resolved") }),
    table.count({ where: where("closed") }),
    table.count({ where: base }),
    supportKpis(now),
    controlDb().tenant.findMany({ where: { supportRequests: { some: {} } }, orderBy: [{ name: "asc" }, { slug: "asc" }], take: 500, select: { slug: true, name: true } }),
    supportAssignees(),
  ]);
  const counts: Record<SupportStatusTab, number> = { open, waiting, resolved, closed, all };
  const total = counts[f.status];
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, f.page), last);
  const rows = total
    ? await table.findMany({
        where: where(f.status),
        orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: LIST_SELECT,
      })
    : [];
  return { rows: rows.map(toListRow), total, page, pageSize: PAGE_SIZE, counts, kpis, workspaces, assignees };
}

/** The inbox's KPI cards. The median is over requests made in the last 30 days that have had a reply emailed. */
export async function supportKpis(now = new Date()): Promise<SupportKpis> {
  const table = controlDb().supportRequest;
  const [open, urgentOpen, waiting, responded] = await Promise.all([
    table.count({ where: { status: { in: OPEN_STATUSES } } }),
    table.count({ where: { status: { in: OPEN_STATUSES }, priority: "URGENT" } }),
    table.count({ where: { status: "WAITING" } }),
    table.findMany({
      where: { createdAt: { gte: new Date(now.getTime() - 30 * DAY_MS) }, firstResponseAt: { not: null } },
      select: { createdAt: true, firstResponseAt: true },
      take: 10_000,
    }),
  ]);
  const waits = responded
    .map((r) => (r.firstResponseAt ? r.firstResponseAt.getTime() - r.createdAt.getTime() : NaN))
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const mid = Math.floor(waits.length / 2);
  const median = waits.length === 0 ? null : waits.length % 2 ? waits[mid] : Math.round((waits[mid - 1] + waits[mid]) / 2);
  return { open, urgentOpen, waiting, medianFirstResponseMs: median, firstResponseSample: waits.length };
}

/** The Overview's card and the sidebar's badge: open (and in progress), and how many of those are urgent. */
export async function supportOverviewCounts(): Promise<{ open: number; urgent: number }> {
  const table = controlDb().supportRequest;
  const [open, urgent] = await Promise.all([
    table.count({ where: { status: { in: OPEN_STATUSES } } }),
    table.count({ where: { status: { in: OPEN_STATUSES }, priority: "URGENT" } }),
  ]);
  return { open, urgent };
}

/** Who a request may be assigned to: active staff whose role acts on requests, by name. */
export async function supportAssignees(): Promise<SupportAssigneeOption[]> {
  return controlDb().platformUser.findMany({
    where: { active: true, role: { in: [...SUPPORT_AGENTS] } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, role: true },
  });
}

/** One workspace's requests, newest first, for its 360 page. */
export async function supportRequestsForTenant(tenantId: string, take = 50): Promise<SupportTenantRow[]> {
  const rows = await controlDb().supportRequest.findMany({
    where: { tenantId: String(tenantId) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(1, Math.floor(take) || 50), 200),
    select: { id: true, number: true, subject: true, status: true, priority: true, requesterName: true, createdAt: true, updatedAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    ref: supportRef(r.number),
    subject: r.subject,
    status: r.status,
    priority: r.priority,
    requesterName: r.requesterName,
    createdAt: r.createdAt,
    lastActivityAt: r.updatedAt,
  }));
}

// ─── One request ─────────────────────────────────────────────────────────────────────────────────

/** A request's context JSON (written by src/actions/support.ts) as the console shows it; anything malformed is left out. */
function contextView(context: unknown, ip: string | null): { view: SupportContextView; perf: PerfSnapshot | null } {
  const c = isObj(context) ? context : {};
  const ws = isObj(c.workspace) ? c.workspace : null;
  const userAgent = str(c.userAgent, 400);
  const device = userAgent ? deviceFromUserAgent(userAgent) : null;
  let perf: PerfSnapshot | null = null;
  if (isObj(c.perf)) {
    const p: PerfSnapshot = {};
    for (const key of ["dns", "tcp", "ttfb", "domContentLoaded", "load", "transferSize"] as const) {
      const v = c.perf[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) p[key] = Math.round(v);
    }
    perf = Object.keys(p).length ? p : null;
  }
  return {
    view: {
      workspace: ws && str(ws.id) && str(ws.slug) ? { id: str(ws.id)!, slug: str(ws.slug)!, name: str(ws.name) ?? str(ws.slug)! } : null,
      page: str(c.page, 300),
      userAgent,
      browser: device && device !== "Unknown device" ? device : null,
      screen: str(c.screen, 40),
      viewport: str(c.viewport, 40),
      timezone: str(c.timezone, 64),
      language: str(c.language, 20),
      ip,
      appVersion: str(c.appVersion, 100),
    },
    perf,
  };
}

function consoleLogView(value: unknown): ConsoleEntry[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter(isObj)
    .map((e) => ({ at: str(e.at, 40) ?? "", level: e.level === "error" ? ("error" as const) : ("warn" as const), message: str(e.message, 500) ?? "" }))
    .filter((e) => e.message);
}

function entryView(e: { id: string; kind: string; body: string | null; meta: unknown; createdAt: Date; author: { id: string; name: string } | null; authorId: string | null }): SupportEntryView | null {
  const base = { id: e.id, at: e.createdAt, author: e.author ?? (e.authorId ? { id: e.authorId, name: GONE_STAFF } : null) };
  const m = isObj(e.meta) ? e.meta : {};
  switch (e.kind) {
    case "REPLY":
      return { ...base, kind: "REPLY", body: e.body ?? "", emailed: m.emailed === true, to: str(m.to, 254), error: str(m.error, 300) };
    case "NOTE":
      return { ...base, kind: "NOTE", body: e.body ?? "" };
    case "STATUS":
      return { ...base, kind: "STATUS", from: statusOf(m.from), to: statusOf(m.to) };
    case "PRIORITY":
      return { ...base, kind: "PRIORITY", from: priorityOf(m.from), to: priorityOf(m.to) };
    case "ASSIGN":
      return { ...base, kind: "ASSIGN", from: str(m.fromName, 120), to: str(m.toName, 120) };
    default:
      return null;
  }
}

function attachmentView(a: { id: string; kind: SupportAttachmentKindKey; filename: string; mime: string; size: number; durationMs: number | null; purgedAt: Date | null; createdAt: Date }): SupportAttachmentView {
  return { id: a.id, kind: a.kind, filename: a.filename, mime: a.mime, size: a.size, durationMs: a.durationMs, purged: !!a.purgedAt, createdAt: a.createdAt, href: `/support-files/${encodeURIComponent(a.id)}` };
}

/** How many timeline entries one page shows: the newest this many. */
const ENTRY_CAP = 500;

/** One request, by its number (SR-1042 → 1042); null when there is no such request. */
export async function supportRequestDetail(number: number): Promise<SupportDetail | null> {
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const control = controlDb();
  const row = await control.supportRequest.findUnique({
    where: { number },
    select: {
      id: true,
      number: true,
      tenantId: true,
      requesterUserId: true,
      requesterName: true,
      requesterEmail: true,
      requesterRole: true,
      mobile: true,
      subject: true,
      body: true,
      priority: true,
      status: true,
      context: true,
      consoleLog: true,
      recordingConsentAt: true,
      ip: true,
      createdAt: true,
      updatedAt: true,
      firstResponseAt: true,
      resolvedAt: true,
      closedAt: true,
      tenant: { select: { id: true, slug: true, name: true, status: true, entitlements: true } },
      assignee: { select: { id: true, name: true } },
      attachments: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, kind: true, filename: true, mime: true, size: true, durationMs: true, purgedAt: true, createdAt: true },
      },
      entries: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: ENTRY_CAP,
        select: { id: true, kind: true, body: true, meta: true, createdAt: true, authorId: true, author: { select: { id: true, name: true } } },
      },
    },
  });
  if (!row) return null;

  const planKeys = isObj(row.tenant.entitlements) && Array.isArray(row.tenant.entitlements.plans) ? row.tenant.entitlements.plans.filter((p): p is string => typeof p === "string") : [];
  const [grant, assignees, settings, plans] = await Promise.all([
    activeSupportGrant(row.tenantId, true),
    supportAssignees(),
    getSupportSettings().catch(() => SUPPORT_DEFAULTS),
    planKeys.length ? control.plan.findMany({ where: { key: { in: planKeys } }, select: { key: true, name: true } }) : Promise.resolve([]),
  ]);
  const { view: context, perf } = contextView(row.context, row.ip);

  return {
    id: row.id,
    number: row.number,
    ref: supportRef(row.number),
    subject: row.subject,
    body: row.body,
    priority: row.priority,
    status: row.status,
    assignee: row.assignee,
    requester: { userId: row.requesterUserId, name: row.requesterName, email: row.requesterEmail, role: row.requesterRole, mobile: row.mobile },
    workspace: {
      id: row.tenant.id,
      slug: row.tenant.slug,
      name: row.tenant.name,
      status: row.tenant.status,
      plans: planKeys.map((key) => ({ key, name: plans.find((p) => p.key === key)?.name ?? key })),
    },
    context,
    consoleLog: row.recordingConsentAt ? consoleLogView(row.consoleLog) : null,
    perf: row.recordingConsentAt ? perf : null,
    recordingConsentAt: row.recordingConsentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    firstResponseAt: row.firstResponseAt,
    resolvedAt: row.resolvedAt,
    closedAt: row.closedAt,
    attachments: row.attachments.map(attachmentView),
    entries: row.entries
      .map(entryView)
      .filter((e): e is SupportEntryView => e !== null)
      .reverse(),
    grant: grant ? { level: grant.level, expiresAt: grant.expiresAt, grantedByName: grant.grantedByName } : null,
    assignees,
    supportEmail: settings.email,
  };
}

// ─── The file route ──────────────────────────────────────────────────────────────────────────────

export type StaffAttachment = {
  id: string;
  requestId: string;
  number: number;
  tenantId: string;
  kind: SupportAttachmentKindKey;
  filename: string;
  mime: string;
  size: number;
  /** For openAttachment (src/lib/support/storage.ts); never shown. */
  storageKey: string;
  purgedAt: Date | null;
};

/** An attachment by id, for the console's file route; null for an id that is not one or names nothing. */
export async function supportAttachmentForStaff(id: string): Promise<StaffAttachment | null> {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{10,64}$/.test(id)) return null;
  const a = await controlDb().supportAttachment.findUnique({
    where: { id },
    select: { id: true, requestId: true, kind: true, filename: true, mime: true, size: true, storageKey: true, purgedAt: true, request: { select: { number: true, tenantId: true } } },
  });
  if (!a) return null;
  return { id: a.id, requestId: a.requestId, number: a.request.number, tenantId: a.request.tenantId, kind: a.kind, filename: a.filename, mime: a.mime, size: a.size, storageKey: a.storageKey, purgedAt: a.purgedAt };
}

const OPEN_AUDIT_EVERY_MS = 10 * 60_000;
const OPENED_MAX = 5_000;
/**
 * When each staff member last had each attachment's opening audited — a video player asks for the
 * same file in a dozen ranges, and that is one look, not twelve. Console-wide (staff are the
 * platform's, not a workspace's), keyed "<staffId>|<attachmentId>", and bounded.
 */
const opened = new Map<string, number>();

/**
 * Audits `support.file.open` — at most once per staff member per attachment per ten minutes. Returns
 * whether it wrote a row. The detail is ids, the kind and the type: never the file's name or bytes.
 * If the write fails it throws, and the next request tries again.
 */
export async function auditAttachmentOpen(staff: Staff, attachment: StaffAttachment, now: number = Date.now()): Promise<boolean> {
  const key = `${staff.id}|${attachment.id}`;
  const last = opened.get(key);
  if (last !== undefined && now - last < OPEN_AUDIT_EVERY_MS) return false;
  // Marked before the write, so the parallel range requests of one play all see it.
  opened.delete(key);
  if (opened.size >= OPENED_MAX) {
    const oldest = opened.keys().next().value;
    if (oldest !== undefined) opened.delete(oldest);
  }
  opened.set(key, now);
  try {
    await consoleAudit(
      staff,
      "support.file.open",
      { number: attachment.number, requestId: attachment.requestId, attachmentId: attachment.id, kind: attachment.kind, mime: attachment.mime, size: attachment.size },
      attachment.tenantId,
    );
  } catch (err) {
    opened.delete(key);
    throw err;
  }
  return true;
}

/** Only for check suites: forget which openings were audited. */
export function forgetAuditedOpens(): void {
  opened.clear();
}
