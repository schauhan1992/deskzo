import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { customerEmailSettings, ticketAcknowledgementOn } from "@/lib/customer-email-settings";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { emailRouteFor } from "@/lib/marketing/pipeline";
import { documentSendMode, documentSendModeLabels } from "@/lib/documents/mail-route";
import { supportReplySettings } from "@/lib/support-mail/send";
import { eachStep, type Definition, type Step } from "@/lib/automate/definition";
import { triggerByType } from "@/lib/automate/triggers";
import { workflowRef } from "@/lib/automate/refs";

/**
 * Settings › Customer emails (owner, 18 Oct 2026): every email Deskzo sends a workspace's customers, in
 * one list — what it is, whether it goes on its own or a person sends it, where it goes from, and what
 * stops it — with a switch for each that goes on its own.
 *
 * What stops each is one of three rules (src/lib/marketing/suppression.ts):
 *
 *   · hard stops — a bounced address, one that reported the company's mail as spam, a reseller's customer
 *     (who hears from the reseller): business the customer is part of — a document, a ticket reply, a
 *     meeting invitation, an order confirmation — always goes otherwise;
 *   · their choices — a reminder (a renewal reminder, a workflow's email, a form invitation) also stops
 *     when they unsubscribed from everything, were suppressed here by hand, or unticked its topic;
 *   · marketing — only to people who opted in, within quiet hours and the weekly cap.
 *
 * The switches are where the workspace already keeps them — the ticket acknowledgement on Support email's
 * row, each workflow's own on and off — except the booking page's invitation, which is kept here.
 */

// ─── What each step of a workflow sends a customer ────────────────────────────────────────────────

export type WorkflowEmailKind = "email" | "document" | "meeting";

/**
 * What a workflow's steps email a customer: a "Send an email" to a contact (not a colleague), "Email a
 * document", a meeting with its contact invited — at any depth, inside branches and paths.
 */
export function customerEmailsIn(steps: Step[]): WorkflowEmailKind[] {
  const kinds = new Set<WorkflowEmailKind>();
  for (const { step } of eachStep(steps)) {
    if (step.type !== "action") continue;
    if (step.action === "email.send" && step.input.to !== "person") kinds.add("email");
    if (step.action === "document.email") kinds.add("document");
    if (step.action === "meeting.schedule" && step.input.inviteContact !== false) kinds.add("meeting");
  }
  return [...kinds];
}

export type CustomerWorkflow = { id: string; ref: string; name: string; status: "ACTIVE" | "PAUSED"; when: string; owner: string; kinds: WorkflowEmailKind[] };

/** The workflows, on or paused, whose published version emails customers. */
export async function workflowsEmailingCustomers(): Promise<CustomerWorkflow[]> {
  try {
    const workflows = await db.automationWorkflow.findMany({
      where: { status: { in: ["ACTIVE", "PAUSED"] }, activeVersionId: { not: null } },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      take: 500,
      select: { id: true, workflowSeq: true, name: true, status: true, activeVersionId: true, ownerUserId: true },
    });
    if (!workflows.length) return [];
    const [versions, owners] = await Promise.all([
      db.automationVersion.findMany({ where: { id: { in: workflows.map((w) => w.activeVersionId!) } }, select: { id: true, definition: true } }),
      db.user.findMany({ where: { id: { in: [...new Set(workflows.map((w) => w.ownerUserId))] } }, select: { id: true, name: true } }),
    ]);
    const definitionOf = new Map(versions.map((v) => [v.id, v.definition as unknown as Definition]));
    const ownerOf = new Map(owners.map((o) => [o.id, o.name]));
    return workflows.flatMap((w) => {
      const definition = definitionOf.get(w.activeVersionId!);
      const kinds = definition ? customerEmailsIn(definition.steps ?? []) : [];
      if (!kinds.length || (w.status !== "ACTIVE" && w.status !== "PAUSED")) return [];
      return [{ id: w.id, ref: workflowRef(w.workflowSeq), name: w.name, status: w.status, when: triggerByType(definition!.trigger?.type ?? "")?.label ?? "", owner: ownerOf.get(w.ownerUserId) ?? "", kinds }];
    });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

// ─── The list ─────────────────────────────────────────────────────────────────────────────────────

export type StopRule = "hard" | "choices" | "marketing";

export type CustomerEmailRow = {
  key: string;
  label: string;
  /** Who it goes to. */
  to: string;
  /** On its own — something happened — or sent by a person. */
  automatic: boolean;
  from: string;
  stops: StopRule;
  /** Said under the rule, where the rule needs more. */
  note: string | null;
  manage: { label: string; href: string } | null;
  /** The switch for one that goes on its own, where this page keeps one. */
  toggle: { kind: "acknowledge" | "booking"; on: boolean } | null;
};

export type CustomerEmailOverview = {
  rows: CustomerEmailRow[];
  workflows: CustomerWorkflow[] | null;
  /** The company's mail server for transactional mail, if set up. */
  companyServer: string | null;
};

const CALENDAR_ROUTE = "The person's connected calendar; otherwise their own mailbox, the company's mail server, or Deskzo's mail";

/** Every email this workspace's modules send its customers, as the page lists them. */
export async function customerEmailOverview(): Promise<CustomerEmailOverview> {
  const has = async (...keys: string[]) => (await Promise.all(keys.map((k) => moduleAvailableForTenant(k)))).some(Boolean);
  const [helpdesk, booking, automate, marketing, documents, notices, calendar, forms] = await Promise.all([
    has("helpdesk"),
    has("booking"),
    has("automate"),
    has("marketing"),
    has("sales_documents", "purchase_documents"),
    has("renewals", "orders"),
    has("calendar"),
    has("forms"),
  ]);
  const [transactional, marketingRoute, support, sendMode, settings, acknowledge, workflows, journeys] = await Promise.all([
    emailRouteFor("TRANSACTIONAL"),
    marketing ? emailRouteFor("MARKETING") : Promise.resolve(null),
    helpdesk ? supportReplySettings() : Promise.resolve(null),
    documents ? documentSendMode() : Promise.resolve(null),
    customerEmailSettings(),
    helpdesk ? ticketAcknowledgementOn() : Promise.resolve(true),
    automate ? workflowsEmailingCustomers() : Promise.resolve(null),
    marketing ? db.journey.count({ where: { status: "ACTIVE" } }).catch(() => 0) : Promise.resolve(0),
  ]);
  const server = transactional ? transactional.fromEmail ?? transactional.label : null;
  const companyOnly = server ? `The company's mail server (${server})` : "The company's mail server — none is set up, so these aren't sent";
  const supportFrom = support
    ? support.replyFrom === "COMPANY"
      ? server
        ? `The company's mail server (${support.companyFrom ?? server}), Deskzo's support mail if it refuses one`
        : "Deskzo's support mail — the company's mail server isn't set up"
      : "Deskzo's support mail, in the company's name"
    : "";

  const rows: CustomerEmailRow[] = [];
  if (helpdesk) {
    rows.push({
      key: "ticket-acknowledgement",
      label: "Ticket acknowledgement",
      to: "Whoever emails your support address",
      automatic: true,
      from: supportFrom,
      stops: "hard",
      note: "Says the ticket is open and that replying adds to it.",
      manage: { label: "Support email", href: "/settings/support-email" },
      toggle: { kind: "acknowledge", on: acknowledge },
    });
  }
  if (booking) {
    rows.push({
      key: "booking-invitation",
      label: "Booking invitation",
      to: "The guest who books a time on a booking page",
      automatic: true,
      from: "The host's connected calendar; otherwise their own mailbox, the company's mail server, or Deskzo's mail",
      stops: "hard",
      note: "Off: the time still goes in the host's calendar, with the guest's details, and the guest isn't emailed.",
      manage: { label: "Booking pages", href: "/booking-pages" },
      toggle: { kind: "booking", on: settings.bookingInvite },
    });
  }
  if (marketing) {
    rows.push({
      key: "journeys",
      label: "Journeys",
      to: "Contacts a journey's trigger enrols",
      automatic: true,
      from: marketingRoute ? `The company's mail server (${marketingRoute.fromEmail ?? marketingRoute.label})` : "The company's mail server — none is set up for marketing, so these aren't sent",
      stops: "marketing",
      note: `${journeys} journey${journeys === 1 ? "" : "s"} on. Each is switched on and off on its own page.`,
      manage: { label: "Journeys", href: "/marketing/journeys" },
      toggle: null,
    });
  }
  if (documents) {
    rows.push({
      key: "documents",
      label: "Quotes, proformas, invoices and credit notes",
      to: "The customer's contacts the sender picks",
      automatic: false,
      from: sendMode ? documentSendModeLabels[sendMode].label : "",
      stops: "hard",
      note: "With the PDF attached. A workflow can send one too.",
      manage: { label: "Document emails", href: "/settings/document-emails" },
      toggle: null,
    });
  }
  if (notices) {
    rows.push({
      key: "order-notices",
      label: "Renewal reminder, renewal confirmed, order fulfilled",
      to: "The billed customer's contacts — the reseller, on a reseller's order",
      automatic: false,
      from: companyOnly,
      stops: "hard",
      note: "The renewal reminder also stops for a customer who unticked renewal reminders or unsubscribed from everything. The confirmations always go.",
      manage: { label: "Renewals", href: "/renewals" },
      toggle: null,
    });
  }
  if (helpdesk) {
    rows.push({
      key: "ticket-replies",
      label: "Replies on tickets",
      to: "Whoever raised the ticket, and anybody copied",
      automatic: false,
      from: supportFrom,
      stops: "hard",
      note: null,
      manage: { label: "Support email", href: "/settings/support-email" },
      toggle: null,
    });
  }
  if (calendar) {
    rows.push({
      key: "meetings",
      label: "Meeting invitations",
      to: "Contacts and addresses invited to a meeting",
      automatic: false,
      from: CALENDAR_ROUTE,
      stops: "hard",
      note: "Changes and cancellations too.",
      manage: null,
      toggle: null,
    });
  }
  if (forms) {
    rows.push({
      key: "form-invitations",
      label: "Form and event invitations",
      to: "The contacts invited to a form or event",
      automatic: false,
      from: companyOnly,
      stops: "choices",
      note: "Stops for the form's topic unticked, too.",
      manage: { label: "Forms & events", href: "/marketing/forms" },
      toggle: null,
    });
  }
  if (marketing) {
    rows.push({
      key: "campaigns",
      label: "Campaigns and mass mail",
      to: "An audience or a mailing list",
      automatic: false,
      from: marketingRoute ? `The company's mail server (${marketingRoute.fromEmail ?? marketingRoute.label})` : "The company's mail server — none is set up for marketing, so these aren't sent",
      stops: "marketing",
      note: "Quiet hours, the weekly cap and approvals are set in Mail & messaging.",
      manage: { label: "Mail & messaging", href: "/settings/messaging" },
      toggle: null,
    });
  }
  return { rows, workflows, companyServer: server };
}
