/**
 * Who may move an account or a lead from one person to another.
 *
 * Two permissions, so an organisation can choose how far a salesperson's own reach goes:
 *
 *   accounts.reassign    any account or lead the holder can see — its account manager, its caller,
 *                        a lead's owner — and may leave one with nobody.
 *   accounts.handOffOwn  only what is the holder's already: an account they manage (its manager and
 *                        its caller), an account they are the caller on (the caller), a lead they own.
 *                        Always *to somebody*: handing off is giving it to a colleague, and leaving
 *                        an account unowned is a manager's call.
 *
 * Neither reaches past the account scope. The actions check `canSeeCompany` first and answer an
 * account outside it exactly as they answer one that does not exist. That matters most for the
 * account manager, because the account manager *is* the scope: setting it is the one change that
 * would otherwise let somebody grant themselves sight of a company.
 *
 * These are the rules; the actions enforce them, and the screens use the same functions to decide
 * whether to show the controls at all — so nobody is offered a button that will refuse them.
 */

// The rules alone — no session, no database — so anything can import them, including the checks.

export type ReassignRights = { any: boolean; own: boolean };

type AccountHolders = { ownerUserId: string | null; assignedToUserId?: string | null };

/** May change who manages this account. */
export function mayChangeAccountManager(rights: ReassignRights, actorId: string, account: AccountHolders): boolean {
  return rights.any || (rights.own && account.ownerUserId === actorId);
}

/** May change who calls this account — its manager may, and so may the caller handing it on. */
export function mayChangeCaller(rights: ReassignRights, actorId: string, account: AccountHolders): boolean {
  return rights.any || (rights.own && (account.ownerUserId === actorId || account.assignedToUserId === actorId));
}

/** May change who owns this lead. */
export function mayChangeLeadOwner(rights: ReassignRights, actorId: string, lead: { ownerUserId: string | null }): boolean {
  return rights.any || (rights.own && lead.ownerUserId === actorId);
}

/** Leaving something with nobody is a reassignment, not a hand-off. */
export function mayLeaveUnassigned(rights: ReassignRights): boolean {
  return rights.any;
}

/** Whether to show a bulk "change owner / caller" control at all. */
export function mayReassignAnything(rights: ReassignRights): boolean {
  return rights.any || rights.own;
}
