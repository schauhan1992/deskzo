/**
 * What can start a sequence.
 *
 * A registry rather than a switch, shaped like `METRICS` in src/lib/targets/metrics.ts, and for the
 * same reason: every one of these has to say in words what it enrols and what it deliberately
 * leaves out. "Renewals" sounds obvious until somebody asks whether the addon seats count as their
 * own renewal — and if the answer only exists in a query, nobody can check it.
 *
 * `subject` is what the dedupe key is built from, and it is the field most worth getting right. Key
 * a renewal on the company and a customer with three subscriptions gets one reminder. Key it on the
 * subscription and they get three, which is correct.
 */

import type { Clock } from "@/lib/time/zone";

export type TriggerSubject = "SUBSCRIPTION" | "ASSET" | "COMPANY" | "LEAD" | "TICKET" | "ORDER";

export type TriggerDefinition = {
  key: string;
  label: string;
  /** Who this is really for, so the list groups sensibly. */
  team: "Sales" | "Support" | "Renewals" | "Accounts" | "Marketing";
  subject: TriggerSubject;
  /** What puts somebody in. */
  enrols: string;
  /** What it deliberately leaves out — the half people argue about. */
  excludes?: string;
  /** The window in days, where the trigger has one, and what it means. */
  defaultDays?: number;
  daysLabel?: string;
  /** What this usually wants to do: reach the customer, or hand one of ours a job. */
  suits: "EMAIL" | "TASK";
};

export const TRIGGERS: TriggerDefinition[] = [
  {
    key: "SUBSCRIPTION_RENEWAL",
    label: "Subscription coming up for renewal",
    team: "Renewals",
    subject: "SUBSCRIPTION",
    enrols: "Every live subscription whose expiry falls inside the window, once per subscription.",
    excludes:
      "Addon seats. They co-terminate with the parent, so the parent already represents the whole renewal — enrolling them separately would start four conversations about one date.",
    defaultDays: 90,
    daysLabel: "Days before expiry",
    suits: "EMAIL",
  },
  {
    key: "RENEWAL_LAPSED",
    label: "Renewal missed",
    team: "Renewals",
    subject: "SUBSCRIPTION",
    enrols: "Subscriptions that expired inside the window with no renewal order raised against them.",
    excludes: "Anything deliberately cancelled — that was a decision, not an oversight.",
    defaultDays: 30,
    daysLabel: "Days since expiry",
    suits: "TASK",
  },
  {
    key: "WARRANTY_EXPIRING",
    label: "Warranty running out",
    team: "Sales",
    subject: "ASSET",
    enrols: "Client-owned machines whose warranty ends inside the window and that carry no AMC.",
    excludes: "Anything already under AMC — it is covered, and offering cover twice reads as a mistake.",
    defaultDays: 60,
    daysLabel: "Days before warranty ends",
    suits: "TASK",
  },
  {
    key: "AMC_EXPIRING",
    label: "AMC running out",
    team: "Renewals",
    subject: "ASSET",
    enrols: "Machines whose AMC ends inside the window, including ones where it has already lapsed.",
    excludes: "Retired machines.",
    defaultDays: 60,
    daysLabel: "Days before AMC ends",
    suits: "EMAIL",
  },
  {
    key: "NO_COVER_RECORDED",
    label: "Estate with no cover on record",
    team: "Support",
    subject: "COMPANY",
    enrols: "Clients whose managed machines carry neither a warranty nor an AMC date.",
    excludes:
      "Anything with dates that have simply expired — that is a lapse to chase, not a gap in the record, and it has its own trigger.",
    suits: "TASK",
  },
  {
    key: "ASSET_AGEING",
    label: "Machines due for replacement",
    team: "Sales",
    subject: "ASSET",
    enrols: "Client machines bought more than the window ago and still in service.",
    excludes: "Licences, monitors and peripherals — nobody refreshes a monitor on a four-year cycle.",
    defaultDays: 1460,
    daysLabel: "Days since purchase",
    suits: "TASK",
  },
  {
    key: "SEAT_GAP",
    label: "More staff than seats",
    team: "Sales",
    subject: "COMPANY",
    enrols: "Customers whose headcount exceeds the seats they have licensed, by the configured margin.",
    excludes:
      "Companies with no headcount on file. A gap calculated from a blank is a guess, and a wrong guess here is embarrassing.",
    defaultDays: 10,
    daysLabel: "Minimum seat gap",
    suits: "TASK",
  },
  {
    key: "CROSS_SELL",
    label: "Never bought a product line",
    team: "Sales",
    subject: "COMPANY",
    enrols: "Customers who have bought from us but never bought the chosen brand or family.",
    excludes: "Prospects who have never bought anything — that is a lead, not a cross-sell.",
    suits: "EMAIL",
  },
  {
    key: "NEW_CUSTOMER",
    label: "First order placed",
    team: "Sales",
    subject: "COMPANY",
    enrols: "A company the first time an order of theirs is fulfilled.",
    excludes: "Repeat orders. Once per customer, for their lifetime.",
    suits: "EMAIL",
  },
  {
    key: "LEAD_STALLED",
    label: "Lead gone quiet",
    team: "Sales",
    subject: "LEAD",
    enrols: "Open leads whose status has not moved in the window.",
    excludes: "Won, lost and disqualified leads.",
    defaultDays: 21,
    daysLabel: "Days without movement",
    suits: "TASK",
  },
  {
    key: "PROPOSAL_NO_RESPONSE",
    label: "Proposal sent, nothing back",
    team: "Sales",
    subject: "LEAD",
    enrols: "Leads sitting at proposal-sent for longer than the window.",
    defaultDays: 5,
    daysLabel: "Days since the proposal",
    suits: "TASK",
  },
  {
    key: "LEAD_LOST_REVISIT",
    label: "Worth another run at",
    team: "Sales",
    subject: "LEAD",
    enrols: "Lost leads, the configured number of days after they were lost.",
    excludes:
      "Disqualified leads. Lost means somebody else won it and their contract will end; disqualified means they were never a customer for us.",
    defaultDays: 300,
    daysLabel: "Days since lost",
    suits: "TASK",
  },
  {
    key: "TICKET_RESOLVED",
    label: "Support call closed",
    team: "Support",
    subject: "TICKET",
    enrols: "Tickets moved to resolved or closed.",
    excludes:
      "Tickets reopened afterwards — following up on a fix that did not hold is worse than saying nothing.",
    suits: "EMAIL",
  },
  {
    key: "FEEDBACK_PROMOTER",
    label: "Rated us 4 or 5",
    team: "Marketing",
    subject: "COMPANY",
    enrols: "Companies whose most recent feedback was 4 or above — the referral and case-study ask.",
    excludes: "Anyone with newer feedback below 4. The last thing they said is the thing that counts.",
    suits: "EMAIL",
  },
  {
    key: "CUSTOMER_ANNIVERSARY",
    label: "Another year with us",
    team: "Marketing",
    subject: "COMPANY",
    enrols: "Customers on the anniversary of their first order, from the first year onwards.",
    excludes: "The zeroth anniversary, which is just the order.",
    suits: "EMAIL",
  },
  {
    key: "BUDGET_FLUSH",
    label: "Financial year ending",
    team: "Sales",
    subject: "COMPANY",
    enrols: "Customers, once, in the run-up to 31 March — the window where unspent IT budget expires.",
    excludes: "Anybody enrolled in the same financial year already.",
    defaultDays: 75,
    daysLabel: "Days before 31 March",
    suits: "EMAIL",
  },
  {
    key: "PRICE_CHANGE",
    label: "Vendor price change",
    team: "Renewals",
    subject: "COMPANY",
    enrols: "Everybody holding the named product, when a vendor changes what it costs. Started by hand.",
    excludes: "Nothing — a price rise reaches every customer on that product, whatever they scored us.",
    suits: "EMAIL",
  },
  {
    key: "DORMANT_CUSTOMER",
    label: "Gone quiet",
    team: "Sales",
    subject: "COMPANY",
    enrols: "Customers with no order at all in the window.",
    excludes: "Companies that never ordered.",
    defaultDays: 365,
    daysLabel: "Days without an order",
    suits: "TASK",
  },
  {
    key: "PRODUCT_END_OF_LIFE",
    label: "Product reaching end of life",
    team: "Support",
    subject: "COMPANY",
    enrols: "Customers running a product with an end-of-life date inside the window.",
    suits: "EMAIL",
  },
];

export const triggerByKey: Record<string, TriggerDefinition> = Object.fromEntries(
  TRIGGERS.map((t) => [t.key, t]),
);

export function triggerLabel(key: string): string {
  return triggerByKey[key]?.label ?? key;
}

/** The windows a renewal journey normally runs at — the reason one trigger produces four nudges. */
export const RENEWAL_WINDOWS = [90, 60, 30, 7];

/**
 * The Indian financial year ends on 31 March, and the quarter before it is when unspent IT budget
 * has to be committed or lost. Worth its own helper because the year rolls in April, not January.
 * Counted on the workspace's calendar (it was UTC's): the year it ends in, and the days left to it.
 */
export function financialYearEndYear(now: Date, clock: Clock): number {
  const { year, month } = clock.parts(now);
  return month >= 3 ? year + 1 : year;
}

export function daysToFinancialYearEnd(now: Date, clock: Clock): number {
  return clock.daysBetween(now, clock.midnight(financialYearEndYear(now, clock), 2, 31));
}
