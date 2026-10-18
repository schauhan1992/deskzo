import type { Definition } from "@/lib/automate/definition";

/**
 * Ready-made workflows (Deskzo Automate, Phase 3): each is a draft with a few blanks to fill in — who
 * to tell, how long to wait — that opens in the builder to be read, tested and published. Nothing
 * from a template runs until a person presses Publish. One template may make two workflows when the
 * job needs two starting points (reminders before and after a due date).
 *
 * Plain data and pure functions, so the gallery can show them; src/lib/automate/store.ts makes them.
 */

export type Blank =
  | { key: string; label: string; kind: "person"; required: boolean; hint?: string }
  | { key: string; label: string; kind: "people"; hint?: string }
  | { key: string; label: string; kind: "number"; default: number; min: number; max: number; hint?: string }
  | { key: string; label: string; kind: "time"; default: string; hint?: string }
  | { key: string; label: string; kind: "choice"; default: string; options: { value: string; label: string }[]; hint?: string };

export type BlankValues = Record<string, unknown>;

export type Template = {
  key: string;
  name: string;
  description: string;
  /** What it does, step by step, for the gallery. */
  steps: string[];
  blanks: Blank[];
  build(values: BlankValues): { name: string; description: string; definition: Definition }[];
};

const n = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== "" && v !== null && v !== undefined ? Number(v) : fallback);
const s = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
const list = (v: unknown, fallback: string[]) => (Array.isArray(v) && v.length ? v.map(String) : fallback);

const LEAD = "{{trigger.lead.id}}";
const MAIL_FROM = {
  key: "from",
  label: "Emails go from",
  kind: "choice" as const,
  default: "lead_owner",
  options: [
    { value: "lead_owner", label: "The lead owner's mailbox" },
    { value: "company", label: "The company's mail server" },
  ],
};

export const TEMPLATES: readonly Template[] = [
  {
    key: "website-enquiry",
    name: "Website enquiry: assign, acknowledge, remind",
    description: "A lead from the website goes to whoever the assignment rules choose, gets a thank-you, and its owner a reminder if nobody has moved it on.",
    steps: ["A website lead comes in", "Give it to whoever the assignment rules choose", "Email the person a thank-you", "Wait", "If it's still New, give its owner a task to call"],
    blanks: [{ key: "hours", label: "Remind after (hours)", kind: "number", default: 2, min: 1, max: 72 }, MAIL_FROM],
    build: (v) => [
      {
        name: "Website enquiry: assign, acknowledge, remind",
        description: "A website lead is assigned by the rules, thanked, and followed up if it sits.",
        definition: {
          schema: 1,
          trigger: { type: "lead.created", filter: { all: [{ ref: "trigger.lead.source", op: "eq", value: "WEBSITE" }] } },
          steps: [
            { id: "assign", type: "action", action: "lead.assign", input: { leadId: LEAD, to: "rules" } },
            {
              id: "thank",
              type: "action",
              action: "email.send",
              input: { to: "lead_contact", leadId: LEAD, from: s(v.from, "lead_owner"), subject: "Thank you for your enquiry", body: "Hello {{trigger.contact.name}},\n\nThank you for getting in touch. We have your enquiry and will call you shortly.\n\nRegards" },
            },
            { id: "wait", type: "delay", for: { hours: n(v.hours, 2) } },
            { id: "now", name: "Read the lead again", type: "action", action: "lead.get", input: { leadId: LEAD } },
            { id: "untouched", name: "Only if it's still New", type: "condition", if: { all: [{ ref: "steps.now.output.status", op: "eq", value: "NEW" }] } },
            { id: "call", type: "action", action: "task.create", input: { title: "Call {{trigger.contact.name}} about {{trigger.lead.title}}", assignTo: "lead_owner", dueInDays: 0, leadId: LEAD } },
          ],
          settings: { onError: "continue" },
        },
      },
    ],
  },
  {
    key: "lead-assignment",
    name: "New lead assignment",
    description: "Every new lead nobody has given to anybody goes to whoever the assignment rules choose — by region, product or source — and they are told.",
    steps: ["A lead is created", "If it has no owner, give it to whoever the assignment rules choose", "Tell its new owner"],
    blanks: [],
    build: () => [
      {
        name: "New lead assignment",
        description: "Leads with no owner go by the assignment rules.",
        definition: {
          schema: 1,
          trigger: { type: "lead.created", filter: { all: [{ ref: "trigger.lead.ownerUserId", op: "isEmpty" }] } },
          steps: [
            { id: "assign", type: "action", action: "lead.assign", input: { leadId: LEAD, to: "rules" } },
            { id: "tell", type: "action", action: "notify.person", input: { to: "lead_owner", title: "A new lead is yours", message: "{{trigger.lead.title}} — {{trigger.company.name}}", leadId: LEAD } },
          ],
        },
      },
    ],
  },
  {
    key: "lead-quiet",
    name: "Follow up when a lead goes quiet",
    description: "When an open lead hasn't moved stage for a few days, its owner gets a task to follow it up.",
    steps: ["Every day, leads that haven't moved stage", "On the day it reaches the number of days set", "A follow-up task for its owner, and a note in their bell"],
    blanks: [{ key: "days", label: "Quiet for (days)", kind: "number", default: 5, min: 3, max: 60 }],
    build: (v) => [
      {
        name: `Follow up leads quiet for ${n(v.days, 5)} days`,
        description: "Open leads that haven't moved stage get a follow-up task.",
        definition: {
          schema: 1,
          trigger: { type: "lead.quiet", filter: { all: [{ ref: "trigger.daysQuiet", op: "eq", value: n(v.days, 5) }] } },
          steps: [
            { id: "task", type: "action", action: "task.create", input: { title: "Follow up: {{trigger.lead.title}} — quiet for {{trigger.daysQuiet}} days", assignTo: "lead_owner", dueInDays: 0, leadId: LEAD } },
            { id: "tell", type: "action", action: "notify.person", input: { to: "lead_owner", title: "A lead has gone quiet", message: "{{trigger.lead.title}} hasn't moved in {{trigger.daysQuiet}} days.", leadId: LEAD } },
          ],
          settings: { onError: "continue" },
        },
      },
    ],
  },
  {
    key: "invoice-reminders",
    name: "Invoice payment reminders",
    description: "The customer is sent the invoice again a few days before it falls due, and on set days after — makes two workflows, one for each.",
    steps: ["Before: a few days before the due date, email the invoice again", "After: on days 1, 7 and 15 overdue, email it again and tell the salesperson (or you, if it has none)"],
    blanks: [{ key: "before", label: "Days before the due date", kind: "number", default: 3, min: 1, max: 7 }],
    build: (v) => {
      const doc = "{{trigger.document.id}}";
      return [
        {
          name: "Invoice reminder before it falls due",
          description: "The invoice again, a few days before it is due.",
          definition: {
            schema: 1,
            trigger: { type: "invoice.due_soon", filter: { all: [{ ref: "trigger.daysUntilDue", op: "eq", value: n(v.before, 3) }] } },
            steps: [
              {
                id: "remind",
                type: "action",
                action: "document.email",
                input: { documentId: doc, subject: "A reminder: invoice {{trigger.document.number}} is due in {{trigger.daysUntilDue}} days", body: "Dear {{recipient.names}},\n\nA friendly reminder that invoice {{document.number}} for {{document.total}} is due on {{document.dueDate}}. It is attached again for you.\n\nRegards,\n{{sender.name}}" },
              },
            ],
          },
        },
        {
          name: "Invoice reminder once it is overdue",
          description: "The invoice again on days 1, 7 and 15 past due, and the salesperson told.",
          definition: {
            schema: 1,
            trigger: { type: "invoice.overdue", filter: { all: [{ ref: "trigger.daysOverdue", op: "in", value: [1, 7, 15] }] } },
            steps: [
              {
                id: "remind",
                type: "action",
                action: "document.email",
                input: { documentId: doc, subject: "Invoice {{trigger.document.number}} is overdue", body: "Dear {{recipient.names}},\n\nInvoice {{document.number}} for {{document.total}} was due on {{document.dueDate}} and is still open. It is attached again; please let us know if anything is holding it up.\n\nRegards,\n{{sender.name}}" },
              },
              // The salesperson — or, on an invoice with none, the workflow's owner.
              { id: "who", type: "transform", set: { person: { fn: "value.default", args: ["{{trigger.document.salespersonId}}", "owner"] } } },
              { id: "tell", type: "action", action: "notify.person", input: { to: "{{steps.who.output.person}}", title: "An invoice is overdue", message: "{{trigger.document.number}} — {{trigger.company.name}}, {{trigger.daysOverdue}} days" } },
            ],
            settings: { onError: "continue" },
          },
        },
      ];
    },
  },
  {
    key: "renewal-notices",
    name: "Subscription renewal notices",
    description: "The customer is told a subscription is coming up for renewal 30, 15 and 7 days before it ends, and its account manager too.",
    steps: ["Every day, subscriptions ending soon", "On days 30, 15 and 7 before the end", "Email the customer's main contact", "Tell the account manager"],
    blanks: [],
    build: () => [
      {
        name: "Subscription renewal notices",
        description: "30, 15 and 7 days before a subscription ends.",
        definition: {
          schema: 1,
          trigger: { type: "renewal.due", filter: { all: [{ ref: "trigger.daysLeft", op: "in", value: [30, 15, 7] }] } },
          steps: [
            {
              id: "tell_customer",
              type: "action",
              action: "email.send",
              input: {
                to: "company_contact",
                companyId: "{{trigger.company.id}}",
                from: "company",
                // Stopped for a customer who unticks renewal reminders (owner, 18 Oct 2026).
                topic: "RENEWALS",
                subject: "Your {{trigger.order.itemName}} renews in {{trigger.daysLeft}} days",
                body: "Hello,\n\nYour subscription to {{trigger.order.itemName}} ({{trigger.order.quantity}}) comes up for renewal in {{trigger.daysLeft}} days. We will be in touch about renewing it; reply to this email with any questions.\n\nRegards",
              },
            },
            // The account manager — or, for a customer with none, the workflow's owner.
            { id: "who", type: "transform", set: { person: { fn: "value.default", args: ["{{trigger.company.ownerUserId}}", "owner"] } } },
            { id: "tell_manager", type: "action", action: "notify.person", input: { to: "{{steps.who.output.person}}", title: "A renewal is coming up", message: "{{trigger.company.name}}: {{trigger.order.itemName}} in {{trigger.daysLeft}} days" } },
          ],
          settings: { onError: "continue" },
        },
      },
    ],
  },
  {
    key: "ticket-escalation",
    name: "Escalate unanswered tickets",
    description: "A ticket nobody has answered within a few hours is raised to high priority and somebody is told.",
    steps: ["A ticket is opened", "Wait", "If nobody has answered it, raise it to high priority", "Tell the person named"],
    blanks: [
      { key: "hours", label: "Unanswered for (hours)", kind: "number", default: 4, min: 1, max: 72 },
      { key: "tell", label: "Tell", kind: "person", required: true, hint: "The support lead, usually." },
    ],
    build: (v) => {
      const id = "{{trigger.ticket.id}}";
      return [
        {
          name: `Escalate tickets unanswered for ${n(v.hours, 4)} hours`,
          description: "Unanswered tickets are raised and somebody is told.",
          definition: {
            schema: 1,
            trigger: { type: "ticket.created" },
            steps: [
              { id: "wait", type: "delay", for: { hours: n(v.hours, 4) } },
              { id: "now", name: "Read the ticket again", type: "action", action: "ticket.get", input: { ticketId: id } },
              { id: "unanswered", name: "Only if nobody has answered", type: "condition", if: { all: [{ ref: "steps.now.output.answered", op: "eq", value: false }] } },
              { id: "raise", type: "action", action: "ticket.update", input: { ticketId: id, priority: "HIGH" } },
              { id: "tell", type: "action", action: "notify.person", input: { to: s(v.tell, "owner"), title: "A ticket is waiting for an answer", message: "{{trigger.ticket.ref}} — {{trigger.ticket.title}} ({{trigger.company.name}})", ticketId: id } },
            ],
            settings: { onError: "continue" },
          },
        },
      ];
    },
  },
  {
    key: "booking-confirmation",
    name: "Booking confirmation and reminder",
    description: "Somebody who books a slot is sent a confirmation straight away and a reminder the day before.",
    steps: ["Somebody books a slot", "Email them a confirmation", "Wait until a day before", "Email them a reminder"],
    blanks: [
      {
        key: "from",
        label: "Emails go from",
        kind: "choice",
        default: "company",
        options: [
          { value: "company", label: "The company's mail server" },
          { value: "owner", label: "The workflow owner's mailbox" },
        ],
      },
    ],
    build: (v) => {
      const contact = "{{trigger.contactId}}";
      return [
        {
          name: "Booking confirmation and reminder",
          description: "A confirmation when a slot is booked, and a reminder the day before.",
          definition: {
            schema: 1,
            trigger: { type: "booking.made" },
            steps: [
              // The slot's time as people read it, on the workspace's clock.
              { id: "slot", type: "transform", set: { at: { fn: "date.text", args: ["{{trigger.booking.startsAt}}"] } } },
              { id: "confirm", type: "action", action: "email.send", input: { to: "contact", contactId: contact, from: s(v.from, "company"), subject: "Your booking: {{trigger.booking.page}}", body: "Hello,\n\nThank you for booking {{trigger.booking.page}}. It's in our calendar for {{steps.slot.output.at}}; you'll have the invitation separately.\n\nRegards" } },
              { id: "wait", type: "delay", on: { value: "{{trigger.booking.startsAt}}", before: { hours: 24 } } },
              { id: "remind", type: "action", action: "email.send", input: { to: "contact", contactId: contact, from: s(v.from, "company"), subject: "Tomorrow: {{trigger.booking.page}}", body: "Hello,\n\nA reminder of {{trigger.booking.page}}, {{steps.slot.output.at}}. Reply to this email if you need to move it.\n\nRegards" } },
            ],
            settings: { onError: "continue" },
          },
        },
      ];
    },
  },
  {
    key: "daily-sales-report",
    name: "Daily sales report",
    description: "Every morning, yesterday's won deals by salesperson, emailed to the people named — each seeing only what they could see on the Reports page.",
    steps: ["Every day at the time set", "Run yesterday's won value by salesperson for each person named", "Email it to them"],
    blanks: [
      { key: "at", label: "At", kind: "time", default: "09:00" },
      { key: "to", label: "Send to", kind: "people", hint: "You, when nobody is named." },
    ],
    build: (v) => [
      {
        name: "Daily sales report",
        description: "Yesterday's won value by salesperson, every morning.",
        definition: {
          schema: 1,
          trigger: { type: "schedule", schedule: { every: "day", at: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v.at)) ? String(v.at) : "09:00" } },
          steps: [{ id: "report", type: "action", action: "report.email", input: { source: "leads", measure: "wonValue", dimension: "owner", period: "yesterday", to: list(v.to, ["owner"]), subject: "Yesterday's sales" } }],
        },
      },
    ],
  },
  {
    key: "customer-onboarding",
    name: "Customer onboarding after a won deal",
    description: "A won deal gets a kick-off call and a welcome email; once the call is done — or the time runs out — the person you choose decides whether support takes the customer on.",
    steps: [
      "A lead is won",
      "Give its owner a kick-off call to make",
      "Email the contact a welcome",
      "Wait for the kick-off call to be done",
      "Ask for approval to hand the customer to support",
      "Approved: open an onboarding ticket. Not: a task to keep it going",
    ],
    blanks: [
      { key: "approver", label: "Who decides the hand-over", kind: "person", required: true },
      { key: "days", label: "Wait for the call (days)", kind: "number", default: 7, min: 1, max: 30 },
      MAIL_FROM,
    ],
    build: (v) => [
      {
        name: "Customer onboarding after a won deal",
        description: "A kick-off call and a welcome for a won deal, then a decision on handing the customer to support.",
        definition: {
          schema: 1,
          trigger: { type: "lead.won" },
          steps: [
            { id: "kickoff", name: "Kick-off call", note: "Its owner calls the new customer within two days.", type: "action", action: "task.create", input: { title: "Kick-off call with {{trigger.contact.name}} — {{trigger.company.name}}", assignTo: "lead_owner", dueInDays: 2, leadId: LEAD } },
            {
              id: "welcome",
              name: "Welcome them",
              note: "A welcome from the deal's owner, so replies come back to them.",
              type: "action",
              action: "email.send",
              input: { to: "lead_contact", leadId: LEAD, from: s(v.from, "lead_owner"), subject: "Welcome aboard", body: "Hello {{trigger.contact.name}},\n\nThank you for choosing us. We will call you in the next two days to plan the start together.\n\nRegards" },
            },
            {
              id: "called",
              name: "Wait for the kick-off call",
              note: "Until the kick-off task is marked done.",
              type: "waitForEvent",
              event: "task.completed",
              filter: { all: [{ ref: "event.task.id", op: "eq", value: "{{steps.kickoff.output.taskId}}" }] },
              timeout: { days: n(v.days, 7) },
              onTimeout: "continue",
            },
            {
              id: "handover",
              name: "Hand over to support?",
              note: "Whoever you chose decides, in their Approvals.",
              type: "approval",
              title: "Hand {{trigger.company.name}} over to support?",
              message: "The deal \"{{trigger.lead.title}}\" is won and its kick-off is due or done. Approve to open an onboarding ticket for support.",
              approvers: [s(v.approver, "owner")],
              timeout: { days: 5 },
              onTimeout: "rejected",
              approved: [{ id: "ticket", name: "Onboarding ticket", type: "action", action: "ticket.create", input: { companyId: "{{trigger.company.id}}", title: "Onboarding: {{trigger.company.name}}", priority: "MEDIUM" } }],
              rejected: [{ id: "keep_going", name: "Keep it going", type: "action", action: "task.create", input: { title: "Keep onboarding {{trigger.company.name}} going", assignTo: "lead_owner", dueInDays: 3, leadId: LEAD } }],
            },
          ],
        },
      },
    ],
  },
  {
    key: "employee-onboarding",
    name: "Employee onboarding checklist",
    description: "When somebody joins: a task for each item on the checklist, a welcome for them and a heads-up for IT at the same time, and HR asked to confirm when it is all done.",
    steps: ["Somebody joins the company", "A task for each item on the checklist", "At the same time: welcome them, and tell IT", "Ask HR to confirm the onboarding is done", "Approved: tell their manager. Not: a task to finish it"],
    blanks: [
      { key: "hr", label: "Who looks after onboarding (HR)", kind: "person", required: true },
      { key: "it", label: "Who sets up laptops and accounts (IT)", kind: "person", required: true },
    ],
    build: (v) => {
      const hr = s(v.hr, "owner");
      const it = s(v.it, "owner");
      return [
        {
          name: "Employee onboarding checklist",
          description: "A checklist of tasks for each new joiner, IT told, and HR's confirmation at the end.",
          definition: {
            schema: 1,
            trigger: { type: "person.joined" },
            steps: [
              { id: "who", name: "Their manager, or HR", type: "transform", set: { person: { fn: "value.default", args: ["{{trigger.person.managerId}}", hr] } } },
              {
                id: "checklist",
                name: "The checklist",
                note: "Change the items to your own.",
                type: "forEach",
                items: ["Laptop and email account", "ID card and building access", "Welcome kit", "Bank and payroll details", "Introduce them to the team"],
                steps: [{ id: "item", name: "A task for the item", type: "action", action: "task.create", input: { title: "{{steps.checklist.output.item}} — {{trigger.person.name}}", assignTo: hr, dueInDays: 3 } }],
              },
              {
                id: "together",
                name: "Welcome and IT",
                type: "parallel",
                paths: [
                  { name: "Welcome them", steps: [{ id: "welcome", type: "action", action: "notify.person", input: { to: "{{trigger.person.id}}", title: "Welcome to the team, {{trigger.person.name}}", message: "We're glad you're here. Your checklist is under way." } }] },
                  { name: "Tell IT", steps: [{ id: "tell_it", type: "action", action: "notify.person", input: { to: it, title: "Set up a laptop and accounts for {{trigger.person.name}}", message: "{{trigger.person.name}} joins as {{trigger.person.designation}}." } }] },
                ],
              },
              {
                id: "done",
                name: "Onboarding done?",
                note: "HR confirms once every item is done.",
                type: "approval",
                title: "Is {{trigger.person.name}}'s onboarding done?",
                approvers: [hr],
                timeout: { days: 14 },
                onTimeout: "rejected",
                approved: [{ id: "tell_manager", type: "action", action: "notify.person", input: { to: "{{steps.who.output.person}}", title: "{{trigger.person.name}} is fully onboarded" } }],
                rejected: [{ id: "finish", type: "action", action: "task.create", input: { title: "Finish onboarding {{trigger.person.name}}", assignTo: hr, dueInDays: 2 } }],
              },
            ],
          },
        },
      ];
    },
  },
];

export function templateByKey(key: string): Template | null {
  return TEMPLATES.find((t) => t.key === key) ?? null;
}

/** Why the values don't fill the template's blanks, or null. */
export function blankProblem(template: Template, values: BlankValues): string | null {
  for (const blank of template.blanks) {
    const v = values[blank.key];
    if (blank.kind === "person" && blank.required && (typeof v !== "string" || !v.trim())) return `Choose who for "${blank.label}".`;
    if (blank.kind === "number" && v !== undefined && v !== "") {
      const num = Number(v);
      if (!Number.isInteger(num) || num < blank.min || num > blank.max) return `"${blank.label}" is a whole number from ${blank.min} to ${blank.max}.`;
    }
    if (blank.kind === "time" && v !== undefined && v !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) return `"${blank.label}" is a time, hh:mm.`;
    if (blank.kind === "choice" && v !== undefined && v !== "" && !blank.options.some((o) => o.value === v)) return `Choose one of the options for "${blank.label}".`;
  }
  return null;
}
