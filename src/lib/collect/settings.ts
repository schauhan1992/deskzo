import type { MsmeCategory } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * How a workspace collects (owner, 23 Oct 2026): the payment reminder schedule, credit hold, and the MSME
 * details its late-payment interest is worked out from — `CollectionSettings`, one row, every default where
 * there is none. A workspace not migrated yet reads as the defaults with reminders off.
 */

export type ReminderTone = "friendly" | "firm" | "final";

export type ReminderStep = {
  /** Stable, for the log: one send of a step per invoice, ever. */
  key: string;
  /** Days from the due date: negative before it, 0 on it. */
  days: number;
  tone: ReminderTone;
  on: boolean;
  subject: string;
  body: string;
};

/**
 * The fields a reminder fills in besides a document email's own (src/lib/documents/email-template.ts):
 * what's left to pay, how late it is, the pay-now line, and — on a final notice, for an MSME — the interest.
 */
export const REMINDER_FIELDS = [
  { key: "invoice.balance", label: "What's still to pay on it", example: "₹1,18,000.00" },
  { key: "invoice.daysOverdue", label: "How many days past due it is", example: "15" },
  { key: "payment.link", label: "The pay-now link, where a gateway is connected", example: "https://rzp.io/i/AbC123" },
  { key: "payment.line", label: "A sentence with the pay-now link, or nothing", example: "You can pay it online here: https://rzp.io/i/AbC123" },
  { key: "interest.line", label: "MSMED Act interest on it so far, for a micro or small business, or nothing", example: "Under section 16 of the MSMED Act…" },
] as const;

export type ReminderFieldKey = (typeof REMINDER_FIELDS)[number]["key"];

const SIGN_OFF = `Regards,
{{sender.name}}
{{company.name}}
{{sender.phone|}}`;

/** The standard schedule (owner, 23 Oct 2026): 3 days before, on the day, 7, 15 and 30 days late, a final notice at 45. */
export const DEFAULT_STEPS: ReminderStep[] = [
  {
    key: "before-3",
    days: -3,
    tone: "friendly",
    on: true,
    subject: "{{document.type}} {{document.number}} is due on {{document.dueDate}}",
    body: `Dear {{recipient.names|Sir/Madam}},

A friendly reminder that {{document.number}} for {{invoice.balance}} is due on {{document.dueDate}}. It's attached again for you.

{{payment.line|}}

${SIGN_OFF}`,
  },
  {
    key: "due",
    days: 0,
    tone: "friendly",
    on: true,
    subject: "{{document.type}} {{document.number}} is due today",
    body: `Dear {{recipient.names|Sir/Madam}},

{{document.number}} for {{invoice.balance}} is due today. It's attached for your reference.

{{payment.line|}}

If it's already on its way, thank you — please ignore this.

${SIGN_OFF}`,
  },
  {
    key: "over-7",
    days: 7,
    tone: "friendly",
    on: true,
    subject: "{{document.type}} {{document.number}} is overdue",
    body: `Dear {{recipient.names|Sir/Madam}},

{{document.number}} for {{invoice.balance}} was due on {{document.dueDate}} and is now {{invoice.daysOverdue}} days overdue. It's attached again.

{{payment.line|}}

If something is holding it up, just reply to this email and we'll sort it out.

${SIGN_OFF}`,
  },
  {
    key: "over-15",
    days: 15,
    tone: "firm",
    on: true,
    subject: "Payment overdue: {{document.number}}",
    body: `Dear {{recipient.names|Sir/Madam}},

{{document.number}} for {{invoice.balance}} is still unpaid, {{invoice.daysOverdue}} days after it was due on {{document.dueDate}}.

Please arrange payment this week, or let us know by reply when we can expect it.

{{payment.line|}}

${SIGN_OFF}`,
  },
  {
    key: "over-30",
    days: 30,
    tone: "firm",
    on: true,
    subject: "Second notice: {{document.number}} is {{invoice.daysOverdue}} days overdue",
    body: `Dear {{recipient.names|Sir/Madam}},

Despite our reminders, {{document.number}} for {{invoice.balance}}, due on {{document.dueDate}}, remains unpaid {{invoice.daysOverdue}} days later.

Please treat this as a priority and pay it within the next few days.

{{payment.line|}}

${SIGN_OFF}`,
  },
  {
    key: "final-45",
    days: 45,
    tone: "final",
    on: true,
    subject: "Final notice: {{document.type}} {{document.number}}",
    body: `Dear {{recipient.names|Sir/Madam}},

{{document.type}} {{document.number}} for {{invoice.balance}} was due on {{document.dueDate}} and is now {{invoice.daysOverdue}} days overdue, despite our earlier reminders.

Please pay it within 7 days of this notice. If we don't hear from you, we may have to hold further orders and take the matter further.

{{interest.line|}}

{{payment.line|}}

${SIGN_OFF}`,
  },
];

export const STEP_DAYS_RANGE = { min: -30, max: 365 } as const;
export const MAX_STEPS = 10;
export const HOLD_DAYS_RANGE = { min: 1, max: 365 } as const;

/** Steps as stored, checked: anything malformed is the standard schedule rather than a broken run. */
export function parseSteps(value: unknown): ReminderStep[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_STEPS;
  const steps: ReminderStep[] = [];
  for (const raw of value.slice(0, MAX_STEPS)) {
    if (!raw || typeof raw !== "object") return DEFAULT_STEPS;
    const s = raw as Record<string, unknown>;
    const days = Number(s.days);
    if (typeof s.key !== "string" || !s.key || !Number.isInteger(days) || days < STEP_DAYS_RANGE.min || days > STEP_DAYS_RANGE.max) return DEFAULT_STEPS;
    if (typeof s.subject !== "string" || typeof s.body !== "string" || !s.subject.trim() || !s.body.trim()) return DEFAULT_STEPS;
    const tone: ReminderTone = s.tone === "firm" || s.tone === "final" ? s.tone : "friendly";
    steps.push({ key: s.key, days, tone, on: s.on !== false, subject: s.subject, body: s.body });
  }
  return [...steps].sort((a, b) => a.days - b.days);
}

export type CollectionConfig = {
  remindersOn: boolean;
  remindersFrom: Date | null;
  senderUserId: string | null;
  steps: ReminderStep[];
  /** Whether the steps are the standard schedule, unedited. */
  standardSteps: boolean;
  statementOn: boolean;
  whatsappTemplate: string | null;
  creditHoldOn: boolean;
  creditHoldDays: number;
  udyamNumber: string | null;
  msmeCategory: MsmeCategory | null;
  bankRate: number | null;
  /** False where the workspace's database hasn't the table yet. */
  migrated: boolean;
};

const DEFAULTS: Omit<CollectionConfig, "migrated"> = {
  remindersOn: false,
  remindersFrom: null,
  senderUserId: null,
  steps: DEFAULT_STEPS,
  standardSteps: true,
  statementOn: true,
  whatsappTemplate: null,
  creditHoldOn: true,
  creditHoldDays: 60,
  udyamNumber: null,
  msmeCategory: null,
  bankRate: null,
};

export async function collectionConfig(): Promise<CollectionConfig> {
  try {
    const row = await db.collectionSettings.findUnique({ where: { id: "default" } });
    if (!row) return { ...DEFAULTS, migrated: true };
    return {
      remindersOn: row.remindersOn,
      remindersFrom: row.remindersFrom,
      senderUserId: row.senderUserId,
      steps: parseSteps(row.steps),
      standardSteps: row.steps === null,
      statementOn: row.statementOn,
      whatsappTemplate: row.whatsappTemplate,
      creditHoldOn: row.creditHoldOn,
      creditHoldDays: row.creditHoldDays,
      udyamNumber: row.udyamNumber,
      msmeCategory: row.msmeCategory,
      bankRate: row.bankRate === null ? null : Number(row.bankRate),
      migrated: true,
    };
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return { ...DEFAULTS, migrated: false };
  }
}

/** Whether this business may claim MSMED Act interest: a micro or small enterprise, registered, with the bank rate known. */
export function msmeClaims(config: Pick<CollectionConfig, "udyamNumber" | "msmeCategory" | "bankRate">): boolean {
  return !!config.udyamNumber && (config.msmeCategory === "MICRO" || config.msmeCategory === "SMALL") && config.bankRate !== null && config.bankRate > 0;
}
