import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * A contact who has left their company (owner, 8 Oct 2026). They keep everything that happened with
 * them — leads, tickets, calls, documents — but from the day they are marked left they are:
 *
 *   · no longer the primary contact, nor sent invoices and quotes;
 *   · not mailed by a campaign or a list, nor invited to a form, nor asked for feedback;
 *   · not offered when a meeting, a call or a document email is set up;
 *   · not let into the customer portal (their logins are revoked);
 *   · not trusted as a sender when an email to support opens a ticket.
 *
 * Marking them back undoes the first four by itself; a primary, documents and the portal are given
 * again by hand.
 */

/** The contacts still at their company — add to any `where` that picks people to write to or offer. */
export const STILL_THERE = { leftAt: null } satisfies Prisma.ContactWhereInput;

/**
 * When each of a company's contacts left, for those who have. Read by name — the column is in
 * NOT_YET_EVERYWHERE — and empty in a workspace that has not got it yet.
 */
export async function leftContactsOf(companyId: string): Promise<Map<string, Date>> {
  try {
    const rows = await db.contact.findMany({ where: { companyId, leftAt: { not: null } }, select: { id: true, leftAt: true } });
    return new Map(rows.map((r) => [r.id, r.leftAt!]));
  } catch {
    return new Map();
  }
}

/** When each of these contacts left, for those who have — empty where the column is not there yet. */
export async function leftAmong(contactIds: string[]): Promise<Map<string, Date>> {
  if (contactIds.length === 0) return new Map();
  try {
    const rows = await db.contact.findMany({ where: { id: { in: contactIds }, leftAt: { not: null } }, select: { id: true, leftAt: true } });
    return new Map(rows.map((r) => [r.id, r.leftAt!]));
  } catch {
    return new Map();
  }
}

/** Whether one contact has left — false where the column is not there yet. */
export async function hasLeft(contactId: string): Promise<boolean> {
  try {
    const row = await db.contact.findUnique({ where: { id: contactId }, select: { leftAt: true } });
    return !!row?.leftAt;
  } catch {
    return false;
  }
}
