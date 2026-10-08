import type { NotificationType } from "@prisma/client";

/**
 * Every notification type, in words somebody can make a decision about.
 *
 * The enum has thirty-nine values with names like `REGULARISATION_DECIDED`. A preferences screen
 * that lists those is a screen nobody uses: the names are ours, the grouping is alphabetical by
 * accident, and there is no way to tell which ones matter. So each is given a label, a sentence
 * saying when it fires, and a group — and `check:notifications` asserts the registry covers the
 * enum exactly, so a type added next year cannot quietly go missing from the screen.
 *
 * ## `alwaysOn`
 *
 * A few cannot be switched off, and the list is deliberately short. They are the ones whose whole
 * purpose is that somebody is told whether or not they want to be: a security alert, and the two
 * that say somebody opened a credential you are responsible for. Access nobody is told about is
 * access nobody reviews, and an opt-out would make that true by choice rather than by accident.
 */

export type NotificationGroupKey =
  | "work"
  | "sales"
  | "support"
  | "money"
  | "people"
  | "security"
  | "customers";

export const NOTIFICATION_GROUPS: { key: NotificationGroupKey; label: string; blurb: string }[] = [
  { key: "work", label: "My work", blurb: "Tasks, callbacks and reminders addressed to you." },
  { key: "sales", label: "Sales", blurb: "Leads, orders and renewals." },
  { key: "support", label: "Support", blurb: "Tickets and the customers behind them." },
  { key: "money", label: "Money", blurb: "Expenses, and the payments clients promised." },
  { key: "people", label: "People", blurb: "Leave, attendance, letters and the office calendar." },
  { key: "customers", label: "Customers", blurb: "Feedback, forms and the customer portal." },
  { key: "security", label: "Security", blurb: "Who opened what. Mostly not optional." },
];

export type NotificationDefinition = {
  type: NotificationType;
  label: string;
  /** When it fires, in one sentence. */
  when: string;
  group: NotificationGroupKey;
  /** Cannot be switched off. Keep this list short — see the note above. */
  alwaysOn?: boolean;
};

export const NOTIFICATION_CATALOGUE: NotificationDefinition[] = [
  // ─── My work ────────────────────────────────────────────────────────────────────────────────
  { type: "TASK_ASSIGNED", label: "A task is assigned to me", when: "Somebody puts a task in your name.", group: "work" },
  { type: "TASK_DUE", label: "A task is due", when: "One of your tasks reaches its due date.", group: "work" },
  { type: "TASK_OVERDUE", label: "A task is overdue", when: "A due date passes with the task still open.", group: "work" },
  { type: "CALLBACK_DUE", label: "A callback is due", when: "A time you promised to ring somebody back arrives.", group: "work" },
  { type: "NOTE_REMINDER", label: "A note reminder", when: "A sticky note you set a reminder on comes round.", group: "work" },
  { type: "MEETING_SOON", label: "A meeting is about to start", when: "A meeting in your connected calendar starts within ten minutes.", group: "work" },
  { type: "SURVEY_ASSIGNED", label: "A form to fill in", when: "HR aims a form or poll at you.", group: "work" },
  { type: "VISITOR_ARRIVED", label: "A visitor is at reception", when: "Somebody signs in at the front desk asking for you.", group: "work" },
  { type: "VISITOR_EXPECTED", label: "A visitor is expected", when: "A visitor you invited is due shortly, or somebody adds one in your name.", group: "work" },

  // ─── Sales ──────────────────────────────────────────────────────────────────────────────────
  { type: "LEAD_ASSIGNED", label: "A lead is assigned to me", when: "A lead is put in your name.", group: "sales" },
  { type: "LEAD_STATUS_CHANGED", label: "A lead moves stage", when: "One of your leads is won, lost or moved along.", group: "sales" },
  { type: "LEAD_ACTIVITY", label: "Activity on my lead", when: "Somebody logs a call, note or meeting against your lead.", group: "sales" },
  { type: "ACCOUNT_MANAGER_ASSIGNED", label: "I am made account manager", when: "A company is assigned to you.", group: "sales" },
  { type: "CALLER_ASSIGNED", label: "A calling list is assigned", when: "Companies are allocated to you to ring.", group: "sales" },
  { type: "ORDER_STATUS_CHANGED", label: "An order changes status", when: "An order you raised or watch is approved, processed or fulfilled.", group: "sales" },
  { type: "ORDER_WATCHER_ADDED", label: "I am added to an order", when: "Somebody adds you as a watcher.", group: "sales" },
  { type: "DOCUMENT_APPROVAL_REQUESTED", label: "A document needs my approval", when: "Somebody submits a quotation or invoice you are an approver for. Never for your own — nobody approves what they submitted.", group: "sales" },
  { type: "DOCUMENT_APPROVAL_DECIDED", label: "My document was approved or sent back", when: "An approver signs off something you submitted, or sends it back with a reason.", group: "sales" },
  { type: "RENEWAL_EXPIRING", label: "A renewal is coming up", when: "A subscription on your accounts enters its expiry window.", group: "sales" },
  { type: "VISIT_SCHEDULED", label: "A visit is scheduled", when: "A field visit is booked in your name.", group: "sales" },

  // ─── Support ────────────────────────────────────────────────────────────────────────────────
  { type: "TICKET_ASSIGNED", label: "A ticket is assigned to me", when: "A ticket is put in your name.", group: "support" },
  { type: "TICKET_STATUS_CHANGED", label: "A ticket changes status", when: "A ticket you raised or hold is resolved, reopened or closed.", group: "support" },
  { type: "TICKET_COMMENT", label: "Somebody comments on a ticket", when: "A comment is added to a ticket you are on.", group: "support" },
  { type: "TICKET_EMAIL", label: "A customer emails support", when: "An email opens a ticket, answers one you are on, or waits in the Support inbox.", group: "support" },
  { type: "TICKET_SLA_OVERDUE", label: "A ticket breaches its SLA", when: "One of your tickets passes its response or resolution window.", group: "support" },
  { type: "PROJECT_STATUS_CHANGED", label: "A project changes status", when: "A project you are on moves stage.", group: "support" },
  { type: "PROJECT_STAKEHOLDER_ADDED", label: "I am added to a project", when: "Somebody adds you to a project, which is also how you got sight of it.", group: "support" },

  // ─── Money ──────────────────────────────────────────────────────────────────────────────────
  { type: "EXPENSE_SUBMITTED", label: "An expense needs my approval", when: "Somebody who reports to you submits a claim.", group: "money" },
  { type: "EXPENSE_DECIDED", label: "My expense is decided", when: "A claim of yours is approved or rejected.", group: "money" },
  { type: "EXPENSE_REIMBURSED", label: "My expense is paid", when: "A claim of yours is reimbursed.", group: "money" },
  { type: "PAYMENT_PROMISE_BROKEN", label: "A client broke a promise to pay", when: "The date a client promised to pay by passes without the money — on a follow-up you, or somebody who reports to you, logged.", group: "money" },
  { type: "PAYMENT_PROMISES_SUMMARY", label: "Broken promises to pay, once a day", when: "Clients' promised dates passed without the money — one summary a day, for whoever records payments.", group: "money" },
  { type: "PAYMENT_FOLLOW_UP_DUE", label: "A payment follow-up is due", when: "The day you planned to chase a client's payment again arrives, when no task reminds you.", group: "money" },

  // ─── People ─────────────────────────────────────────────────────────────────────────────────
  { type: "LEAVE_REQUESTED", label: "Leave needs my approval", when: "Somebody who reports to you asks for leave.", group: "people" },
  { type: "LEAVE_DECIDED", label: "My leave is decided", when: "Your leave request is approved or rejected.", group: "people" },
  { type: "REGULARISATION_REQUESTED", label: "Attendance needs my approval", when: "Somebody asks to correct their attendance.", group: "people" },
  { type: "REGULARISATION_DECIDED", label: "My attendance fix is decided", when: "Your correction is approved or rejected.", group: "people" },
  { type: "LETTER_ISSUED", label: "A letter is issued to me", when: "HR issues you an offer, confirmation or any other letter.", group: "people" },
  { type: "BIRTHDAY_TODAY", label: "Somebody's birthday", when: "A colleague has a birthday today.", group: "people" },
  { type: "WORK_ANNIVERSARY", label: "A work anniversary", when: "A colleague reaches a year with the company.", group: "people" },
  { type: "WISHES", label: "Colleagues wish me", when: "Somebody wishes you on your birthday or work anniversary. One notice for the day, however many wish you.", group: "people" },
  { type: "ACTIVITY_AWARD", label: "Awards and prizes", when: "The fortnight's most active, the month's top sellers, the prizes up for grabs — and a note to you when you win.", group: "people" },
  { type: "HOLIDAY_UPCOMING", label: "A holiday is coming", when: "A company holiday is a few days away.", group: "people" },

  // ─── Customers ──────────────────────────────────────────────────────────────────────────────
  { type: "FEEDBACK_RECEIVED", label: "A customer leaves feedback", when: "A customer answers a feedback request on your account.", group: "customers" },
  { type: "FEEDBACK_SUBMITTED", label: "Feedback about me", when: "Somebody leaves feedback naming you.", group: "customers" },
  { type: "FORM_RESPONSE", label: "Somebody answers a form", when: "A customer answers a form of yours, or replies to an invitation you sent.", group: "customers" },
  { type: "PORTAL_REQUEST", label: "A customer asks for something", when: "A customer raises a renewal, licence or question from their portal.", group: "customers" },

  // ─── Security ───────────────────────────────────────────────────────────────────────────────
  {
    type: "SECURITY_ALERT",
    label: "A security alert",
    when: "The DLP layer sees a screenshot, a refused download or reading that looks like collection.",
    group: "security",
    alwaysOn: true,
  },
  {
    type: "VAULT_CREDENTIAL_OPENED",
    label: "Somebody opens a password I own",
    when: "Any reveal that is not your own, including an admin override.",
    group: "security",
    alwaysOn: true,
  },
  {
    type: "PROJECT_CREDENTIAL_VIEWED",
    label: "Somebody opens a project credential",
    when: "Anyone other than the project manager opens a stored credential.",
    group: "security",
    alwaysOn: true,
  },
  { type: "VAULT_SHARED", label: "A password is shared with me", when: "Somebody gives you access to a stored credential.", group: "security" },
];

const BY_TYPE = new Map(NOTIFICATION_CATALOGUE.map((d) => [d.type, d]));

export function describeNotification(type: NotificationType): NotificationDefinition | null {
  return BY_TYPE.get(type) ?? null;
}

/**
 * The label to show for a type, falling back to something readable.
 *
 * A type added to the schema and not to the catalogue would otherwise render as
 * `REGULARISATION_DECIDED` on the list. `check:notifications` makes that a build-time failure
 * rather than a thing somebody notices in production, but the fallback is here anyway — a missing
 * label should degrade, not crash.
 */
export function notificationLabel(type: NotificationType): string {
  return BY_TYPE.get(type)?.label ?? type.toLowerCase().replace(/_/g, " ");
}

export function isAlwaysOn(type: NotificationType): boolean {
  return BY_TYPE.get(type)?.alwaysOn === true;
}

export type Channel = "inApp" | "email";

/**
 * Whether one notification should be delivered down one channel.
 *
 * The rules, in order:
 *
 *   1. **Always-on types ignore preferences entirely.** Not "default to on" — ignored, so a row
 *      written by hand or left over from before a type became always-on cannot switch it off.
 *   2. Otherwise the stored preference, if there is one.
 *   3. Otherwise on. Absent means "never expressed an opinion", and the default for a new type has
 *      to be on or nobody would ever find out it existed.
 */
export function wants(
  type: NotificationType,
  channel: Channel,
  preference: { inApp: boolean; email: boolean } | null | undefined,
): boolean {
  if (isAlwaysOn(type)) return true;
  if (!preference) return true;
  return channel === "inApp" ? preference.inApp : preference.email;
}
