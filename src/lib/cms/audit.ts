import type { Prisma } from "@deskzo/control-client";
import { controlDb } from "@/lib/platform/control-db";
import { endOfIndianDay, startOfIndianDay } from "@/lib/india-time";
import type { CmsAuditAction, CmsAuditFilters, CmsAuditRow, CmsMe, Paged } from "@/lib/cms/types";

/**
 * The CMS's activity log (cms_audit_log) and who did things.
 *
 * Every change in the CMS writes one row: who (the CMS user, a platform staff member from the
 * console, a script, or the public site's contact form), what, and to which thing — ids, slugs,
 * titles and counts only. Never a document's body, a lead's message, a password, a code or a link.
 */

/** Who is acting. The CMS user's own, a staff member from the console, the CLI, or the public site. */
export type CmsActor =
  | { kind: "cms"; id: string; name: string; email: string }
  | { kind: "staff"; id: string; name: string }
  | { kind: "script" }
  | { kind: "site" };

/** Who a CMS user is, as the log records them: themselves — or "script" when a script acts through the CMS (CmsMe.script). */
export function actorOfMe(me: CmsMe): CmsActor {
  return me.script ? { kind: "script" } : { kind: "cms", id: me.id, name: me.name, email: me.email };
}

/** What `createdBy` / `updatedBy` columns hold: "cms:<id>", "staff:<id>", "script", "site". */
export function actorRef(actor: CmsActor): string {
  return actor.kind === "cms" ? `cms:${actor.id}` : actor.kind === "staff" ? `staff:${actor.id}` : actor.kind;
}

function actorLabelOf(actor: CmsActor): string {
  if (actor.kind === "cms") return `${actor.name} (${actor.email})`;
  if (actor.kind === "staff") return `Platform staff: ${actor.name}`;
  return actor.kind === "script" ? "script" : "Website";
}

export async function cmsAudit(actor: CmsActor, action: CmsAuditAction, entity: string, entityId: string | null, detail?: Record<string, unknown>): Promise<void> {
  await controlDb().cmsAuditLog.create({
    data: {
      actorId: actor.kind === "cms" ? actor.id : null,
      actorLabel: actorLabelOf(actor),
      action,
      entity,
      entityId,
      detail: detail ? (detail as Prisma.InputJsonValue) : undefined,
    },
    select: { id: true },
  });
}

/**
 * Names for "cms:<id>", "staff:<id>", "script" and "site" references, looked up once for a whole
 * list. A reference to somebody since removed reads as it is stored.
 */
export async function refLabels(refs: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(refs.filter((r): r is string => !!r))];
  const cmsIds = unique.filter((r) => r.startsWith("cms:")).map((r) => r.slice(4));
  const staffIds = unique.filter((r) => r.startsWith("staff:")).map((r) => r.slice(6));
  const [cms, staff] = await Promise.all([
    cmsIds.length ? controlDb().cmsUser.findMany({ where: { id: { in: cmsIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    staffIds.length ? controlDb().platformUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  const labels = new Map<string, string>();
  for (const ref of unique) {
    if (ref === "script") labels.set(ref, "Script");
    else if (ref === "site") labels.set(ref, "Website");
    else labels.set(ref, ref);
  }
  for (const u of cms) labels.set(`cms:${u.id}`, u.name);
  for (const s of staff) labels.set(`staff:${s.id}`, `Platform staff: ${s.name}`);
  return labels;
}

export const AUDIT_PAGE_SIZE = 50;

/** The activity page: newest first, filtered by person, action (or an action prefix like "page."), thing and India dates. */
export async function listCmsAudit(filters: CmsAuditFilters = {}): Promise<Paged<CmsAuditRow>> {
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const action = typeof filters.action === "string" ? filters.action.trim().slice(0, 60) : "";
  const from = filters.from ? startOfIndianDay(filters.from) : null;
  const to = filters.to ? endOfIndianDay(filters.to) : null;
  const where: Prisma.CmsAuditLogWhereInput = {
    ...(filters.actorId ? { actorId: String(filters.actorId).slice(0, 40) } : {}),
    ...(action ? (action.endsWith(".") ? { action: { startsWith: action } } : { action }) : {}),
    ...(filters.entity ? { entity: String(filters.entity).slice(0, 40) } : {}),
    ...(from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([
    controlDb().cmsAuditLog.findMany({ where, orderBy: [{ at: "desc" }, { id: "desc" }], skip: (page - 1) * AUDIT_PAGE_SIZE, take: AUDIT_PAGE_SIZE }),
    controlDb().cmsAuditLog.count({ where }),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, detail: (r.detail as Record<string, unknown> | null) ?? null })),
    total,
    page,
    pageSize: AUDIT_PAGE_SIZE,
  };
}
