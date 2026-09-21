import type { ActivityKind, ActivitySeverity, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { resolveViewAs } from "@/lib/impersonation";
import { activityKind } from "@/lib/security/activity-kinds";

/**
 * Writing the activity log.
 *
 * Server-only and deliberately not exported from a `"use server"` file — the same reasoning as
 * `recordAudit` and `notifyUser`. Every export from one of those becomes an endpoint any signed-in
 * user can call, and a security log anybody can write arbitrary rows into is worse than no
 * security log: it can be flooded until the real row is unfindable.
 *
 * The one place a client *does* need to write is the DLP guard reporting a screenshot or a blocked
 * copy. That goes through `src/actions/dlp.ts`, which accepts only a fixed set of kinds and
 * attributes the row to the session rather than to whatever the caller claims.
 */

export type LogActivityInput = {
  kind: ActivityKind;
  summary: string;
  /** Overrides the registry default — an export of 50 rows and one of 50,000 are not equally serious. */
  severity?: ActivitySeverity;
  entityType?: string;
  entityId?: string;
  path?: string;
  metadata?: Prisma.InputJsonValue;
  /**
   * Set for events with no session: a blocked crawler, a sign-in attempt against an address that
   * is not an account. Passing `null` explicitly means "definitely nobody", which is different
   * from leaving it out and having the session looked up.
   */
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * `next/headers`, fetched at call time rather than imported at the top of the file.
 *
 * A static import puts an edge from this module to `next/headers`, and the bundler follows that
 * edge while tracing the client graph — this file is reached from several `"use server"` modules
 * that client components call into, and `next/headers` refuses to be traced there, failing the
 * build. A dynamic import inside the function keeps the dependency off the static graph. It costs
 * nothing at runtime: the module is resolved once and cached thereafter.
 *
 * Returns null wherever there is no request to read — a background job, a script — so callers get
 * a row without request metadata rather than an exception.
 */
async function requestHeaders(): Promise<Headers | null> {
  try {
    const { headers } = await import("next/headers");
    return await headers();
  } catch {
    return null;
  }
}

/**
 * The request's origin address.
 *
 * Behind a proxy `x-forwarded-for` is a list and the first entry is the client; behind nothing it
 * is absent and we get null rather than a fabricated address. Worth being careful: an audit trail
 * that confidently records the load balancer's address for every user is actively misleading.
 */
function clientIp(head: Headers): string | null {
  const forwarded = head.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || null;
  return head.get("x-real-ip") ?? null;
}

export async function logActivity(input: LogActivityInput) {
  try {
    const definition = activityKind(input.kind);

    // Resolved here rather than asked of the caller, for the reason `recordAudit` gives: "remember
    // to attribute this correctly" is a rule a hundred call sites would break within a week.
    let userId = input.userId;
    let userName = input.userName ?? null;
    let userEmail = input.userEmail ?? null;
    let impersonatedByUserId: string | null = null;

    if (userId === undefined) {
      const session = await auth().catch(() => null);
      const sessionUser = session?.user ?? null;
      if (sessionUser) {
        const viewAs = await resolveViewAs(sessionUser.id).catch(() => null);
        const acting = viewAs?.user ?? sessionUser;
        userId = acting.id;
        userName = acting.name ?? null;
        userEmail = acting.email ?? null;
        impersonatedByUserId = viewAs?.actor.id ?? null;
      } else {
        userId = null;
      }
    }

    // Filled in from the database when the caller gave an id but no name, so the frozen copy that
    // outlives the account is actually populated rather than a null that defeats the point.
    if (userId && (!userName || !userEmail)) {
      const found = await db.user
        .findUnique({ where: { id: userId }, select: { name: true, email: true } })
        .catch(() => null);
      userName = userName ?? found?.name ?? null;
      userEmail = userEmail ?? found?.email ?? null;
    }

    let ipAddress = input.ipAddress ?? null;
    let userAgent = input.userAgent ?? null;
    let path = input.path ?? null;
    if (ipAddress === null || userAgent === null || path === null) {
      const head = await requestHeaders();
      if (head) {
        ipAddress = ipAddress ?? clientIp(head);
        userAgent = userAgent ?? head.get("user-agent");
        path = path ?? head.get("x-pathname");
      }
    }

    await db.activityLog.create({
      data: {
        userId: userId ?? null,
        userName,
        userEmail,
        impersonatedByUserId,
        kind: input.kind,
        severity: input.severity ?? definition.severity,
        summary: input.summary,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        path,
        ipAddress,
        userAgent,
        metadata: input.metadata,
      },
    });
  } catch (err) {
    // Same contract as recordAudit and notifyUser: logging is a side effect of the thing that
    // triggered it and must never be the reason that thing fails. A sign-in that works but is not
    // logged is bad; a sign-in that fails because the log table is full is worse.
    console.error("logActivity failed", err);
  }
}

/**
 * Tells every admin about something the DLP layer saw.
 *
 * Deliberately not sent to the person who triggered it. Telling somebody "your screenshot was
 * recorded" is a matter for the on-screen message; telling them who else was told is not, and a
 * notification landing in their own bell would mostly teach them how to avoid the detection.
 */
export async function alertAdmins(input: { title: string; message: string; link?: string }) {
  try {
    const { notifyUser } = await import("@/lib/notify");
    const admins = await db.user.findMany({
      where: { role: "ADMIN", active: true },
      select: { id: true },
    });
    await Promise.all(
      admins.map((a) =>
        notifyUser({
          userId: a.id,
          type: "SECURITY_ALERT",
          title: input.title,
          message: input.message,
          link: input.link ?? "/activity",
        }),
      ),
    );
  } catch (err) {
    console.error("alertAdmins failed", err);
  }
}
