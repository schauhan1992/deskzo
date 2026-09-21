import type { Prisma } from "@prisma/client";
import { can } from "@/lib/authz/resolve";
import { getDownlineUserIds } from "@/lib/org-chart";

/**
 * Whose accounts somebody may see.
 *
 * One idea, applied everywhere: **a record belongs to whoever manages the account it hangs off.**
 * An order, a payment, a renewal, a lead, a ticket, a contact and an invoice are all about a
 * company, and `Company.ownerUserId` — the account manager — is what decides who they are for.
 *
 * A sales executive sees the accounts they manage. Their manager sees theirs and their team's,
 * because the reporting line already answers "whose team", and nothing else has to be configured.
 * `companies.viewAll` lifts the restriction entirely, for the functions that serve every account
 * rather than owning some: accounts, purchasing, support.
 *
 * ## Why these are fragments rather than a list of ids
 *
 * The obvious shape is `scopeUserIds()` returning ids and each call site writing its own `where`.
 * That is what this file exists to avoid. There are dozens of queries across nine entities, each
 * reaching a company by a different path — `ownerUserId` directly, `company.ownerUserId` one hop
 * away, `companyProduct.company.ownerUserId` two hops — and every hand-written clause is another
 * chance to pick the wrong path.
 *
 * The failure is asymmetric and that is the whole problem: a wrong filter that is too *narrow*
 * shows somebody an empty screen and they report it within the hour. A wrong filter that is too
 * *wide*, or simply forgotten, shows them everybody's accounts and **nothing reports it at all**.
 * So the correct fragment for each entity is written once, here, and call sites spread it.
 *
 * ## The rule for unowned records
 *
 * A company with no account manager is nobody's, and is therefore hidden from everybody who does
 * not hold `companies.viewAll`. That is a deliberate choice rather than an accident of the query:
 * the alternative — treating unowned as public — makes "hidden" mean "hidden until somebody clears
 * the owner field", which is not a rule anybody could rely on.
 */

/**
 * The account-manager ids a user may see through, or `null` for no restriction.
 *
 * `null` rather than "every id in the company": it keeps the `where` clause absent entirely for an
 * unrestricted viewer instead of turning every list into an `IN (...)` over the whole user table.
 */
export async function accountScopeIds(userId: string): Promise<string[] | null> {
  if (await can(userId, "companies.viewAll")) return null;
  // The downline is what makes a manager's view their team's. It is already cycle-safe and
  // excludes deactivated accounts — see src/lib/org-chart.ts.
  return [userId, ...(await getDownlineUserIds(userId))];
}

/** For a query on `Company` itself. */
export async function companyScope(userId: string): Promise<Prisma.CompanyWhereInput> {
  const ids = await accountScopeIds(userId);
  return ids === null ? {} : { ownerUserId: { in: ids } };
}

/**
 * For a query on anything that has a direct `company` relation — CompanyProduct (orders and
 * renewals), Lead, Ticket, Contact, TradeDocument.
 */
export async function viaCompanyScope(userId: string): Promise<Record<string, unknown>> {
  const ids = await accountScopeIds(userId);
  return ids === null ? {} : { company: { ownerUserId: { in: ids } } };
}

/**
 * For `Payment`, which reaches a company through its allocations to orders rather than directly.
 *
 * A lump-sum payment recorded against a company before it is applied to any order has a
 * `companyId` of its own, so both paths are needed — otherwise an unallocated receipt vanishes from
 * the account manager's view at exactly the moment they are chasing it.
 */
export async function paymentScope(userId: string): Promise<Record<string, unknown>> {
  const ids = await accountScopeIds(userId);
  if (ids === null) return {};
  return { company: { ownerUserId: { in: ids } } };
}

/**
 * Whether one specific company is in scope — for a detail page, which must refuse rather than
 * filter.
 *
 * A list that quietly omits a row is a usability question; a detail page that renders a record the
 * viewer should not see is the leak. Every `/companies/[id]`-shaped route needs this.
 */
export async function canSeeCompany(userId: string, ownerUserId: string | null): Promise<boolean> {
  const ids = await accountScopeIds(userId);
  if (ids === null) return true;
  return ownerUserId !== null && ids.includes(ownerUserId);
}
