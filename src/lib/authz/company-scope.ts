import type { Prisma } from "@prisma/client";
import { companyAccess, customerReachIds, mayAccessAccount, throughAccount, type AccountFacts } from "@/lib/authz/access";

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
 * ## Answered by the access engine now
 *
 * Since the permission redesign (docs/permission-redesign.md, phase 1) these helpers ask
 * `src/lib/authz/access.ts` how far somebody reaches over customers and vendors, rather than reading
 * `companies.viewAll` themselves. Until an admin sets a level the engine's answer is this file's old
 * one, derived from the same permission — `scripts/access-snapshot.ts` compares the two — and once a
 * level is set, every screen that asks here follows it. The names and shapes are kept because about
 * eighty call sites spread them.
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
 * not reach every account. That is a deliberate choice rather than an accident of the query: the
 * alternative — treating unowned as public — makes "hidden" mean "hidden until somebody clears the
 * owner field", which is not a rule anybody could rely on.
 */

/**
 * The account-manager ids a user may see customers through, or `null` for no restriction.
 *
 * `null` rather than "every id in the company": it keeps the `where` clause absent entirely for an
 * unrestricted viewer instead of turning every list into an `IN (...)` over the whole user table.
 * The customer side's reach — the reports, forecasts and exports that use it are about selling.
 */
export async function accountScopeIds(userId: string): Promise<string[] | null> {
  return customerReachIds(userId);
}

/** For a query on `Company` itself — customers and vendors, each at its own reach. */
export async function companyScope(userId: string): Promise<Prisma.CompanyWhereInput> {
  return companyAccess(userId, "view");
}

/**
 * For a query on anything that has a direct `company` relation — CompanyProduct (orders and
 * renewals), Lead, Ticket, Contact, TradeDocument. The account alone: a record type with a level
 * of its own (leads, orders, documents, payments, contacts) asks `access.ts` for that instead.
 */
export async function viaCompanyScope(userId: string): Promise<Record<string, unknown>> {
  return throughAccount(userId, "view");
}

/**
 * For `Payment`, through its company — the same account rule as `viaCompanyScope`.
 *
 * (A lump-sum payment recorded against a company before it is applied to any order has a
 * `companyId` of its own, so the company path covers an unallocated receipt as well.)
 */
export async function paymentScope(userId: string): Promise<Record<string, unknown>> {
  return throughAccount(userId, "view");
}

/**
 * Whether one specific company is in scope — for a detail page, which must refuse rather than
 * filter.
 *
 * A list that quietly omits a row is a usability question; a detail page that renders a record the
 * viewer should not see is the leak. Every `/companies/[id]`-shaped route needs this.
 *
 * Given the company's account manager **and its relationship type**: customers and vendors are
 * separate rows in the redesign, and a level set for one must not open the other. A company that
 * wasn't found is `null`, and answers no.
 */
export async function canSeeCompany(userId: string, account: AccountFacts | null): Promise<boolean> {
  if (!account) return false;
  return mayAccessAccount(userId, "view", account);
}
