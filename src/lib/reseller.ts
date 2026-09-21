/**
 * Rules for reseller-managed end customers.
 *
 * When a reseller buys from Wroffy for one of their own customers, the reseller owns that
 * relationship: we don't call the end customer, and we don't email them. `Company.managedByResellerId`
 * is the flag, and everything that could reach an end customer must go through here rather than
 * re-deriving the rule — in particular any future marketing automation, which must filter its
 * recipients with `isMarketable` before sending.
 */

type ResellerManaged = { managedByResellerId: string | null };

/** True when this company belongs to a reseller — no direct calls, no direct email. */
export function isResellerManaged(company: ResellerManaged) {
  return company.managedByResellerId !== null;
}

/** Whether marketing or campaign email may be sent to this company and its contacts. */
export function isMarketable(company: ResellerManaged) {
  return !isResellerManaged(company);
}

/** Prisma `where` fragment for the companies marketing is allowed to reach. */
export const marketableCompanyFilter = { managedByResellerId: null };

export const NO_DIRECT_CONTACT_NOTICE =
  "This customer belongs to a reseller. Go through the reseller — don't call or email them directly.";

/** What a redacted contact detail renders as once the hard lock applies. */
export const REDACTED_PLACEHOLDER = "Hidden — reseller-managed";

/**
 * Contact details for a reseller's end customer are masked unless the viewer holds
 * `contacts.viewRestricted`, so a salesperson can't lift an email or phone number out of the UI.
 */
export function redactContactDetails<T extends { email: string | null; phone: string | null }>(
  contact: T,
  { restricted, canViewRestricted }: { restricted: boolean; canViewRestricted: boolean },
): T & { detailsRedacted: boolean } {
  if (!restricted || canViewRestricted) {
    return { ...contact, detailsRedacted: false };
  }
  // The email verification fields go too when they're present: `emailCheckedValue` is the address
  // itself, and `emailCheckDetail` names its mail domain — redacting `email` alone would leave the
  // thing it was hiding sitting in the next field along.
  return {
    ...contact,
    email: null,
    phone: null,
    ...("emailCheckedValue" in contact ? { emailCheckedValue: null, emailCheckDetail: null } : {}),
    detailsRedacted: true,
  };
}
