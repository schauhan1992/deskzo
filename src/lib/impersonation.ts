import { cookies } from "next/headers";
import type { Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { isAutomationKind } from "@/lib/people";

/**
 * "View as" — an admin working inside another user's account.
 *
 * The whole point of the feature is that the admin sees precisely what that person sees: their
 * dashboard, their permissions, their scoped lists. That is also what makes it dangerous, so the
 * rules below are the feature, not decoration around it.
 *
 * The session itself is never rewritten. The signed-in JWT always stays the admin's, and a separate
 * cookie says "while this admin is signed in, resolve them as that user". That matters for two
 * reasons: ending the session is a cookie deletion rather than a token re-issue, and the real actor
 * is always recoverable — nothing in the request has lost the fact that it was the admin who did it.
 *
 * The ticket is AES-256-GCM encrypted with the workspace's data key, like every other stored
 * secret. GCM is authenticated, so a hand-crafted or edited cookie fails to decrypt rather than
 * being believed — a cookie is just a request header, and an httpOnly flag stops a script reading
 * it, not a determined person writing one with curl.
 */

const COOKIE = "wroffy-view-as";

/**
 * Long enough for an admin to actually diagnose something, short enough that a forgotten tab does
 * not leave an open door for the rest of the week.
 */
const MAX_AGE_SECONDS = 60 * 60;

type Ticket = {
  /** The admin who started it. Bound so a copied cookie is worthless in anyone else's session. */
  actorId: string;
  targetId: string;
  startedAt: number;
};

export type ViewAsContext = {
  /** The user the request should be resolved as. */
  user: { id: string; name: string; email: string; role: Role };
  /** The admin really behind it. */
  actor: { id: string; name: string; role: Role };
};

export async function setViewAsCookie(actorId: string, targetId: string) {
  const ticket: Ticket = { actorId, targetId, startedAt: Date.now() };
  const store = await cookies();
  store.set(COOKIE, await encryptSecret(JSON.stringify(ticket)), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearViewAsCookie() {
  const store = await cookies();
  store.delete(COOKIE);
}

async function readTicket(raw: string | undefined): Promise<Ticket | null> {
  if (!raw) return null;
  try {
    const ticket = JSON.parse(await decryptSecret(raw)) as Ticket;
    if (!ticket?.actorId || !ticket?.targetId || typeof ticket.startedAt !== "number") return null;
    return ticket;
  } catch {
    // Tampered, or encrypted under a key this deployment no longer has. Either way it is not a
    // ticket we issued, so it is simply not one.
    return null;
  }
}

/**
 * Resolves who the current request is acting as.
 *
 * Returns null whenever the answer is "just the signed-in user", which is the overwhelmingly common
 * case and costs one cookie read. Every check below is re-run per request and re-read from the
 * database rather than trusted from the JWT, so demoting an admin, deactivating either account, or
 * simply waiting an hour ends the session on the very next request without anything needing to
 * notice and revoke it.
 */
export async function resolveViewAs(sessionUserId: string): Promise<ViewAsContext | null> {
  const store = await cookies();
  const ticket = await readTicket(store.get(COOKIE)?.value);
  if (!ticket) return null;

  // Bound to the admin who started it: signing out and back in as someone else, or lifting the
  // cookie into another browser, does not carry the impersonation with it.
  if (ticket.actorId !== sessionUserId) return null;
  if (Date.now() - ticket.startedAt > MAX_AGE_SECONDS * 1000) return null;
  if (ticket.actorId === ticket.targetId) return null;

  const [actor, target] = await Promise.all([
    db.user.findUnique({
      where: { id: ticket.actorId },
      select: { id: true, name: true, role: true, active: true, isSuperAdmin: true },
    }),
    db.user.findUnique({
      where: { id: ticket.targetId },
      select: { id: true, name: true, email: true, role: true, active: true, isSuperAdmin: true, kind: true },
    }),
  ]);

  if (!actor?.active || actor.role !== "ADMIN") return null;
  // Never the Automation account (src/lib/automation-user.ts): nobody is ever it, not even by borrowing it.
  if (!target?.active || isAutomationKind(target.kind)) return null;

  /**
   * Re-checked here, not only where the ticket was issued.
   *
   * Two things were trusted for the life of the cookie that should not have been. The permission
   * itself: revoking `impersonation.use` left an in-flight ticket working until it aged out, which
   * made revocation take up to an hour to mean anything. And the target's tier: a ticket issued
   * against an ordinary user stayed valid if that user was promoted to super admin a minute later,
   * which is the escalation this file's own permission entry promises cannot happen.
   */
  if (target.isSuperAdmin && !actor.isSuperAdmin) return null;
  if (!(await can(actor.id, "impersonation.use"))) return null;

  return {
    user: { id: target.id, name: target.name, email: target.email, role: target.role },
    actor: { id: actor.id, name: actor.name, role: actor.role },
  };
}

/**
 * The real person behind the request, for anything that must not be attributed to the account being
 * viewed — the audit log above all.
 */
export async function actingAdminId(sessionUserId: string): Promise<string | null> {
  const context = await resolveViewAs(sessionUserId);
  return context ? context.actor.id : null;
}

/**
 * Things an admin must not do from inside somebody else's account.
 *
 * Changing the credentials of the account you are borrowing turns "look at their screen" into
 * "take their account", and it would be recorded as the user doing it to themselves. An admin who
 * genuinely needs to reset someone's access has the Users & Access screen for it, under their own
 * name, where it is visible as an administrative act.
 */
export const VIEW_AS_BLOCKED_MESSAGE =
  "You're viewing as someone else. Switch back to yourself to change account security.";
