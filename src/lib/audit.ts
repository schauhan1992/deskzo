import type { AuditAction } from "@prisma/client";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { resolveViewAs } from "@/lib/impersonation";

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
}) {
  try {
    await db.auditLog.create({ data: { ...params, impersonatedByUserId: await impersonator() } });
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
