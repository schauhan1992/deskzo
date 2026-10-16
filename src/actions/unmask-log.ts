"use server";

import type { Prisma, UnmaskResult } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser, viewAsContext } from "@/lib/session";
import { actorContext } from "@/lib/authz/guards";
import { logActivity } from "@/lib/activity";
import { notMigratedYet } from "@/lib/not-migrated";
import { pageSlice } from "@/lib/pagination";
import { csvRow } from "@/lib/csv";
import { workspaceClock } from "@/lib/time/workspace";
import { parseRecordRef } from "@/lib/record-url";
import type { ActionResult } from "@/actions/company";
import { formatLeadId } from "@/lib/order-id";

/**
 * The Unmasking logs (src/lib/authz/unmask.ts): every attempt to unmask a lead, allowed or refused,
 * for the workspace's super admin and nobody else.
 *
 * "Super admin" is the account flag the database keeps to exactly one (`users.isSuperAdmin`), read
 * from the database on every call — not a role name, and not the session's own say. Viewing as
 * somebody never opens it: the request is then acting as them, and nobody else is a super admin.
 * Platform support, on either grant, is not a super admin either.
 *
 * The log holds which fields, never what they held; nothing here could show a value if it wanted to.
 * Nothing here changes a row, and the table itself refuses to (a trigger), so the log reads the same
 * to everyone who may read it, for as long as it is kept.
 */

export type UnmaskLogFilters = {
  /** YYYY-MM-DD, both ends included, on the workspace's clock. */
  from?: string;
  to?: string;
  userId?: string;
  /** A lead's number ("LEAD-000123") or id. */
  lead?: string;
  result?: string;
};

const RESULTS: readonly UnmaskResult[] = ["ALLOWED", "REPEAT", "QUOTA_EXHAUSTED", "DENIED"];
const EXPORT_CAP = 10_000;

/** Whether the person asking may read the log: the super admin, as themselves. */
export async function mayReadUnmaskLog(): Promise<boolean> {
  const user = await requireUser();
  if (await viewAsContext()) return false;
  try {
    return (await actorContext(user.id)).isSuperAdmin;
  } catch {
    return false;
  }
}

async function whereFor(filters: UnmaskLogFilters): Promise<Prisma.UnmaskEventWhereInput> {
  const clock = await workspaceClock();
  const range = clock.dayRange(filters.from || null, filters.to || null);
  const and: Prisma.UnmaskEventWhereInput[] = [];
  if (range) and.push({ at: range });
  if (filters.userId) and.push({ userId: String(filters.userId).slice(0, 64) });
  if (filters.result && (RESULTS as readonly string[]).includes(filters.result)) and.push({ result: filters.result as UnmaskResult });
  const lead = filters.lead?.trim();
  if (lead) {
    const ref = parseRecordRef(lead);
    // A number however it was typed — LEAD-123, 123 — is the one the log froze, LEAD-000123.
    and.push(ref.kind === "seq" ? { leadRef: formatLeadId(ref.seq) } : { leadId: lead.slice(0, 64) });
  }
  return and.length ? { AND: and } : {};
}

export type UnmaskLogRow = {
  id: string;
  at: string;
  businessDate: string;
  userId: string;
  userName: string;
  impersonatedBy: string | null;
  leadId: string;
  leadRef: string | null;
  fields: string[];
  result: UnmaskResult;
  consumed: boolean;
  usedToday: number | null;
  dailyLimit: number | null;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  tenantId: string | null;
};

export async function listUnmaskEvents(
  filters: UnmaskLogFilters,
  page: { page: number; pageSize: number },
): Promise<ActionResult<{ rows: UnmaskLogRow[]; total: number; people: { id: string; name: string }[] }>> {
  if (!(await mayReadUnmaskLog())) return { ok: false, error: "Only the super admin can read the unmasking logs." };
  try {
    const where = await whereFor(filters ?? {});
    const [rows, total, people] = await Promise.all([
      db.unmaskEvent.findMany({ where, orderBy: { at: "desc" }, ...pageSlice(Math.max(1, page.page), Math.min(200, Math.max(1, page.pageSize))) }),
      db.unmaskEvent.count({ where }),
      // Everybody who appears in the log, for the person filter — by the name the log froze.
      db.unmaskEvent.findMany({ distinct: ["userId"], select: { userId: true, userName: true }, orderBy: { userName: "asc" }, take: 500 }),
    ]);
    const actors = [...new Set(rows.map((r) => r.impersonatedByUserId).filter((id): id is string => Boolean(id)))];
    const names = new Map((await db.user.findMany({ where: { id: { in: actors } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          at: r.at.toISOString(),
          businessDate: r.businessDate,
          userId: r.userId,
          userName: r.userName,
          impersonatedBy: r.impersonatedByUserId ? (names.get(r.impersonatedByUserId) ?? r.impersonatedByUserId) : null,
          leadId: r.leadId,
          leadRef: r.leadRef,
          fields: r.fields,
          result: r.result,
          consumed: r.consumed,
          usedToday: r.usedToday,
          dailyLimit: r.dailyLimit,
          reason: r.reason,
          requestId: r.requestId,
          ip: r.ip,
          userAgent: r.userAgent,
          tenantId: r.tenantId,
        })),
        total,
        people: people.map((p) => ({ id: p.userId, name: p.userName })),
      },
    };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: true, data: { rows: [], total: 0, people: [] } };
    throw err;
  }
}

/** The filtered log as CSV, newest first, up to ten thousand rows — and the export itself logged. */
export async function exportUnmaskEventsCsv(filters: UnmaskLogFilters): Promise<ActionResult<{ csv: string; rows: number; capped: boolean }>> {
  const user = await requireUser();
  if (!(await mayReadUnmaskLog())) {
    await logActivity({ kind: "PERMISSION_DENIED", summary: `${user.name} tried to export the unmasking logs` });
    return { ok: false, error: "Only the super admin can export the unmasking logs." };
  }
  const where = await whereFor(filters ?? {});
  const [rows, total] = await Promise.all([db.unmaskEvent.findMany({ where, orderBy: { at: "desc" }, take: EXPORT_CAP }), db.unmaskEvent.count({ where })]);
  const clock = await workspaceClock();
  const header = ["When", "Business day", "Person", "Person id", "Viewing as (by)", "Lead", "Lead id", "Fields", "Result", "Used a unit", "Used today", "Daily limit", "Reason", "Request id", "IP", "User agent", "Workspace"];
  const lines = rows.map((r) =>
    csvRow([
      clock.dateTime(r.at),
      r.businessDate,
      r.userName,
      r.userId,
      r.impersonatedByUserId ?? "",
      r.leadRef ?? "",
      r.leadId,
      r.fields.join(" "),
      r.result,
      r.consumed ? "yes" : "no",
      r.usedToday ?? "",
      r.dailyLimit ?? "",
      r.reason ?? "",
      r.requestId ?? "",
      r.ip ?? "",
      r.userAgent ?? "",
      r.tenantId ?? "",
    ]),
  );
  await logActivity({
    kind: "EXPORT",
    severity: "WARNING",
    summary: `${user.name} exported ${rows.length.toLocaleString("en-IN")} unmasking log rows`,
    metadata: { rows: rows.length, filters: JSON.parse(JSON.stringify(filters ?? {})) as Prisma.InputJsonValue },
  });
  return { ok: true, data: { csv: [csvRow(header), ...lines].join("\n"), rows: rows.length, capped: total > rows.length } };
}
