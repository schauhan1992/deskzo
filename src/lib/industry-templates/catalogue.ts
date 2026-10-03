import type { LeadStatus, OrderStatus } from "@prisma/client";
import type { CustomFieldEntity, CustomFieldType } from "@prisma/client";
import type { Term, TermKey } from "@/lib/terms/dictionary";

/**
 * Industry templates (owner, 2 Oct 2026): a workspace's pipeline, order steps, words and fields set up
 * for how one kind of business works — picked at signup or applied later from Settings → Industry
 * templates. Plain data, versioned with the code: applying one writes ordinary rows (src/lib/
 * industry-templates/apply.ts), and nothing stays bound to the template afterwards.
 *
 * A template only adds and renames. A stage that means the same as one of the template's is renamed to
 * it; one the template has no use for is retired when nobody's lead is in it, and kept when somebody's
 * is. Steps and fields are added beside what is there; words are set; nothing is deleted.
 */

export type TemplateStage = { label: string; status: LeadStatus };
export type TemplateStep = { label: string; status: Extract<OrderStatus, "APPROVED" | "PROCESSING" | "FULFILLED"> };
export type TemplateField = {
  entity: CustomFieldEntity;
  label: string;
  type: CustomFieldType;
  options?: string[];
  helpText?: string;
  /** A column in the list from the start. */
  showInList?: boolean;
};

export type IndustryTemplate = {
  key: string;
  name: string;
  /** One line, for the card and the signup choice. */
  summary: string;
  stages: TemplateStage[];
  steps: TemplateStep[];
  terms: Partial<Record<TermKey, Term>>;
  fields: TemplateField[];
  /** Switched on when the plan includes them. */
  modules: string[];
};

const term = (one: string, many: string, a: "a" | "an" = "a"): Term => ({ one, many, a });

export const INDUSTRY_TEMPLATES: readonly IndustryTemplate[] = [
  {
    key: "system_integrators",
    name: "System integrators",
    summary: "CCTV, networking, AV, access control and fire — from the site survey to handing the installation over.",
    stages: [
      { label: "Enquiry", status: "NEW" },
      { label: "Site survey", status: "CONTACTED" },
      { label: "Solution design", status: "QUALIFYING" },
      { label: "Quotation sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "PO received", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not a fit", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Material ordered", status: "PROCESSING" },
      { label: "Material received", status: "PROCESSING" },
      { label: "Installation", status: "PROCESSING" },
      { label: "Testing and commissioning", status: "PROCESSING" },
      { label: "Handed over", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), order: term("Project", "Projects"), ticket: term("Service call", "Service calls") },
    fields: [
      { entity: "LEAD", label: "Solution type", type: "MULTI_SELECT", options: ["CCTV", "Networking", "AV", "Access control", "Fire"], showInList: true },
      { entity: "LEAD", label: "Site address", type: "LONG_TEXT" },
      { entity: "LEAD", label: "Survey date", type: "DATE" },
      { entity: "ORDER", label: "Site code", type: "TEXT", showInList: true },
      { entity: "ORDER", label: "Installation date", type: "DATE" },
      { entity: "ORDER", label: "Warranty till", type: "DATE" },
      { entity: "ORDER", label: "AMC included", type: "CHECKBOX" },
    ],
    modules: [],
  },
  {
    key: "real_estate",
    name: "Real estate",
    summary: "Enquiries to site visits to bookings, and each booking through agreement, home loan, registration and possession.",
    stages: [
      { label: "Enquiry", status: "NEW" },
      { label: "Contacted", status: "CONTACTED" },
      { label: "Site visit scheduled", status: "QUALIFYING" },
      { label: "Site visit done", status: "QUALIFIED" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "Booked", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not interested", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Booking amount received", status: "APPROVED" },
      { label: "Agreement signed", status: "PROCESSING" },
      { label: "Home loan sanctioned", status: "PROCESSING" },
      { label: "Registration", status: "PROCESSING" },
      { label: "Possession", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), customer: term("Buyer", "Buyers"), order: term("Booking", "Bookings"), item: term("Unit", "Units") },
    fields: [
      { entity: "LEAD", label: "Budget range", type: "TEXT", helpText: "For example 80 lakh – 1 crore", showInList: true },
      { entity: "LEAD", label: "Configuration", type: "SELECT", options: ["1 BHK", "2 BHK", "3 BHK", "4 BHK or more", "Villa", "Plot"], showInList: true },
      { entity: "LEAD", label: "Preferred location", type: "TEXT" },
      { entity: "LEAD", label: "Home loan needed", type: "CHECKBOX" },
      { entity: "ITEM", label: "Tower", type: "TEXT", showInList: true },
      { entity: "ITEM", label: "Floor", type: "NUMBER" },
      { entity: "ITEM", label: "Carpet area", type: "NUMBER", helpText: "Square feet" },
      { entity: "ITEM", label: "Facing", type: "SELECT", options: ["North", "South", "East", "West", "North-east", "North-west", "South-east", "South-west"] },
      { entity: "ORDER", label: "Booking amount", type: "MONEY" },
      { entity: "ORDER", label: "Agreement date", type: "DATE" },
      { entity: "ORDER", label: "Possession date", type: "DATE" },
    ],
    modules: [],
  },
  {
    key: "it_services",
    name: "IT services",
    summary: "Discovery to proposal to project, and each project from kick-off to go-live and hypercare.",
    stages: [
      { label: "Lead", status: "NEW" },
      { label: "Discovery call", status: "CONTACTED" },
      { label: "Requirements", status: "QUALIFYING" },
      { label: "Proposal sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "Won", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not a fit", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Kick-off", status: "PROCESSING" },
      { label: "In development", status: "PROCESSING" },
      { label: "Testing (UAT)", status: "PROCESSING" },
      { label: "Go-live", status: "FULFILLED" },
      { label: "Hypercare", status: "FULFILLED" },
    ],
    terms: { order: term("Project", "Projects"), item: term("Service", "Services"), ticket: term("Support request", "Support requests") },
    fields: [
      { entity: "LEAD", label: "Engagement type", type: "SELECT", options: ["Fixed price", "Time and material", "Retainer", "Managed service"], showInList: true },
      { entity: "LEAD", label: "Tech stack", type: "TEXT" },
      { entity: "ORDER", label: "Project manager", type: "USER", showInList: true },
      { entity: "ORDER", label: "Go-live date", type: "DATE" },
      { entity: "ORDER", label: "SLA tier", type: "SELECT", options: ["Basic", "Standard", "Premium"] },
    ],
    modules: [],
  },
  {
    key: "manufacturing",
    name: "Manufacturing",
    summary: "RFQs through sampling and quotation to the PO, and each order from raw material to dispatch.",
    stages: [
      { label: "Enquiry", status: "NEW" },
      { label: "RFQ received", status: "QUALIFYING" },
      { label: "Sampling / technical review", status: "QUALIFIED" },
      { label: "Quotation sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "PO received", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Regret", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "Raw material procured", status: "PROCESSING" },
      { label: "In production", status: "PROCESSING" },
      { label: "Quality check", status: "PROCESSING" },
      { label: "Packed", status: "PROCESSING" },
      { label: "Dispatched", status: "FULFILLED" },
    ],
    terms: { lead: term("Enquiry", "Enquiries", "an"), order: term("Sales order", "Sales orders") },
    fields: [
      { entity: "LEAD", label: "RFQ number", type: "TEXT", showInList: true },
      { entity: "LEAD", label: "Annual volume", type: "NUMBER" },
      { entity: "LEAD", label: "Drawing link", type: "URL" },
      { entity: "LEAD", label: "Sample required", type: "CHECKBOX" },
      { entity: "ITEM", label: "Material grade", type: "TEXT", showInList: true },
      { entity: "ITEM", label: "Minimum order quantity", type: "NUMBER" },
      { entity: "ITEM", label: "Lead time in days", type: "NUMBER" },
      { entity: "ORDER", label: "Customer PO date", type: "DATE" },
      { entity: "ORDER", label: "Dispatch date", type: "DATE" },
      { entity: "ORDER", label: "Inspection required", type: "CHECKBOX" },
    ],
    modules: [],
  },
  {
    key: "software_resellers",
    name: "Software resellers",
    summary: "Requirement to OEM deal registration to PO, licences issued and onboarded — with renewals and add-on seats.",
    stages: [
      { label: "Lead", status: "NEW" },
      { label: "Requirement captured", status: "QUALIFYING" },
      { label: "OEM deal registered", status: "QUALIFIED" },
      { label: "Quotation sent", status: "PROPOSAL_SENT" },
      { label: "Negotiation", status: "NEGOTIATION" },
      { label: "PO received", status: "WON" },
      { label: "Lost", status: "LOST" },
      { label: "Not a fit", status: "DISQUALIFIED" },
    ],
    steps: [
      { label: "PO placed with distributor", status: "PROCESSING" },
      { label: "Licences issued", status: "PROCESSING" },
      { label: "Delivered to customer", status: "FULFILLED" },
      { label: "Customer onboarded", status: "FULFILLED" },
    ],
    terms: {},
    fields: [
      { entity: "LEAD", label: "Licence type", type: "SELECT", options: ["New", "Renewal", "Upgrade", "Migration", "True-up"], showInList: true },
      { entity: "LEAD", label: "Seats needed", type: "NUMBER" },
      { entity: "LEAD", label: "Current licence expiry", type: "DATE" },
      { entity: "LEAD", label: "Competing partner", type: "TEXT" },
      { entity: "COMPANY", label: "Tenant / domain", type: "TEXT", helpText: "For example contoso.onmicrosoft.com" },
      { entity: "ORDER", label: "Agreement number", type: "TEXT" },
      { entity: "ORDER", label: "Distributor PO number", type: "TEXT" },
      { entity: "ORDER", label: "Licence admin email", type: "EMAIL" },
    ],
    // Renewals, add-on seats, OEM deal registrations and backend rebates all live in Orders and Renewals.
    modules: ["orders", "renewals"],
  },
];

export const TEMPLATE_KEYS = INDUSTRY_TEMPLATES.map((t) => t.key);

export function templateOf(key: unknown): IndustryTemplate | null {
  return INDUSTRY_TEMPLATES.find((t) => t.key === key) ?? null;
}
