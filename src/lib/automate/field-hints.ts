/**
 * How the builder shows each action's fields (Deskzo Automate, Phase 3) — what the input schema can't
 * say: a field's words, that it picks a person or a stage, that it is long text, what its special
 * values mean. Plain data, so the browser can import it; the schema itself stays the rule
 * (src/lib/automate/actions/*), and what isn't named here is shown from the schema alone.
 */

export type FieldKind = "text" | "longText" | "number" | "boolean" | "enum" | "person" | "people" | "list" | "json" | "datetime" | "stage";

/** What a record-id field is the id of — so the data picker offers that record's id first. */
export type RecordKind = "lead" | "ticket" | "company" | "contact" | "document" | "order";

export type FieldHint = {
  label?: string;
  kind?: FieldKind;
  hint?: string;
  record?: RecordKind;
  /** Values with a meaning of their own, offered before the people list: "owner", "lead_owner", "rules". */
  special?: { value: string; label: string }[];
  /** Words for an enum's values. */
  options?: Record<string, string>;
  /** Shown only while another field holds one of these values — "Contact" only when sending to a contact. */
  showWhen?: Record<string, string[]>;
};

const OWNER = { value: "owner", label: "The workflow's owner" };
const LEAD_OWNER = { value: "lead_owner", label: "The lead's owner" };
const RULES = { value: "rules", label: "Whoever the assignment rules choose" };

const lead = { label: "Lead", record: "lead" } as const;
const ticket = { label: "Ticket", record: "ticket" } as const;
const company = { label: "Customer", record: "company" } as const;

export const FIELD_HINTS: Record<string, Record<string, FieldHint>> = {
  "task.create": {
    title: { label: "Task" },
    description: { kind: "longText" },
    assignTo: { label: "For", kind: "person", special: [OWNER, LEAD_OWNER] },
    dueInDays: { label: "Due in (days)", hint: "0 is today. Leave empty for no due date." },
    leadId: lead,
    ticketId: ticket,
    companyId: company,
  },
  "notify.person": {
    to: { label: "Tell", kind: "person", special: [OWNER, LEAD_OWNER] },
    title: { label: "Notification" },
    message: { kind: "longText" },
    link: { hint: "A page in the app, such as /tasks. A lead's or ticket's own page when it is about one." },
    leadId: lead,
    ticketId: ticket,
  },
  "lead.create": {
    name: { label: "Person's name" },
    message: { kind: "longText", hint: "Kept on the lead's description." },
    interest: { label: "What they want" },
    value: { label: "Value" },
    owner: { label: "Give it to", kind: "person", special: [RULES, OWNER] },
    pipelineId: { label: "Pipeline", hint: "The main pipeline when empty." },
  },
  "lead.assign": { leadId: lead, to: { label: "Give it to", kind: "person", special: [RULES, OWNER] } },
  "lead.move": {
    leadId: lead,
    stageId: { label: "Stage", kind: "stage" },
    status: {
      label: "Or the stage meaning",
      options: { NEW: "New", CONTACTED: "Contacted", QUALIFIED: "Qualified", PROPOSAL_SENT: "Proposal sent", NEGOTIATION: "Negotiation", WON: "Won", LOST: "Lost", DISQUALIFIED: "Disqualified" },
    },
    lostReason: { label: "Reason, if lost" },
  },
  "lead.note": { leadId: lead, note: { kind: "longText" }, type: { label: "Kind", options: { NOTE: "Note", CALL: "Call", EMAIL: "Email", MEETING: "Meeting" } } },
  "lead.get": { leadId: lead },
  "ticket.create": {
    companyId: company,
    contactId: { label: "Contact", record: "contact" },
    orderId: { label: "Order", record: "order" },
    title: { label: "Ticket" },
    description: { kind: "longText" },
    ticketType: { label: "Type", options: { PRODUCT_SUPPORT: "Product support", DEMO: "Demo", INSTALLATION: "Installation", TRAINING: "Training", OTHER: "Other" } },
    priority: { options: { LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "Urgent" } },
    assignTo: { label: "Give it to", kind: "person", hint: "Somebody in a support team." },
  },
  "ticket.update": { ticketId: ticket, priority: { options: { LOW: "Low", MEDIUM: "Medium", HIGH: "High", URGENT: "Urgent" } }, assignTo: { label: "Give it to", kind: "person", hint: "Somebody in a support team." } },
  "ticket.get": { ticketId: ticket },
  "email.send": {
    to: { label: "To", options: { lead_contact: "The lead's contact", contact: "A contact", company_contact: "A customer's main contact", person: "A colleague" } },
    leadId: { ...lead, hint: "The lead it is about — needed for its contact or its owner's mailbox, and noted on its timeline." },
    contactId: { label: "Contact", record: "contact", showWhen: { to: ["contact"] } },
    companyId: { ...company, showWhen: { to: ["company_contact"] } },
    userId: { label: "Colleague", kind: "person", special: [OWNER], showWhen: { to: ["person"] } },
    from: { label: "From", options: { owner: "The workflow owner's mailbox", lead_owner: "The lead owner's mailbox", company: "The company's mail server" } },
    body: { label: "Message", kind: "longText" },
  },
  "document.email": {
    documentId: { label: "Document", record: "document" },
    contactIds: { label: "To", kind: "list", hint: "Contacts' ids. Empty: those set to receive documents, else the primary contact." },
    subject: { hint: "The workspace's wording for that kind of document when empty." },
    body: { label: "Message", kind: "longText", hint: "The workspace's wording when empty." },
  },
  "meeting.schedule": {
    record: { label: "About", options: { lead: "A lead", company: "A customer", contact: "A contact", ticket: "A ticket" } },
    recordId: { label: "Which one" },
    startsAt: { label: "Starts at", kind: "text", hint: "A time from the data, such as a booking's start. Otherwise the day and time below." },
    inDays: { label: "In (days)", hint: "0 is today." },
    at: { label: "At", hint: "hh:mm, the workspace's time." },
    durationMinutes: { label: "Minutes" },
    agenda: { kind: "longText" },
    inviteContact: { label: "Invite their contact" },
    colleagueIds: { label: "Colleagues", kind: "people" },
  },
  "report.email": {
    source: { label: "Report", hint: "As the Reports page names them: leads, orders, invoices…" },
    measure: { hint: "count, value, won, wonValue…" },
    dimension: { label: "By", hint: "owner, status, source, company…" },
    column: { label: "Across", hint: "A second breakdown, as columns. Optional." },
    dateField: { label: "Dated on", hint: "The report's own first date when empty." },
    period: { options: { yesterday: "Yesterday", last_7_days: "The last 7 days", last_30_days: "The last 30 days", this_month: "This month so far", last_month: "Last month", this_quarter: "This quarter so far", last_quarter: "Last quarter" } },
    filters: { kind: "json", hint: 'Narrows it: {"owner": ["Asha"]}.' },
    to: { label: "Send to", kind: "people", special: [OWNER] },
  },
};

/** "dueInDays" → "Due in days". */
export function humanize(name: string): string {
  const spaced = name.replace(/Id$/, "").replace(/([A-Z])/g, " $1").toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
