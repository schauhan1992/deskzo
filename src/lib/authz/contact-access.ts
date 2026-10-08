import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hasEffectivePermission } from "@/actions/permission";
import { contactAccess, mayAccessContactsOf, type AccessAction } from "@/lib/authz/access";
import { can } from "@/lib/authz/resolve";
import { definitionsFor } from "@/lib/custom-fields/server";
import { isResellerManaged } from "@/lib/reseller";
import { isContactDetailField } from "@/lib/validation/company";

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
 * than each caller having to remember to check first. The access engine answers it (`contactAccess`).
 */
export async function contactScope(userId: string): Promise<Prisma.ContactWhereInput> {
  return contactAccess(userId, "view");
}

/** Whether one company's contacts are this person's to act on this way (edit unless told) — for a single-record action. */
export async function mayWorkWithContactsOf(userId: string, companyId: string, action: AccessAction = "edit"): Promise<boolean> {
  if (!(await canViewContacts(userId))) return false;
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  return !!company && (await mayAccessContactsOf(userId, action, company));
}

/**
 * A reseller's end customer's contact details — each contact's email and phone, and the workspace's
 * own contact fields of those kinds (`isContactDetailField`) — are for people with
 * `contacts.viewRestricted` only, so nobody reaches the customer behind the reseller's back
 * (src/lib/reseller.ts `redactContactDetails`).
 *
 * One rule, asked wherever those details go: the company page, the contacts lists and the merge
 * preview hide them; a save leaves them exactly as stored, since the form showed nothing and the blank
 * it sends back is not an answer; and Settings → Data neither exports nor imports them.
 *
 * Asked of the resolver itself (`can`) rather than `hasEffectivePermission`, which answers only for the
 * signed-in person: an export or an import names the person it runs for, and is right whoever runs it.
 */
export async function seesResellerContactDetails(userId: string): Promise<boolean> {
  return can(userId, "contacts.viewRestricted");
}

/** Whether one account's contact details are hidden from this person — only ever a reseller's end customer's. */
export async function contactDetailsHiddenAt(userId: string, companyId: string): Promise<boolean> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { managedByResellerId: true } });
  if (!company || !isResellerManaged(company)) return false;
  return !(await seesResellerContactDetails(userId));
}

/** The workspace's own contact fields that are contact details — hidden wherever the email and phone are. */
export async function contactDetailFieldKeys(): Promise<string[]> {
  return (await definitionsFor("CONTACT")).filter((d) => isContactDetailField(d.type)).map((d) => d.key);
}

/** Which of these contact ids this person may act on this way — the rest are out of scope or don't exist. */
export async function contactIdsInScope(userId: string, ids: string[], action: AccessAction = "edit"): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.contact.findMany({
    where: { AND: [{ id: { in: ids } }, await contactAccess(userId, action)] },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
