import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { Prisma, type PartnerRole } from "@wroffy/control-client";
import type { PartnerActor } from "@/lib/partners/audit";
import { currentPartnerSession, type PartnerSessionState } from "@/lib/partners/session";
import { PartnerRefused, type PartnerMe, type PartnerResult } from "@/lib/partners/types";

/**
 * The first line of every partner portal page and action.
 *
 *   partnerPage(roles?, opts?)       pages: the signed-in user, or a redirect — to /login without a
 *                                    session, to /enrol while two-factor is required and not set up —
 *                                    and "not found" for a role the page is not for, or a Resellers
 *                                    page for a reseller (the same answer as a page that does not exist).
 *   requirePartner(roles?, mode)     actions: the session, or a PartnerRefused. "sell" (new codes,
 *                                    links, registrations) needs the partner ACTIVE; "write" (every
 *                                    other change) works while it is ONBOARDING, ACTIVE or SUSPENDED.
 *
 * There is no shared action wrapper: each file in src/actions/partners keeps its own small `asPartner`
 * that calls `requirePartner(` itself, so check:rbac sees the guard in the file.
 *
 * A layout is not enough: the App Router keeps a layout across navigations without running it again,
 * so each page checks itself.
 */

export type PartnerMode = "read" | "write" | "sell";

export async function partnerPage(roles?: readonly PartnerRole[], opts?: { distributorOnly?: boolean }): Promise<PartnerSessionState> {
  const session = await currentPartnerSession();
  if (!session) redirect("/login");
  if (!session.mfaDone) redirect(session.needsEnrolment ? "/enrol" : "/login");
  if (roles && roles.length && !roles.includes(session.user.role)) notFound();
  if (opts?.distributorOnly && session.user.partner.kind !== "DISTRIBUTOR") notFound();
  return session;
}

export async function requirePartner(roles?: readonly PartnerRole[], mode: PartnerMode = "read"): Promise<PartnerSessionState> {
  const session = await currentPartnerSession();
  // A TERMINATED partner has no session at all; the check is repeated so no mode can ever reach one.
  if (!session || !session.mfaDone || session.user.partner.status === "TERMINATED") throw new PartnerRefused("Sign in to the partner portal again.");
  if (roles && roles.length && !roles.includes(session.user.role)) throw new PartnerRefused("Your role cannot do that.");
  if (mode === "sell" && session.user.partner.status !== "ACTIVE") {
    throw new PartnerRefused("Your partner account is not active, so it cannot create codes, links or registrations.");
  }
  return session;
}

/**
 * Every portal page shows fresh data after a change. The proxy rewrites partners.<domain>/x to
 * /platform-partners/x, so the path to revalidate is the rewritten one, as a layout.
 */
export function revalidatePortal(): void {
  revalidatePath("/platform-partners", "layout");
}

/** The signed-in user as the audit log's actor. */
export const partnerActor = (me: PartnerMe): PartnerActor => ({ kind: "partner", id: me.id, name: me.name, email: me.email, partnerId: me.partner.id });

/**
 * A refusal's answer, or null for anything that is not one. A row gone between read and write
 * (P2025) is "That no longer exists."; a unique index saying no (P2002) is "That is already taken.".
 */
export function partnerRefusal(err: unknown): Extract<PartnerResult<never>, { ok: false }> | null {
  if (err instanceof PartnerRefused || (err instanceof Error && err.name === "PartnerRefused")) return { ok: false, error: err.message };
  const known = err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && err.name === "PrismaClientKnownRequestError");
  if (known && (err as { code?: unknown }).code === "P2025") return { ok: false, error: "That no longer exists." };
  if (known && (err as { code?: unknown }).code === "P2002") return { ok: false, error: "That is already taken." };
  return null;
}
