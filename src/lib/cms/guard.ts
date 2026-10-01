import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { Prisma, type CmsRole } from "@deskzo/control-client";
import type { CmsActor } from "@/lib/cms/audit";
import { currentCmsSession, type CmsSessionState } from "@/lib/cms/session";
import { CmsRefused, type CmsMe, type CmsResult } from "@/lib/cms/types";

/**
 * The first line of every CMS page and action.
 *
 *   cmsPage(roles?)     pages: the signed-in user, or a redirect — to /login without a session, to
 *                       /enrol while two-factor is required and not set up — and "not found" for a
 *                       role the page is not for (the same answer as a page that does not exist).
 *   requireCms(roles?)  actions: the session, or a CmsRefused.
 *   cmsAction(roles, fn) actions: requireCms, then fn, with every refusal turned into
 *                       `{ ok: false, error }` and anything else rethrown (a bug is not an answer).
 *
 * A layout is not enough: the App Router keeps a layout across navigations without running it again,
 * so each page checks itself.
 */

export async function cmsPage(roles?: readonly CmsRole[]): Promise<CmsSessionState> {
  const session = await currentCmsSession();
  if (!session) redirect("/login");
  if (!session.mfaDone) redirect(session.needsEnrolment ? "/enrol" : "/login");
  if (roles && roles.length && !roles.includes(session.user.role)) notFound();
  return session;
}

export async function requireCms(roles?: readonly CmsRole[]): Promise<CmsSessionState> {
  const session = await currentCmsSession();
  if (!session || !session.mfaDone) throw new CmsRefused("Sign in to the CMS again.");
  if (roles && roles.length && !roles.includes(session.user.role)) throw new CmsRefused("Your role cannot do that.");
  return session;
}

/**
 * Every CMS page shows fresh data after a change. The proxy rewrites cms.<domain>/x to
 * /platform-cms/x, so the path to revalidate is the rewritten one, as a layout.
 */
export function revalidateCms(): void {
  revalidatePath("/platform-cms", "layout");
}

/** The signed-in user as the audit log's actor. */
export const cmsActor = (me: CmsMe): CmsActor => ({ kind: "cms", id: me.id, name: me.name, email: me.email });

/** A refusal's answer, or null for anything that is not one. A row gone between read and write (P2025) is "That no longer exists." */
export function cmsRefusal(err: unknown): Extract<CmsResult<never>, { ok: false }> | null {
  if (err instanceof CmsRefused) return { ok: false, error: err.message, ...(err.issues ? { issues: err.issues } : {}), ...(err.conflict ? { conflict: err.conflict } : {}) };
  const known = err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && err.name === "PrismaClientKnownRequestError");
  if (known && (err as { code?: unknown }).code === "P2025") return { ok: false, error: "That no longer exists." };
  if (known && (err as { code?: unknown }).code === "P2002") return { ok: false, error: "That is already taken." };
  return null;
}

export async function cmsAction<T>(roles: readonly CmsRole[] | undefined, work: (session: CmsSessionState) => Promise<T>): Promise<CmsResult<T>> {
  let session: CmsSessionState;
  try {
    session = await requireCms(roles);
  } catch (err) {
    const refused = cmsRefusal(err);
    if (refused) return refused;
    throw err;
  }
  try {
    return { ok: true, data: await work(session) };
  } catch (err) {
    const refused = cmsRefusal(err);
    if (refused) return refused;
    throw err;
  }
}
