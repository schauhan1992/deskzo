import type { PartnerActorKind, Prisma } from "@deskzo/control-client";
import { endOfIndianDay, startOfIndianDay } from "@/lib/india-time";
import { controlDb } from "@/lib/platform/control-db";
import type { Paged, PartnerAuditAction, PartnerAuditFilters, PartnerAuditRow } from "@/lib/partners/types";

/**
 * The partner programme's activity log (partner_audit_log) and who did things.
 *
 * Every change in or to a partner writes one row: who (one of the partner's users in the portal,
 * a platform staff member from the console, a script, the platform itself, or somebody on the
 * public site), what, and to which thing — ids, slugs, names and counts only. Never a password, a
 * code, a token, a secret or a bank detail.
 *
 * A row is shown on the partner's own Activity page unless it says otherwise (`visibleToPartner`):
 * staff-only facts — statement generation, a reason — are written invisible.
 */

/** Who is acting: a partner's user, a staff member from the console, the CLI, the platform (signup, the tick), or the public site. */
export type PartnerActor =
  | { kind: "partner"; id: string; name: string; email: string; partnerId: string }
  | { kind: "staff"; id: string; name: string }
  | { kind: "script" }
  | { kind: "system"; name: string }
  | { kind: "public" };

/** What `createdBy` columns hold: "partner:<userId>", "staff:<id>", "script", "system:<name>", "public". */
export function actorRef(actor: PartnerActor): string {
  if (actor.kind === "partner") return `partner:${actor.id}`;
  if (actor.kind === "staff") return `staff:${actor.id}`;
  if (actor.kind === "system") return `system:${actor.name}`;
  return actor.kind;
}

const ACTOR_KINDS: Record<PartnerActor["kind"], PartnerActorKind> = { partner: "PARTNER", staff: "STAFF", script: "SCRIPT", system: "SYSTEM", public: "PUBLIC" };

function actorLabelOf(actor: PartnerActor): string {
  if (actor.kind === "partner") return `${actor.name} (${actor.email})`;
  if (actor.kind === "staff") return `Platform staff: ${actor.name}`;
  if (actor.kind === "system") return `system: ${actor.name}`;
  return actor.kind === "script" ? "script" : "Website";
}

/**
 * One row of the partner audit log. `partnerId` is null only for what belongs to no partner yet (a
 * public application). Pass `tx` to write it inside the caller's transaction, so the row and the
 * change it describes stand or fall together.
 */
export async function partnerAudit(
  actor: PartnerActor,
  partnerId: string | null,
  action: PartnerAuditAction,
  entity: string,
  entityId: string | null,
  detail?: Record<string, unknown>,
  opts?: { visibleToPartner?: boolean; tx?: Prisma.TransactionClient },
): Promise<void> {
  const client = opts?.tx ?? controlDb();
  await client.partnerAuditLog.create({
    data: {
      partnerId,
      actorKind: ACTOR_KINDS[actor.kind],
      actorId: actor.kind === "partner" || actor.kind === "staff" ? actor.id : null,
      // The column holds 200 characters; a long name and a long address together can hold more.
      actorLabel: actorLabelOf(actor).slice(0, 200),
      action,
      entity: entity.slice(0, 40),
      entityId,
      detail: detail ? (detail as Prisma.InputJsonValue) : undefined,
      visibleToPartner: opts?.visibleToPartner ?? true,
    },
    select: { id: true },
  });
}

/**
 * Names for "partner:<userId>", "staff:<id>", "script", "public" and "system:<name>" references,
 * looked up once for a whole list. A reference to somebody since removed reads as it is stored.
 */
export async function refLabels(refs: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(refs.filter((r): r is string => !!r))];
  const partnerUserIds = unique.filter((r) => r.startsWith("partner:")).map((r) => r.slice(8));
  const staffIds = unique.filter((r) => r.startsWith("staff:")).map((r) => r.slice(6));
  const [users, staff] = await Promise.all([
    partnerUserIds.length ? controlDb().partnerUser.findMany({ where: { id: { in: partnerUserIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    staffIds.length ? controlDb().platformUser.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
  ]);
  const labels = new Map<string, string>();
  for (const ref of unique) {
    if (ref === "script") labels.set(ref, "Script");
    else if (ref === "public") labels.set(ref, "Website");
    else if (ref.startsWith("system:")) labels.set(ref, `System: ${ref.slice(7)}`);
    else labels.set(ref, ref);
  }
  for (const u of users) labels.set(`partner:${u.id}`, u.name);
  for (const s of staff) labels.set(`staff:${s.id}`, `Platform staff: ${s.name}`);
  return labels;
}

export const AUDIT_PAGE_SIZE = 50;

/**
 * One partner's activity: newest first, 50 a page, filtered by person, action (or an action prefix
 * like "user."), thing and India dates (half-open: `from` from its start, `to` to its end).
 *
 *   "partner"  the partner's own Activity page: only rows written visible, and no staff member's id.
 *   "staff"    the console: every row.
 */
export async function listPartnerAudit(partnerId: string, filters: PartnerAuditFilters = {}, view: "partner" | "staff" = "partner"): Promise<Paged<PartnerAuditRow>> {
  const page = Math.max(1, Math.min(10_000, Math.floor(Number(filters.page) || 1)));
  const action = typeof filters.action === "string" ? filters.action.trim().slice(0, 60) : "";
  const from = typeof filters.from === "string" && filters.from ? startOfIndianDay(filters.from) : null;
  const to = typeof filters.to === "string" && filters.to ? endOfIndianDay(filters.to) : null;
  const where: Prisma.PartnerAuditLogWhereInput = {
    partnerId: String(partnerId ?? ""),
    ...(view === "partner" ? { visibleToPartner: true } : {}),
    ...(filters.actorId ? { actorId: String(filters.actorId).slice(0, 40) } : {}),
    ...(action ? (action.endsWith(".") ? { action: { startsWith: action } } : { action }) : {}),
    ...(filters.entity ? { entity: String(filters.entity).slice(0, 40) } : {}),
    ...(from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([
    controlDb().partnerAuditLog.findMany({
      where,
      orderBy: [{ at: "desc" }, { id: "desc" }],
      skip: (page - 1) * AUDIT_PAGE_SIZE,
      take: AUDIT_PAGE_SIZE,
      select: { id: true, at: true, actorKind: true, actorId: true, actorLabel: true, action: true, entity: true, entityId: true, detail: true, visibleToPartner: true },
    }),
    controlDb().partnerAuditLog.count({ where }),
  ]);
  return {
    rows: rows.map((r) => ({
      ...r,
      actorId: view === "partner" && r.actorKind !== "PARTNER" ? null : r.actorId,
      detail: (r.detail as Record<string, unknown> | null) ?? null,
    })),
    total,
    page,
    pageSize: AUDIT_PAGE_SIZE,
  };
}
