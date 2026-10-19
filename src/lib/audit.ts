import type { AuditAction, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { resolveViewAs } from "@/lib/impersonation";
import { apiActor } from "@/lib/api/actor";
import { notMigratedYet } from "@/lib/not-migrated";
import { auditSubject } from "@/lib/activity/subjects";

import type { FieldChange } from "@/lib/activity/types";

export type { FieldChange } from "@/lib/activity/types";

/**
 * Server-only, same reasoning as `notifyUser` in `src/lib/notify.ts` — not exported from a
 * "use server" file, since every export there becomes a client-callable endpoint and this would
 * let any signed-in user write an audit row crediting (or blaming) any other user.
 */
export async function recordAudit(params: {
  userId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  entityLabel: string;
  /**
   * Whose it is, for the Activity tab (owner, 19 Oct 2026): looked up from the record when not given
   * (src/lib/activity/subjects.ts) — give it for a record already deleted, which has nothing to look up.
   */
  subject?: { companyId?: string | null; leadId?: string | null };
  /** What an edit changed, field by field; only the fields that did. */
  changes?: FieldChange[];
}) {
  const { subject, changes, ...entry } = params;
  // Done through the public API: which key did it, on the entry itself (src/lib/api/actor.ts). Or the
  // Deskzo app: which phone.
  const api = apiActor();
  const via = api ? (api.channel === "app" ? `the Deskzo app on “${api.keyName}”` : `API key “${api.keyName}”`) : null;
  const entityLabel = via ? `${entry.entityLabel} — via ${via}` : entry.entityLabel;
  try {
    const impersonatedByUserId = api ? null : await impersonator();
    const found = subject?.companyId !== undefined || subject?.leadId !== undefined ? null : await auditSubject(entry.entityType, entry.entityId);
    const placed = {
      companyId: subject?.companyId ?? found?.companyId ?? null,
      leadId: subject?.leadId ?? found?.leadId ?? null,
      ...(changes?.length ? { changes: changes as unknown as Prisma.InputJsonValue } : {}),
    };
    try {
      await db.auditLog.create({ data: { ...entry, entityLabel, impersonatedByUserId, ...placed }, select: { id: true } });
    } catch (err) {
      // A workspace not migrated to 20261119110000_activity_subjects yet: the entry, without whose it is.
      if (!notMigratedYet(err)) throw err;
      await db.auditLog.create({ data: { ...entry, entityLabel, impersonatedByUserId }, select: { id: true } });
    }
  } catch (err) {
    // An audit entry is a side effect of the action that triggered it — it should never fail that action.
    console.error("recordAudit failed", err);
  }
}

/**
 * The admin behind the request, when one is viewing as somebody else.
 *
 * Worked out here rather than passed in, because "remember to attribute this correctly" is a rule
 * a hundred call sites would break within a week. Callers keep passing the account the change was
 * made in — which is what the data now says happened — and this quietly adds who was really at the
 * keyboard. It is the one thing that stops "view as" from being a way to launder a change onto
 * somebody else's name.
 */
async function impersonator(): Promise<string | null> {
  try {
    const session = await auth();
    if (!session?.user) return null;
    const context = await resolveViewAs(session.user.id);
    return context?.actor.id ?? null;
  } catch {
    // Called from a background path with no request context. Not impersonated by definition.
    return null;
  }
}
