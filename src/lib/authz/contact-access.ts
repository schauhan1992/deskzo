import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hasEffectivePermission } from "@/actions/permission";
import { canSeeCompany, viaCompanyScope } from "@/lib/authz/company-scope";

/**
 * Who may see and change the people at an account.
 *
 * Two questions, always asked together:
 *
 *   · `contacts.view` — whether this person works with contacts at all. A role without it still sees
 *     a contact's *name* where a record names one (the lead's contact, a visit's attendee), because
 *     that is part of the record; what it loses is the address book — phone numbers, emails, the
 *     Contacts tab and library, the checks, and adding or editing anybody.
 *   · the account scope — whether the contact's company is one they may see, which is the same line
 *     `company-scope.ts` draws for everything else hanging off a company.
 *
 * Every contact action goes through here. Several of them used to go through neither: editing,
 * deleting, bulk-deleting and email-checking a contact took any id and acted on it, whichever
 * account it belonged to.
 */
export const NO_CONTACTS = "You don't have access to contacts.";

export async function canViewContacts(userId: string): Promise<boolean> {
  return hasEffectivePermission(userId, "contacts.view");
}

/**
 * For a query on `Contact` (or on anything reaching a company the same way): the viewer's account
 * scope, or — without `contacts.view` — a clause nothing matches, so a list comes back empty rather
 * than each caller having to remember to check first.
 */
export async function contactScope(userId: string): Promise<Prisma.ContactWhereInput> {
  if (!(await canViewContacts(userId))) return { id: { in: [] } };
  return (await viaCompanyScope(userId)) as Prisma.ContactWhereInput;
}

/** Whether one company's contacts are this person's to see and change — for a single-record action. */
export async function mayWorkWithContactsOf(userId: string, companyId: string): Promise<boolean> {
  if (!(await canViewContacts(userId))) return false;
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true } });
  return !!company && (await canSeeCompany(userId, company.ownerUserId));
}

/** Which of these contact ids this person may act on — the rest are out of scope or don't exist. */
export async function contactIdsInScope(userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.contact.findMany({
    where: { AND: [{ id: { in: ids } }, await contactScope(userId)] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
