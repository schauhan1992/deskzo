/**
 * What can start a workflow (Deskzo Automate), and the fields each hands to `{{trigger.…}}`.
 *
 * A schedule and a person pressing Run start a workflow themselves. The Deskzo events are recorded
 * where the change happens, in its transaction (src/lib/automate/emit-*.ts), and the date checks once
 * a day (src/lib/automate/dates.ts). `fields` are the top-level names a workflow reads.
 */

export type TriggerDefinition = {
  type: string;
  label: string;
  /** The top-level fields of `{{trigger.…}}`. */
  fields: readonly string[];
  /** Recorded by `emitEvent`, as opposed to started by the worker or a person. */
  event: boolean;
};

export const TRIGGERS: readonly TriggerDefinition[] = [
  { type: "schedule", label: "On a schedule", fields: ["scheduledFor", "firedAt"], event: false },
  { type: "manual", label: "When somebody presses Run", fields: ["startedById", "data"], event: false },
  { type: "lead.created", label: "A lead is created", fields: ["lead", "company", "contact", "via"], event: true },
  { type: "lead.stage_changed", label: "A lead moves stage", fields: ["lead", "company", "contact", "from", "to"], event: true },
  { type: "lead.won", label: "A lead is won", fields: ["lead", "company", "contact", "from", "to"], event: true },
  { type: "lead.lost", label: "A lead is lost or disqualified", fields: ["lead", "company", "contact", "from", "to"], event: true },
  { type: "lead.quiet", label: "A lead has gone quiet (daily)", fields: ["lead", "company", "daysQuiet"], event: true },
  { type: "ticket.created", label: "A ticket is opened", fields: ["ticket", "company", "via"], event: true },
  { type: "ticket.status_changed", label: "A ticket's status changes", fields: ["ticket", "company", "from", "to"], event: true },
  { type: "document.issued", label: "A document is issued (quote, proforma, invoice…)", fields: ["document", "company"], event: true },
  { type: "invoice.paid", label: "An invoice is paid in full", fields: ["document", "company"], event: true },
  { type: "invoice.overdue", label: "An invoice is overdue (daily)", fields: ["document", "company", "daysOverdue"], event: true },
  { type: "payment.received", label: "A payment comes in", fields: ["payment", "company"], event: true },
  { type: "order.created", label: "An order is placed", fields: ["order", "company"], event: true },
  { type: "order.approved", label: "An order is approved", fields: ["order", "company"], event: true },
  { type: "order.fulfilled", label: "An order is fulfilled", fields: ["order", "company"], event: true },
  { type: "renewal.due", label: "A subscription is coming up for renewal (daily)", fields: ["order", "company", "daysLeft"], event: true },
  { type: "form.submitted", label: "A form is sent", fields: ["form", "submission", "companyId", "contactId", "leadId", "invited"], event: true },
  { type: "booking.made", label: "Somebody books a slot", fields: ["booking", "companyId", "contactId", "leadId"], event: true },
  { type: "task.created", label: "A task is created", fields: ["task"], event: true },
  { type: "task.completed", label: "A task is done", fields: ["task"], event: true },
];

export function triggerByType(type: string): TriggerDefinition | null {
  return TRIGGERS.find((t) => t.type === type) ?? null;
}
