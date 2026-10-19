import type { ActivityKind, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { callAccess, throughAccount, timelineAccess } from "@/lib/authz/access";
import { getDownlineUserIds } from "@/lib/org-chart";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { notMigratedYet } from "@/lib/not-migrated";
import { leadStages } from "@/lib/pipeline/server";
import { readStageNote } from "@/lib/pipeline/rules";
import { listLeadMasker, maskLeadTitle, type FieldMasker } from "@/lib/leads/masking";
import { companyPath, expensePath, leadPath, orderPath, ticketPath, visitPath } from "@/lib/record-links";
import { documentPath } from "@/lib/trade-documents";
import { ACTIVITY_GROUPS, type ActivityGroupKey, type ActivityItem, type ActivityPage, type FieldChange } from "@/lib/activity/types";

export { ACTIVITY_GROUPS, type ActivityGroupKey, type ActivityItem, type ActivityPage } from "@/lib/activity/types";

/**
 * Activity (owner, 19 Oct 2026): everything that happened to a lead, a customer or a vendor — and
 * everything a person did — newest first, each line saying what happened, who did it, and when.
 *
 * Merged from where it's already recorded:
 *   · changes — the audit log, each entry filed under its company and lead (src/lib/activity/subjects.ts),
 *     with what an edit changed field by field where the form says;
 *   · what people logged on leads — notes, calls, meetings, emails, stage moves — by the activities rule
 *     (own and team's unless `activities.viewAll`);
 *   · calls, by the calls rule, one already on a lead's log not twice;
 *   · business emails sent — a document, a notice, a ticket reply — never campaigns;
 *   · for a person, their sign-ins, exports and prints from the security log.
 *
 * Whoever can open the record sees its Activity, but only the kinds they may see elsewhere: an invoice's
 * line to someone who may see documents, a payment's to someone who may see payments. A person's activity
 * is theirs to see, their managers', and whoever sees everyone's (`activity.viewAll`).
 */

/** Which group an audit entry's kind is in. A kind not here is "other". */
const ENTITY_GROUP: Record<string, ActivityGroupKey> = {
  Company: "company",
  DomainProfile: "company",
  CompanyBankAccount: "company",
  Contact: "contacts",
  ContactConsent: "contacts",
  Lead: "leads",
  Order: "orders",
  CompanyProduct: "orders",
  OrderRebate: "orders",
  TradeDocument: "documents",
  EwayBill: "documents",
  Consignment: "documents",
  Payment: "payments",
  PaymentFollowUp: "payments",
  VendorCredit: "purchase",
  VendorStatement: "purchase",
  Ticket: "tickets",
  Task: "tasks",
  CalendarEvent: "meetings",
  Booking: "meetings",
  Visit: "visits",
  CallLog: "calls",
  Project: "projects",
  ProjectDocument: "projects",
  ProjectBillingMilestone: "projects",
  Expense: "expenses",
  FeedbackRequest: "feedback",
  PortalLogin: "portal",
};

/** What a viewer must hold to see a group's lines; a group not here, whoever may open the record. */
const GROUP_PERMISSION: Partial<Record<ActivityGroupKey, string>> = {
  contacts: "contacts.view",
  leads: "leads.view",
  notes: "leads.view",
  orders: "orders.view",
  documents: "documents.view",
  purchase: "documents.view",
  payments: "payments.view",
  tickets: "tickets.view",
  calls: "calls.view",
  visits: "visits.view",
  projects: "projects.view",
  emails: "emails.view",
  // A colleague's expense claim is theirs and the approvers': on a person's own feed they see their own.
  expenses: "expenses.viewAll",
};

export type ActivityOptions = {
  /** Older than this — the next page. */
  before?: Date;
  take?: number;
  groups?: ActivityGroupKey[];
  /** Only what this person did. */
  personId?: string;
  from?: Date;
  to?: Date;
};

const DEFAULT_TAKE = 50;

/** What a line is about, for its link: the record, and for a contact its company. */
type Target = { type: string; id: string; companyId?: string | null };
/** A line as it's built, with what it opens still to look up (`withLinks`). */
type Built = ActivityItem & { target?: Target | null };

/** Sign-ins and changes outside every group are a person's, never a record's: the person view adds them. */
const PERSON_ONLY = new Set<ActivityGroupKey>(["signins", "other"]);

async function allowedGroups(viewerId: string): Promise<Set<ActivityGroupKey>> {
  const out = new Set<ActivityGroupKey>();
  await Promise.all(
    ACTIVITY_GROUPS.filter((g) => !PERSON_ONLY.has(g.key)).map(async (g) => {
      const key = GROUP_PERMISSION[g.key];
      if (!key || (await can(viewerId, key))) out.add(g.key);
    }),
  );
  return out;
}

function timeWhere(field: string, opts: ActivityOptions): Record<string, unknown> {
  const range: Record<string, Date> = {};
  if (opts.before) range.lt = opts.before;
  if (opts.from) range.gte = opts.from;
  if (opts.to) range.lte = opts.to;
  return Object.keys(range).length ? { [field]: range } : {};
}

const wants = (opts: ActivityOptions, allowed: Set<ActivityGroupKey>, group: ActivityGroupKey) => allowed.has(group) && (!opts.groups?.length || opts.groups.includes(group));

const AUDIT_SELECT = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  entityLabel: true,
  createdAt: true,
  changes: true,
  companyId: true,
  user: { select: { id: true, name: true } },
  impersonatedBy: { select: { name: true } },
} satisfies Prisma.AuditLogSelect;

type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof AUDIT_SELECT }>;

function auditItem(row: Omit<AuditRow, "changes" | "companyId"> & { changes?: unknown; companyId?: string | null }): Built {
  return {
    id: `audit-${row.id}`,
    at: row.createdAt.toISOString(),
    who: row.user,
    asBy: row.impersonatedBy?.name ?? null,
    group: ENTITY_GROUP[row.entityType] ?? "other",
    action: row.action,
    title: row.entityLabel,
    detail: null,
    changes: Array.isArray(row.changes) ? (row.changes as FieldChange[]) : [],
    href: null,
    target: { type: row.entityType, id: row.entityId, companyId: row.companyId ?? null },
  };
}

/** The audit entries matching, newest first — none where the workspace isn't migrated to file them. */
async function auditRows(where: Prisma.AuditLogWhereInput, take: number, migrated = true): Promise<Built[]> {
  try {
    const rows = await db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take, select: migrated ? AUDIT_SELECT : { ...AUDIT_SELECT, changes: false, companyId: false } });
    return rows.map(auditItem);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return [];
  }
}

const ACTIVITY_TITLE: Record<string, string> = { CALL: "Call logged", EMAIL: "Email logged", NOTE: "Note", MEETING: "Meeting logged", STAGE_CHANGE: "Stage moved" };
const ACTIVITY_GROUP: Record<string, ActivityGroupKey> = { CALL: "calls", EMAIL: "emails", NOTE: "notes", MEETING: "notes", STAGE_CHANGE: "leads" };

/** What people logged on leads — by the activities rule. */
async function loggedRows(viewerId: string, where: Prisma.ActivityWhereInput, opts: ActivityOptions, take: number, masker: FieldMasker) {
  const [rows, { stages }] = await Promise.all([
    db.activity.findMany({
      where: { AND: [where, timeWhere("occurredAt", opts), await timelineAccess(viewerId)] },
      orderBy: { occurredAt: "desc" },
      take,
      select: { id: true, type: true, notes: true, occurredAt: true, leadId: true, user: { select: { id: true, name: true } }, lead: { select: { title: true } } },
    }),
    leadStages(),
  ]);
  return rows.map((a) => ({
    item: {
      id: `logged-${a.id}`,
      at: a.occurredAt.toISOString(),
      who: a.user,
      asBy: null,
      group: ACTIVITY_GROUP[a.type] ?? "notes",
      action: null,
      title: `${ACTIVITY_TITLE[a.type] ?? "Logged"} — ${maskLeadTitle(masker, a.lead.title)}`,
      detail: a.type === "STAGE_CHANGE" ? readStageNote(a.notes, stages) : a.notes,
      changes: [],
      href: null,
      target: { type: "Lead", id: a.leadId },
    } satisfies Built,
    callKey: a.type === "CALL" ? `${a.leadId}|${a.user.id}|${a.occurredAt.getTime()}` : null,
  }));
}

/** Calls, by the calls rule; one already on a lead's log isn't listed twice. */
async function callRows(viewerId: string, where: Prisma.CallLogWhereInput, opts: ActivityOptions, take: number, onLeads: Set<string>): Promise<Built[]> {
  if (!(await moduleAvailableForTenant("calls"))) return [];
  const rows = await db.callLog.findMany({
    where: { AND: [where, timeWhere("startedAt", opts), await throughAccount(viewerId, "view"), await callAccess(viewerId, "view")] },
    orderBy: { startedAt: "desc" },
    take,
    select: {
      id: true,
      direction: true,
      outcome: true,
      phoneNumber: true,
      notes: true,
      startedAt: true,
      durationSeconds: true,
      leadId: true,
      companyId: true,
      user: { select: { id: true, name: true } },
      contact: { select: { name: true } },
      company: { select: { name: true } },
    },
  });
  return rows
    .filter((c) => !c.leadId || !onLeads.has(`${c.leadId}|${c.user.id}|${c.startedAt.getTime()}`))
    .map((c) => ({
      id: `call-${c.id}`,
      at: c.startedAt.toISOString(),
      who: c.user,
      asBy: null,
      group: "calls" as const,
      action: null,
      title: `${c.direction === "INBOUND" ? "Call from" : "Call to"} ${c.contact?.name ?? c.phoneNumber}, ${c.company.name} — ${c.outcome.toLowerCase().replace(/_/g, " ")}`,
      detail: [c.durationSeconds ? `${Math.round(c.durationSeconds / 60)} min` : null, c.notes].filter(Boolean).join(" · ") || null,
      changes: [],
      href: null,
      target: c.leadId ? { type: "Lead", id: c.leadId } : { type: "Company", id: c.companyId },
    }));
}

/** Business emails sent — a document, a notice, a reply — never a campaign. */
async function emailRows(where: Prisma.MarketingMessageWhereInput, opts: ActivityOptions, take: number): Promise<Built[]> {
  const rows = await db.marketingMessage.findMany({
    where: { AND: [where, { messageClass: "TRANSACTIONAL", status: "SENT" }, timeWhere("sentAt", opts)] },
    orderBy: { sentAt: "desc" },
    take,
    select: { id: true, subject: true, toEmail: true, sentAt: true, companyId: true, sentBy: { select: { id: true, name: true } } },
  });
  return rows.map((m) => ({
    id: `email-${m.id}`,
    at: (m.sentAt ?? new Date(0)).toISOString(),
    who: m.sentBy,
    asBy: null,
    group: "emails" as const,
    action: null,
    title: `Email to ${m.toEmail ?? "a contact"}`,
    detail: m.subject,
    changes: [],
    href: null,
    target: m.companyId ? { type: "Company", id: m.companyId } : null,
  }));
}

const SIGN_IN_KINDS: ActivityKind[] = ["LOGIN", "LOGIN_FAILED", "LOGOUT", "PASSWORD_CHANGED", "TWO_FACTOR_ENABLED", "EXPORT", "PRINT", "IMPERSONATION_STARTED", "IMPERSONATION_ENDED"];

/** A person's sign-ins, exports and prints, from the security log. */
async function signInRows(personId: string, opts: ActivityOptions, take: number): Promise<Built[]> {
  const rows = await db.activityLog.findMany({
    where: { AND: [{ userId: personId, kind: { in: SIGN_IN_KINDS } }, timeWhere("createdAt", opts)] },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, summary: true, createdAt: true, ipAddress: true, userId: true, userName: true },
  });
  return rows.map((r) => ({
    id: `signin-${r.id}`,
    at: r.createdAt.toISOString(),
    who: r.userId ? { id: r.userId, name: r.userName ?? "" } : null,
    asBy: null,
    group: "signins" as const,
    action: null,
    title: r.summary,
    detail: r.ipAddress ? `From ${r.ipAddress}` : null,
    changes: [],
    href: null,
  }));
}

const LEAD_WORD: Record<string, string> = { CREATE: "Lead added", UPDATE: "Lead changed", DELETE: "Lead removed" };

/**
 * Where this viewer sees leads masked (src/lib/leads/masking.ts), a lead's own change lines say only that it
 * changed — their wording carries its title, and what changed may be a field they can't see.
 */
function maskLeadLines(items: Built[], masker: FieldMasker): Built[] {
  if (!masker.active) return items;
  return items.map((i) => (i.group === "leads" && i.id.startsWith("audit-") ? { ...i, title: LEAD_WORD[i.action ?? "UPDATE"] ?? "Lead changed", changes: [] } : i));
}

/** How each kind of record is opened. A contact opens its company's Contacts tab. */
const OPENS: Record<string, "lead" | "order" | "ticket" | "visit" | "expense" | "company" | "document" | "contact"> = {
  Lead: "lead",
  Order: "order",
  CompanyProduct: "order",
  Ticket: "ticket",
  Visit: "visit",
  Expense: "expense",
  Company: "company",
  DomainProfile: "company",
  TradeDocument: "document",
  Contact: "contact",
  ContactConsent: "contact",
};

/**
 * Each line's link, by its readable address (src/lib/record-links.ts), looked up for the page's lines in one
 * read a kind. A record since deleted has none, nor the record the feed is on. The page it opens checks access.
 */
async function withLinks(items: Built[], self: { companyId?: string; leadId?: string } = {}): Promise<ActivityItem[]> {
  const ids = (kind: string) => [...new Set(items.flatMap((i) => (i.target && OPENS[i.target.type] === kind ? [i.target.id] : [])))];
  const read = async (wanted: string[], rows: (ids: string[]) => Promise<{ id: string; seq: number }[]>) => (wanted.length ? new Map((await rows(wanted)).map((r) => [r.id, r.seq])) : new Map<string, number>());
  const companyIds = [...new Set([...ids("company"), ...items.flatMap((i) => (i.target && OPENS[i.target.type] === "contact" && i.target.companyId ? [i.target.companyId] : []))])];
  const [leads, orders, tickets, visits, expenses, companies, documents] = await Promise.all([
    read(ids("lead"), async (w) => (await db.lead.findMany({ where: { id: { in: w } }, select: { id: true, leadSeq: true } })).map((r) => ({ id: r.id, seq: r.leadSeq }))),
    read(ids("order"), async (w) => (await db.companyProduct.findMany({ where: { id: { in: w } }, select: { id: true, orderSeq: true } })).map((r) => ({ id: r.id, seq: r.orderSeq }))),
    read(ids("ticket"), async (w) => (await db.ticket.findMany({ where: { id: { in: w } }, select: { id: true, ticketSeq: true } })).map((r) => ({ id: r.id, seq: r.ticketSeq }))),
    read(ids("visit"), async (w) => (await db.visit.findMany({ where: { id: { in: w } }, select: { id: true, visitSeq: true } })).map((r) => ({ id: r.id, seq: r.visitSeq }))),
    read(ids("expense"), async (w) => (await db.expense.findMany({ where: { id: { in: w } }, select: { id: true, expenseSeq: true } })).map((r) => ({ id: r.id, seq: r.expenseSeq }))),
    read(companyIds, async (w) => (await db.company.findMany({ where: { id: { in: w } }, select: { id: true, companySeq: true } })).map((r) => ({ id: r.id, seq: r.companySeq }))),
    ids("document").length ? db.tradeDocument.findMany({ where: { id: { in: ids("document") } }, select: { id: true } }).then((r) => new Set(r.map((d) => d.id))) : Promise.resolve(new Set<string>()),
  ]);
  const at = (map: Map<string, number>, id: string, path: (seq: number) => string) => (map.has(id) ? path(map.get(id)!) : null);
  return items.map(({ target, ...item }) => {
    let href: string | null = null;
    switch (target ? OPENS[target.type] : undefined) {
      case "lead":
        href = target!.id === self.leadId ? null : at(leads, target!.id, leadPath);
        break;
      case "order":
        href = at(orders, target!.id, orderPath);
        break;
      case "ticket":
        href = at(tickets, target!.id, ticketPath);
        break;
      case "visit":
        href = at(visits, target!.id, visitPath);
        break;
      case "expense":
        href = at(expenses, target!.id, expensePath);
        break;
      case "company":
        href = target!.id === self.companyId ? null : at(companies, target!.id, companyPath);
        break;
      case "document":
        href = documents.has(target!.id) ? documentPath(target!.id) : null;
        break;
      case "contact":
        href = target!.companyId ? at(companies, target!.companyId, (seq) => `${companyPath(seq)}?tab=contacts`) : null;
        break;
    }
    return { ...item, href };
  });
}

async function page(lists: Built[][], take: number, self?: { companyId?: string; leadId?: string }): Promise<ActivityPage> {
  const merged = lists.flat().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const items = merged.slice(0, take);
  const more = merged.length > take || lists.some((l) => l.length >= take);
  return { items: await withLinks(items, self), more, before: more && items.length ? items[items.length - 1]!.at : null };
}

/**
 * A lead's, or a customer's or vendor's, Activity. The caller has checked the viewer may open the record.
 * `of.companyId`: the company, its contacts, leads, orders, documents, payments, tickets and the rest.
 */
export async function recordActivity(viewerId: string, of: { companyId: string } | { leadId: string }, opts: ActivityOptions = {}): Promise<ActivityPage> {
  const take = Math.min(Math.max(opts.take ?? DEFAULT_TAKE, 1), 200);
  const allowed = await allowedGroups(viewerId);
  const person = opts.personId ? { userId: opts.personId } : {};
  const entityTypes = Object.entries(ENTITY_GROUP).filter(([, g]) => wants(opts, allowed, g)).map(([t]) => t);
  const subject = "companyId" in of ? { companyId: of.companyId } : { leadId: of.leadId };
  const masker = await listLeadMasker(viewerId);

  const [audit, logged] = await Promise.all([
    entityTypes.length ? auditRows({ AND: [subject, person, { entityType: { in: entityTypes } }, timeWhere("createdAt", opts)] }, take) : Promise.resolve([]),
    wants(opts, allowed, "notes") || wants(opts, allowed, "calls") || wants(opts, allowed, "leads")
      ? loggedRows(viewerId, { AND: ["companyId" in of ? { lead: { companyId: of.companyId } } : { leadId: of.leadId }, opts.personId ? { userId: opts.personId } : {}] }, opts, take, masker)
      : Promise.resolve([]),
  ]);
  const loggedItems = logged.filter((l) => wants(opts, allowed, l.item.group));
  const onLeads = new Set(logged.map((l) => l.callKey).filter((k): k is string => !!k));
  const [calls, emails] = await Promise.all([
    wants(opts, allowed, "calls") ? callRows(viewerId, { AND: ["companyId" in of ? { companyId: of.companyId } : { leadId: of.leadId }, opts.personId ? { userId: opts.personId } : {}] }, opts, take, onLeads) : Promise.resolve([]),
    "companyId" in of && wants(opts, allowed, "emails") ? emailRows({ AND: [{ companyId: of.companyId }, opts.personId ? { sentByUserId: opts.personId } : {}] }, opts, take) : Promise.resolve([]),
  ]);
  // A change to a call is its own line already: the call itself is listed from the call log.
  return page([maskLeadLines(audit.filter((a) => a.group !== "calls"), masker), loggedItems.map((l) => l.item), calls, emails], take, subject);
}

/** Whether a viewer may see what a person did: their own, their team's as a manager, or everyone's. */
export async function mayViewPersonActivity(viewerId: string, personId: string): Promise<boolean> {
  if (viewerId === personId) return true;
  if (await can(viewerId, "activity.viewAll")) return true;
  return (await getDownlineUserIds(viewerId)).includes(personId);
}

/** Everything a person did. The caller has checked `mayViewPersonActivity`. */
export async function personActivity(viewerId: string, personId: string, opts: ActivityOptions = {}): Promise<ActivityPage> {
  const take = Math.min(Math.max(opts.take ?? DEFAULT_TAKE, 1), 200);
  const allowed = await allowedGroups(viewerId);
  // Changes to things outside every group — settings, roles, the vault — are for themselves and whoever sees everyone's.
  if (viewerId === personId || (await can(viewerId, "activity.viewAll"))) allowed.add("other");
  if (viewerId === personId) allowed.add("expenses");
  allowed.add("signins");
  const mapped = Object.entries(ENTITY_GROUP).filter(([, g]) => wants(opts, allowed, g)).map(([t]) => t);
  const kinds: Prisma.AuditLogWhereInput = wants(opts, allowed, "other") ? { OR: [{ entityType: { in: mapped } }, { entityType: { notIn: Object.keys(ENTITY_GROUP) } }] } : { entityType: { in: mapped } };
  const auditWhere: Prisma.AuditLogWhereInput = { AND: [{ userId: personId }, kinds, timeWhere("createdAt", opts)] };
  const masker = await listLeadMasker(viewerId);

  const [audit, logged] = await Promise.all([
    auditRows(auditWhere, take).then(async (rows) => (rows.length || !(await auditNeedsPlainRead()) ? rows : auditRows(auditWhere, take, false))),
    wants(opts, allowed, "notes") || wants(opts, allowed, "calls") || wants(opts, allowed, "leads") ? loggedRows(viewerId, { userId: personId }, opts, take, masker) : Promise.resolve([]),
  ]);
  const onLeads = new Set(logged.map((l) => l.callKey).filter((k): k is string => !!k));
  const [calls, emails, signIns] = await Promise.all([
    wants(opts, allowed, "calls") ? callRows(viewerId, { userId: personId }, opts, take, onLeads) : Promise.resolve([]),
    wants(opts, allowed, "emails") ? emailRows({ sentByUserId: personId }, opts, take) : Promise.resolve([]),
    wants(opts, allowed, "signins") ? signInRows(personId, opts, take) : Promise.resolve([]),
  ]);
  return page([maskLeadLines(audit.filter((a) => a.group !== "calls"), masker), logged.filter((l) => wants(opts, allowed, l.item.group)).map((l) => l.item), calls, emails, signIns], take);
}

/** A workspace not migrated yet has no `changes` column: a person's entries are read without it. */
async function auditNeedsPlainRead(): Promise<boolean> {
  try {
    await db.auditLog.findFirst({ select: { changes: true }, take: 1 });
    return false;
  } catch (err) {
    if (notMigratedYet(err)) return true;
    throw err;
  }
}

/** The kinds a viewer may filter by: on a record's feed, or a person's — sign-ins, and the rest for themselves or with the reach. */
export async function activityGroupsFor(viewerId: string, of: "record" | "person", personId?: string): Promise<ActivityGroupKey[]> {
  const allowed = await allowedGroups(viewerId);
  if (of === "person") {
    allowed.add("signins");
    if (personId === viewerId || (await can(viewerId, "activity.viewAll"))) allowed.add("other");
    if (personId === viewerId) allowed.add("expenses");
  }
  return ACTIVITY_GROUPS.map((g) => g.key).filter((k) => allowed.has(k));
}
