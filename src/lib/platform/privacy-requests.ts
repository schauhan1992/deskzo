import type { PrivacyRequestKind, PrivacyRequestStatus, Prisma } from "@deskzo/control-client";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
import { PRIVACY_DUE_DAYS, PRIVACY_LIMITS, isPrivacyStatus, privacyRef, type PrivacyRelation } from "@/components/site/privacy-fields";

/**
 * Privacy requests (owner, 23 Oct 2026): what the public site's form (deskzo.com/privacy/request) sends —
 * a copy of one's data, a correction, erasure, withdrawing consent, nominating someone, a grievance — kept in
 * the control plane and handled in the console's Privacy requests by OWNER, ADMIN and SUPPORT, never the
 * CMS's editors. Each is due 30 days after it came in, the period the privacy notice promises.
 *
 * Data a company keeps in its own workspace is the company's to answer for (it is the Data Fiduciary, or the
 * controller); a request about it is taken all the same, and staff point the person to the company.
 */

export type NewPrivacyRequest = { kind: PrivacyRequestKind; name: string; email: string; relation: PrivacyRelation; company: string | null; message: string; ip: string | null };

/** Keeps a request the site's action has already checked. Null without a control plane. */
export async function recordPrivacyRequest(input: NewPrivacyRequest, now = new Date()): Promise<{ id: string; ref: string; dueAt: Date } | null> {
  if (!controlConfigured()) return null;
  const dueAt = new Date(now.getTime() + PRIVACY_DUE_DAYS * 86_400_000);
  const row = await controlDb().privacyRequest.create({
    data: {
      kind: input.kind,
      name: input.name.slice(0, PRIVACY_LIMITS.name),
      email: input.email.slice(0, PRIVACY_LIMITS.email),
      relation: input.relation,
      company: input.company?.slice(0, PRIVACY_LIMITS.company) || null,
      message: input.message.slice(0, PRIVACY_LIMITS.message),
      ip: input.ip?.slice(0, 64) || null,
      createdAt: now,
      dueAt,
    },
    select: { id: true, seq: true, dueAt: true },
  });
  return { id: row.id, ref: privacyRef(row.seq), dueAt: row.dueAt };
}

export type PrivacyRequestRow = {
  id: string;
  ref: string;
  kind: PrivacyRequestKind;
  name: string;
  email: string;
  relation: string;
  company: string | null;
  message: string;
  status: PrivacyRequestStatus;
  notes: string | null;
  createdAt: Date;
  dueAt: Date;
  closedAt: Date | null;
  overdue: boolean;
};

const OPEN: PrivacyRequestStatus[] = ["NEW", "IN_PROGRESS"];

/** The console's list: open ones first, the oldest due first; then the closed, newest first. `status` narrows it. */
export async function listPrivacyRequests(filters: { status?: string } = {}, now = new Date()): Promise<PrivacyRequestRow[]> {
  if (!controlConfigured()) return [];
  const status = isPrivacyStatus(filters.status) ? filters.status : undefined;
  const where: Prisma.PrivacyRequestWhereInput = status ? { status } : filters.status === "open" ? { status: { in: OPEN } } : {};
  const rows = await controlDb().privacyRequest.findMany({ where, orderBy: [{ createdAt: "desc" }], take: 500 });
  return rows
    .map((r) => ({
      id: r.id,
      ref: privacyRef(r.seq),
      kind: r.kind,
      name: r.name,
      email: r.email,
      relation: r.relation,
      company: r.company,
      message: r.message,
      status: r.status,
      notes: r.notes,
      createdAt: r.createdAt,
      dueAt: r.dueAt,
      closedAt: r.closedAt,
      overdue: OPEN.includes(r.status) && r.dueAt.getTime() < now.getTime(),
    }))
    .sort((a, b) => {
      const ao = OPEN.includes(a.status) ? 0 : 1;
      const bo = OPEN.includes(b.status) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return ao === 0 ? a.dueAt.getTime() - b.dueAt.getTime() : b.createdAt.getTime() - a.createdAt.getTime();
    });
}

/** Open requests, and how many of them are past their due date — for the console's badge. */
export async function privacyRequestCounts(now = new Date()): Promise<{ open: number; overdue: number }> {
  if (!controlConfigured()) return { open: 0, overdue: 0 };
  const [open, overdue] = await Promise.all([
    controlDb().privacyRequest.count({ where: { status: { in: OPEN } } }),
    controlDb().privacyRequest.count({ where: { status: { in: OPEN }, dueAt: { lt: now } } }),
  ]);
  return { open, overdue };
}

/** A staff member's change to a request's status or notes. Closing it stamps when; reopening clears that. */
export async function updatePrivacyRequest(id: string, change: { status?: unknown; notes?: unknown }, staffId: string, now = new Date()): Promise<{ ref: string; status: PrivacyRequestStatus }> {
  const control = controlDb();
  const existing = await control.privacyRequest.findUnique({ where: { id }, select: { id: true, status: true, closedAt: true } });
  if (!existing) throw new ConsoleRefused("That request no longer exists.");
  const data: Prisma.PrivacyRequestUpdateInput = { handledBy: `staff:${staffId}` };
  if (change.status !== undefined) {
    if (!isPrivacyStatus(change.status)) throw new ConsoleRefused("Choose a status.");
    data.status = change.status;
    const closing = change.status === "DONE" || change.status === "REFUSED";
    data.closedAt = closing ? (existing.closedAt ?? now) : null;
  }
  if (change.notes !== undefined) {
    const notes = typeof change.notes === "string" ? change.notes.replace(/\r\n?/g, "\n").trim() : "";
    if (notes.length > PRIVACY_LIMITS.notes) throw new ConsoleRefused(`Keep the notes under ${PRIVACY_LIMITS.notes.toLocaleString("en-IN")} characters.`);
    data.notes = notes || null;
  }
  const row = await control.privacyRequest.update({ where: { id }, data, select: { seq: true, status: true } });
  return { ref: privacyRef(row.seq), status: row.status };
}
