/**
 * Who may open the portal, and what they see when they do.
 *
 * ## Why this is its own file
 *
 * Everything here is a decision that can be wrong in a way nobody notices. A portal that shows one
 * customer another customer's invoices does not throw, does not appear in a log, and is discovered
 * by the customer. So the rules live apart from the queries that act on them, stay pure, and are
 * covered by `scripts/check-portal.ts` — which asks the real code the questions an attacker would.
 *
 * ## The two questions, kept apart
 *
 * **May this link work at all** is `linkState` plus `companyMayUsePortal`. **What does it show** is
 * `visibleSections`. They are separate because they fail differently: the first is a door, and the
 * second is what is in the room. Merging them is how a feature flag ends up granting access.
 */

export type PortalAccessMode = "ALL" | "SELECTED";

export type PortalSettingsLike = {
  enabled: boolean;
  access: PortalAccessMode;
  showSubscriptions: boolean;
  showInvoices: boolean;
  showPayments: boolean;
  showTickets: boolean;
  showAssets: boolean;
  showContacts: boolean;
  allowRenewalRequest: boolean;
  allowSeatRequest: boolean;
  allowQuestion: boolean;
  linkValidityDays: number | null;
};

export type CompanyLike = {
  /** Null means "follow the global default" — see the schema note on `Company.portalEnabled`. */
  portalEnabled: boolean | null;
  relationshipType: string;
  /** Set when a reseller owns this customer. */
  managedByResellerId: string | null;
};

export type LoginLike = {
  expiresAt: Date | null;
  revokedAt: Date | null;
};

export type Refusal =
  /** Every refusal reaches the customer as the same sentence; the reason is for our logs. */
  | "off"
  | "not-granted"
  | "reseller-managed"
  | "not-a-customer"
  | "revoked"
  | "expired"
  | "unknown";

export type Verdict = { ok: true } | { ok: false; because: Refusal };

/**
 * Whether this company is allowed a portal at all.
 *
 * Order matters, and the first three are refusals no per-company setting can override:
 *
 *   1. **The master switch.** Off means off, whoever was granted what. A single switch that
 *      genuinely stops everything is what makes it safe to turn the feature on at all.
 *   2. **A reseller's customer.** The reseller owns that relationship — `src/lib/reseller.ts` keeps
 *      us out of their customers' inboxes, and a portal showing our prices to a company that buys
 *      from our partner would undo it in the most direct way available.
 *   3. **Not a customer.** A vendor, a distributor or a commission party has no subscriptions of
 *      their own to look at, and the portal is built to show a *customer's* account.
 *
 * Only then does the per-company override apply, and only then the global default. That ordering is
 * the whole design: `portalEnabled = true` on a reseller-managed company is still a refusal.
 */
export function companyMayUsePortal(settings: PortalSettingsLike, company: CompanyLike): Verdict {
  if (!settings.enabled) return { ok: false, because: "off" };
  if (company.managedByResellerId) return { ok: false, because: "reseller-managed" };
  if (company.relationshipType !== "CLIENT" && company.relationshipType !== "RESELLER") {
    return { ok: false, because: "not-a-customer" };
  }

  if (company.portalEnabled === true) return { ok: true };
  if (company.portalEnabled === false) return { ok: false, because: "not-granted" };

  return settings.access === "ALL" ? { ok: true } : { ok: false, because: "not-granted" };
}

/** Whether this particular link is still good. */
export function linkState(login: LoginLike | null, now: Date): Verdict {
  if (!login) return { ok: false, because: "unknown" };
  if (login.revokedAt) return { ok: false, because: "revoked" };
  if (login.expiresAt && login.expiresAt.getTime() <= now.getTime()) return { ok: false, because: "expired" };
  return { ok: true };
}

/** When a link created now should stop working. Null when links are set never to expire. */
export function expiryFor(settings: PortalSettingsLike, now: Date): Date | null {
  if (!settings.linkValidityDays || settings.linkValidityDays <= 0) return null;
  return new Date(now.getTime() + settings.linkValidityDays * 86400000);
}

export type Section = "subscriptions" | "invoices" | "payments" | "tickets" | "assets" | "contacts";
export type Action = "renewal" | "seats" | "question";

/**
 * Which parts of the portal exist for this viewer.
 *
 * Returned as a set the page reads, rather than each query checking its own flag. The difference
 * matters: with the flag checked at the query, a section that is switched off still has its data
 * fetched, and the next person to write a component has to remember the rule. With the set, a
 * section that is not in it is never asked for.
 */
export function visibleSections(settings: PortalSettingsLike): Set<Section> {
  const sections = new Set<Section>();
  if (settings.showSubscriptions) sections.add("subscriptions");
  if (settings.showInvoices) sections.add("invoices");
  if (settings.showPayments) sections.add("payments");
  if (settings.showTickets) sections.add("tickets");
  if (settings.showAssets) sections.add("assets");
  if (settings.showContacts) sections.add("contacts");
  return sections;
}

/**
 * Which requests this viewer may raise.
 *
 * A renewal or a seat change is *about* a subscription, so neither is offered when subscriptions
 * are hidden — a button to renew something the page will not show is a button nobody can use
 * correctly. Asking a question stands on its own.
 */
export function allowedActions(settings: PortalSettingsLike): Set<Action> {
  const actions = new Set<Action>();
  if (settings.allowRenewalRequest && settings.showSubscriptions) actions.add("renewal");
  if (settings.allowSeatRequest && settings.showSubscriptions) actions.add("seats");
  if (settings.allowQuestion) actions.add("question");
  return actions;
}

/**
 * What a refused visitor is told.
 *
 * One sentence for every refusal, deliberately. A page that distinguishes "expired" from "never
 * existed" tells whoever is holding a stale link which tokens are real, and the customer's next
 * step is identical in both cases: ask us for a new one.
 */
export const REFUSAL_MESSAGE = "This link is no longer valid.";
