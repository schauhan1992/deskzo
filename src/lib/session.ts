import { cache } from "react";
import { auth } from "@/lib/auth";
import { evaluateAccess } from "@/lib/access/gate";
import { requestFacts } from "@/lib/access/request";
import { resolveViewAs, VIEW_AS_BLOCKED_MESSAGE, type ViewAsContext } from "@/lib/impersonation";

export class UnauthorizedError extends Error {
  constructor() {
    super("You must be signed in to do this.");
    this.name = "UnauthorizedError";
  }
}

/**
 * The account this request is acting as, plus — when an admin is viewing as someone else — the
 * admin really behind it.
 *
 * Every read and every write in the app goes through here, which is deliberate: it means "view as"
 * is one substitution in one place rather than a flag each of a hundred actions has to remember to
 * honour, and it means nothing can accidentally see the admin's own data while the rest of the page
 * shows the user's.
 */
/**
 * The access gate again, for everything the proxy does not stop — and that is more than it looks.
 *
 * The proxy gates pages and the actions posted to them, but not `/api` (outside its matcher), not
 * the public pages, and not `/access` (which must stay reachable to tell a held person why). A server
 * action can be posted to *any* of those paths, whichever page it was written for. So every
 * session-bearing read and write asks here as well, and `/access` itself never calls
 * `requireUser` — it reads the session directly.
 *
 * Once per request (React `cache`), and cached for twenty seconds beyond that by the gate itself.
 * Outside a request — a script, a background job — there is nobody at a door and nothing to ask.
 */
const heldAtGate = cache(async (userId: string, sid: string | undefined): Promise<boolean> => {
  const facts = await requestFacts();
  if (!facts.inRequest) return false;
  const verdict = await evaluateAccess({ userId, sid: sid ?? null, ip: facts.ip, userAgent: facts.userAgent, mobileHint: facts.mobileHint, deviceToken: facts.deviceToken });
  return !verdict.ok;
});

export async function requireUser() {
  const session = await auth();
  if (!session?.user) {
    throw new UnauthorizedError();
  }
  if (await heldAtGate(session.user.id, session.user.sid)) throw new UnauthorizedError();
  const viewAs = await resolveViewAs(session.user.id);
  return viewAs ? { ...session.user, ...viewAs.user } : session.user;
}

/** Same resolution, but without throwing — for layouts that render before anyone is signed in. */
export async function currentUser() {
  const session = await auth();
  if (!session?.user) return null;
  if (await heldAtGate(session.user.id, session.user.sid)) return null;
  const viewAs = await resolveViewAs(session.user.id);
  return viewAs ? { ...session.user, ...viewAs.user } : session.user;
}

/**
 * The "viewing as" banner's data, and the answer to "is this really who they say they are".
 * Null whenever the signed-in user is simply themselves.
 */
export async function viewAsContext(): Promise<ViewAsContext | null> {
  const session = await auth();
  if (!session?.user) return null;
  return resolveViewAs(session.user.id);
}

/**
 * Refuses an action that must only ever be taken as yourself.
 *
 * Used by the handful of things that change how an account is accessed — password, two-factor —
 * where doing it from inside someone else's session would both be an account takeover and be
 * recorded as the victim doing it to themselves.
 */
export async function refuseWhileViewingAs(): Promise<string | null> {
  const context = await viewAsContext();
  return context ? VIEW_AS_BLOCKED_MESSAGE : null;
}
