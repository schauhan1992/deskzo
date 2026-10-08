import { db } from "@/lib/db";

/**
 * A person who left one company and joined another (owner, 8 Oct 2026). Each company keeps its own
 * record of them — their leads, tickets, calls and documents stay where they happened — and the two
 * records point at each other: the new one's `previousContactId` is the old one. So their history at
 * every company they've been at is one click away, whichever record is open.
 *
 * `previousContactId` is in NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts): read by name.
 */

export type ContactMoveLink = { contactId: string; companyName: string; companySeq: number };
export type ContactMoves = Record<string, { previous?: ContactMoveLink; next?: ContactMoveLink }>;

/** Where each of these contacts was before, and where they went — for those who moved. */
export async function contactMovesOf(contactIds: string[]): Promise<ContactMoves> {
  if (contactIds.length === 0) return {};
  const company = { select: { name: true, companySeq: true } } as const;
  try {
    const rows = await db.contact.findMany({
      where: { id: { in: contactIds }, OR: [{ previousContactId: { not: null } }, { nextContact: { isNot: null } }] },
      select: {
        id: true,
        previousContact: { select: { id: true, company } },
        nextContact: { select: { id: true, company } },
      },
    });
    const link = (c: { id: string; company: { name: string; companySeq: number } }): ContactMoveLink => ({
      contactId: c.id,
      companyName: c.company.name,
      companySeq: c.company.companySeq,
    });
    return Object.fromEntries(
      rows.map((r) => [r.id, { ...(r.previousContact ? { previous: link(r.previousContact) } : {}), ...(r.nextContact ? { next: link(r.nextContact) } : {}) }]),
    );
  } catch {
    return {};
  }
}
