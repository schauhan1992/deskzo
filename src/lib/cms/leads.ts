import type { Prisma, SiteLeadStatus } from "@deskzo/control-client";
import { actorRef, cmsAudit, refLabels, type CmsActor } from "@/lib/cms/audit";
import { CmsRefused, LEAD_STATUSES, LEAD_TOPICS, type LeadDetail, type LeadFilters, type LeadRow, type Paged } from "@/lib/cms/types";
import { csvRow } from "@/lib/csv";
import { endOfIndianDay, formatIstDateTime, startOfIndianDay } from "@/lib/india-time";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";

/**
 * The leads inbox: requests from the public site's contact form (src/actions/platform/site.ts
 * sendContactRequest), kept in the control plane — every CMS role reads them; editors and admins
 * change their status and notes and export them.
 *
 * A lead's message and notes never go to the activity log; its id, status and counts do.
 */

export const LEADS_PAGE_SIZE = 30;
export const LEADS_EXPORT_CAP = 10_000;

/** What the contact form sends, already checked by it. */
export type NewLead = { name: string; email: string; company: string | null; phone: string | null; topic: string; message: string; ip: string | null };

/** Stores a contact request. Not an action: the site's action calls it after its own checks and limits. */
export async function recordLead(lead: NewLead): Promise<string | null> {
  if (!controlConfigured()) return null;
  const row = await controlDb().siteLead.create({
    data: {
      name: lead.name.slice(0, 120),
      email: lead.email.slice(0, 254),
      company: lead.company?.slice(0, 160) || null,
      phone: lead.phone?.slice(0, 32) || null,
      topic: (LEAD_TOPICS as readonly string[]).includes(lead.topic) ? lead.topic : "other",
      message: lead.message.slice(0, 4000),
      ip: lead.ip?.slice(0, 64) || null,
    },
    select: { id: true, topic: true },
  });
  await cmsAudit({ kind: "site" }, "lead.create", "lead", row.id, { topic: row.topic });
  return row.id;
}

function whereOf(filters: LeadFilters): Prisma.SiteLeadWhereInput {
  const status = filters.status && (LEAD_STATUSES as readonly string[]).includes(filters.status) ? filters.status : undefined;
  const topic = filters.topic && (LEAD_TOPICS as readonly string[]).includes(filters.topic) ? filters.topic : undefined;
  const from = filters.from ? startOfIndianDay(String(filters.from)) : null;
  const to = filters.to ? endOfIndianDay(String(filters.to)) : null;
  const q = typeof filters.q === "string" ? filters.q.trim().slice(0, 100) : "";
  return {
    ...(status ? { status } : {}),
    ...(topic ? { topic } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { company: { contains: q, mode: "insensitive" } },
            { message: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

const ROW_SELECT = { id: true, name: true, email: true, company: true, phone: true, topic: true, status: true, createdAt: true, updatedAt: true, handledBy: true, notes: true } as const;

/** The inbox: newest first, filtered, a page at a time — and how many there are of each status (over everything). */
export async function listLeads(filters: LeadFilters = {}): Promise<Paged<LeadRow> & { counts: Record<SiteLeadStatus, number> }> {
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const where = whereOf(filters);
  const [rows, total, grouped] = await Promise.all([
    controlDb().siteLead.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * LEADS_PAGE_SIZE, take: LEADS_PAGE_SIZE, select: ROW_SELECT }),
    controlDb().siteLead.count({ where }),
    controlDb().siteLead.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const labels = await refLabels(rows.map((r) => r.handledBy));
  const counts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0])) as Record<SiteLeadStatus, number>;
  return {
    rows: rows.map(({ notes, ...r }) => ({ ...r, handledBy: r.handledBy ? (labels.get(r.handledBy) ?? r.handledBy) : null, hasNotes: !!notes })),
    total,
    page,
    pageSize: LEADS_PAGE_SIZE,
    counts,
  };
}

export async function getLead(id: string): Promise<LeadDetail> {
  const row = /^[a-z0-9]{20,40}$/.test(String(id ?? "")) ? await controlDb().siteLead.findUnique({ where: { id } }) : null;
  if (!row) throw new CmsRefused("That lead no longer exists.");
  const labels = await refLabels([row.handledBy]);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company,
    phone: row.phone,
    topic: row.topic,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    handledBy: row.handledBy ? (labels.get(row.handledBy) ?? row.handledBy) : null,
    hasNotes: !!row.notes,
    message: row.message,
    notes: row.notes,
    ip: row.ip,
  };
}

/** A new status, new notes, or both. Notes are replaced whole; null or "" clears them. */
export async function updateLead(id: string, change: { status?: SiteLeadStatus; notes?: string | null }, actor: CmsActor): Promise<LeadDetail> {
  const before = await getLead(id);
  const data: Prisma.SiteLeadUpdateInput = { handledBy: actorRef(actor) };
  if (change?.status !== undefined) {
    if (!(LEAD_STATUSES as readonly string[]).includes(change.status)) throw new CmsRefused("Choose a status.");
    data.status = change.status;
  }
  if (change?.notes !== undefined) {
    const notes = String(change.notes ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
    if (notes.length > 4000) throw new CmsRefused("Keep the notes to 4,000 characters.");
    data.notes = notes || null;
  }
  await controlDb().siteLead.update({ where: { id: before.id }, data });
  await cmsAudit(actor, "lead.update", "lead", before.id, {
    ...(change?.status !== undefined && change.status !== before.status ? { from: before.status, to: change.status } : {}),
    ...(change?.notes !== undefined ? { notes: true } : {}),
  });
  return getLead(before.id);
}

/** The filtered inbox as CSV (at most 10,000 rows — narrow it down for more), audited. */
export async function exportLeadsCsv(filters: LeadFilters, actor: CmsActor, now = new Date()): Promise<{ filename: string; csv: string; rows: number }> {
  const where = whereOf(filters);
  const total = await controlDb().siteLead.count({ where });
  if (total > LEADS_EXPORT_CAP) throw new CmsRefused(`That is ${total.toLocaleString("en-IN")} leads — narrow the filters to ${LEADS_EXPORT_CAP.toLocaleString("en-IN")} or fewer.`);
  const rows = await controlDb().siteLead.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const lines = [
    csvRow(["Received (India time)", "Name", "Email", "Company", "Phone", "Topic", "Status", "Message", "Notes"]),
    ...rows.map((r) => csvRow([formatIstDateTime(r.createdAt), r.name, r.email, r.company ?? "", r.phone ?? "", r.topic, r.status, r.message, r.notes ?? ""])),
  ];
  await cmsAudit(actor, "lead.export", "lead", null, { rows: rows.length, filters: { status: filters.status ?? null, topic: filters.topic ?? null, from: filters.from ?? null, to: filters.to ?? null, q: !!filters.q } });
  return { filename: `website-leads-${now.toISOString().slice(0, 10)}.csv`, csv: `${lines.join("\r\n")}\r\n`, rows: rows.length };
}
