import type { ConsoleRole } from "@/lib/console-shared/types";

/**
 * Who may do what in the platform console — the one place the role sets are written down. Pages use
 * them to decide what to render, actions to decide what to allow (`requireStaff`, which checks again on
 * every call), and the navigation to decide what to list.
 *
 *   OWNER      everything: staff, security, gateway keys, closing a workspace
 *   ADMIN      holds, reopens and migrates workspaces; plans; invitations, terminals, reference data;
 *              partners, their terms and commissions — but never approves or pays a partner
 *   SUPPORT    into a workspace on its super admin's grant; notes and tags
 *   BILLING    plans, limits, trials, prices; billing and revenue; partners' terms and commissions,
 *              and, with OWNER, approving and paying their statements and their bank details (PAYERS)
 *   READONLY   reads, and changes nothing
 */

export const ALL_ROLES: readonly ConsoleRole[] = ["OWNER", "ADMIN", "SUPPORT", "BILLING", "READONLY"];
/** Everybody who changes anything at all — notes, tags, acknowledging alerts. */
export const WRITERS: readonly ConsoleRole[] = ["OWNER", "ADMIN", "SUPPORT", "BILLING"];
export const MANAGERS: readonly ConsoleRole[] = ["OWNER", "ADMIN"];
/** Plans, prices, trials, billing. */
export const SELLERS: readonly ConsoleRole[] = ["OWNER", "ADMIN", "BILLING"];
/** Into a workspace on its grant. */
export const ENTER: readonly ConsoleRole[] = ["OWNER", "ADMIN", "SUPPORT"];
export const OWNERS: readonly ConsoleRole[] = ["OWNER"];
/** Pending signups, with their email addresses (the IP only for managers). */
export const SIGNUP_VIEWERS: readonly ConsoleRole[] = ["OWNER", "ADMIN", "SUPPORT", "BILLING"];
export const SETTINGS_VIEWERS: readonly ConsoleRole[] = ["OWNER", "ADMIN", "BILLING"];
/** The Website CMS page: the CMS's address, its counts and its admins (inviting one is OWNERS only). */
export const WEBSITE_VIEWERS: readonly ConsoleRole[] = ["OWNER", "ADMIN"];
/** The Support inbox and its requests, with what customers wrote and sent. */
export const SUPPORT_VIEWERS: readonly ConsoleRole[] = ["OWNER", "ADMIN", "SUPPORT", "READONLY"];
/** Replying, notes, status, priority, assigning — and opening a request's files and recordings. */
export const SUPPORT_AGENTS: readonly ConsoleRole[] = ["OWNER", "ADMIN", "SUPPORT"];
/** Money that leaves the platform: approving, paying and voiding partner statements, and partners' bank details. */
export const PAYERS: readonly ConsoleRole[] = ["OWNER", "BILLING"];

export function hasRole(role: ConsoleRole, set: readonly ConsoleRole[]): boolean {
  return set.includes(role);
}

/**
 * What a role may do, as plain booleans — serializable, so a server page hands it to a client
 * component as a prop. For showing and hiding only: every action checks the role again itself.
 */
export type Caps = {
  role: ConsoleRole;
  owner: boolean;
  manage: boolean;
  sell: boolean;
  enter: boolean;
  write: boolean;
  viewBilling: boolean;
  viewSignups: boolean;
  viewSignupIp: boolean;
  viewSettings: boolean;
  exportWorkspaces: boolean;
  exportInvoices: boolean;
  exportAudit: boolean;
  ackAlerts: boolean;
  announce: boolean;
  announceAll: boolean;
  editInternalPlans: boolean;
  /** The Support inbox (SUPPORT_VIEWERS). */
  viewSupport: boolean;
  /** Replying and changing requests, and opening their files (SUPPORT_AGENTS). */
  actOnSupport: boolean;
  /** Creating and editing partners: status, users, applications, profile and reseller requests (MANAGERS). */
  managePartners: boolean;
  /** Partners' money: amounts, rates, terms, statements, tax ids, the payout mask (SELLERS). */
  partnerMoney: boolean;
  /** Approving, paying and voiding statements; revealing or setting payout details (PAYERS). */
  payPartners: boolean;
};

export function capsFor(role: ConsoleRole): Caps {
  const owner = hasRole(role, OWNERS);
  const manage = hasRole(role, MANAGERS);
  const sell = hasRole(role, SELLERS);
  return {
    role,
    owner,
    manage,
    sell,
    enter: hasRole(role, ENTER),
    write: hasRole(role, WRITERS),
    viewBilling: sell,
    viewSignups: hasRole(role, SIGNUP_VIEWERS),
    viewSignupIp: manage,
    viewSettings: hasRole(role, SETTINGS_VIEWERS),
    exportWorkspaces: sell,
    exportInvoices: sell,
    exportAudit: manage,
    ackAlerts: hasRole(role, WRITERS),
    announce: manage,
    announceAll: owner,
    editInternalPlans: owner,
    viewSupport: hasRole(role, SUPPORT_VIEWERS),
    actOnSupport: hasRole(role, SUPPORT_AGENTS),
    managePartners: manage,
    partnerMoney: sell,
    payPartners: hasRole(role, PAYERS),
  };
}

/**
 * One line each, for the role radio cards when an owner adds somebody. Nouns and present tense only:
 * the lines are shared text, so they never use the wording kept for the roles allowed to act.
 */
export const ROLE_DESCRIPTIONS: Record<ConsoleRole, string> = {
  OWNER: "Everything an admin does, plus staff, security, gateway keys and closing workspaces for good.",
  ADMIN: "Holds, reopens and migrates workspaces; changes plans; manages invitations and terminals.",
  SUPPORT: "Enters a workspace when its super admin grants access; keeps notes and tags; reads the rest.",
  BILLING: "Changes plans, limits, trials and prices; sees invoices, subscriptions and revenue.",
  READONLY: "Sees workspaces, plans, operations and the audit log, and changes nothing.",
};
