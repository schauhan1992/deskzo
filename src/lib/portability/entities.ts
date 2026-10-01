/**
 * The neutral shape this system's data takes when it leaves.
 *
 * ## What this is for
 *
 * There is no universal CRM interchange format. Salesforce, Zoho and Odoo have genuinely
 * incompatible object models, so "export to any CRM" cannot mean one button. What it can mean — and
 * what this file defines — is a complete, documented, versioned description of the data in terms
 * nobody's product owns, from which an implementer can load any target faithfully.
 *
 * ## The three rules
 *
 * **1. Every record is identified by something outside this database.** An internal cuid means
 * nothing in Salesforce. Each entity declares a `naturalKey` built from columns a human or another
 * system recognises — `USR-000001`, a GSTIN, an order number. Without that, a migration cannot be
 * re-run, cannot be verified, and cannot be reconciled against the source.
 *
 * **2. References are by natural key, never by id.** A contact points at its company by that
 * company's key, so the bundle can be loaded in any order and a failed row can be retried alone.
 *
 * **3. What distinguishes a record must travel with it.** The two that bite here:
 *
 *   - `Company` holds four different kinds of party in one table — clients, vendors, resellers and
 *     commission agents — separated only by `relationshipType`. Export them without it and a target
 *     merges your suppliers into your customer list.
 *   - `managedByResellerId` is a contractual do-not-contact flag on a reseller's end customers.
 *     Lose it and you begin marketing, on day one in the new system, to people you may not contact.
 *
 * Both are `required: true` below, which `check:portability` enforces.
 */

export type FieldKind = "string" | "number" | "boolean" | "date" | "enum" | "json";

export type EntityField = {
  name: string;
  kind: FieldKind;
  /** Omitting this loses meaning rather than detail. Enforced by the check script. */
  required?: boolean;
  /** Points at another canonical entity, carried as that entity's natural key. */
  referencesEntity?: string;
  /** Never leaves, or leaves only behind an explicit flag. See `redaction`. */
  sensitivity?: "never" | "onRequest";
  note?: string;
};

export type CanonicalEntity = {
  key: string;
  label: string;
  /** Prisma models this is built from. `check:portability` uses these for coverage. */
  sourceModels: string[];
  /**
   * How a row is identified outside this database. Columns, in order, joined by `|`.
   * A key containing a nullable column is a defect — the check script rejects it.
   */
  naturalKey: string[];
  /** Human sentence for the manifest and the docs. */
  keyNote: string;
  fields: EntityField[];
  /** Which of the export areas in areas.ts surfaces this. */
  area: string;
};

export const CANONICAL_ENTITIES: CanonicalEntity[] = [
  {
    key: "user",
    label: "Users",
    sourceModels: ["User", "Department"],
    naturalKey: ["userSeq"],
    keyNote:
      "USR-nnnnnn from userSeq. Deliberately not email: an address is unique but mutable, and every ownership link in the system resolves through this person.",
    area: "users",
    fields: [
      { name: "userSeq", kind: "number", required: true },
      { name: "name", kind: "string", required: true },
      { name: "email", kind: "string", required: true, note: "Carried as an attribute and a reconciliation fallback, never as the key." },
      { name: "role", kind: "enum", required: true },
      { name: "active", kind: "boolean", required: true },
      { name: "department", kind: "string", note: "Denormalised name — Department has no stable key of its own." },
      { name: "manager", kind: "string", referencesEntity: "user", note: "The reporting line, which drives every scoped view." },
      { name: "isSuperAdmin", kind: "boolean", required: true },
      { name: "passwordHash", kind: "string", sensitivity: "never", note: "Has no legitimate export. A target issues its own credentials." },
      { name: "twoFactorSecretCipher", kind: "string", sensitivity: "never" },
    ],
  },
  {
    key: "account",
    label: "Accounts",
    sourceModels: ["Company", "ResellerProfile", "CommissionPartyLink", "CommissionPartyAccount", "DomainProfile"],
    naturalKey: ["normalizedName"],
    keyNote:
      "The normalised company name, the only unique constraint on the table. GSTIN travels as a reconciliation value but cannot be the key: it lives on a location, is nullable, and one company legitimately holds one per state.",
    area: "companies",
    fields: [
      { name: "normalizedName", kind: "string", required: true },
      { name: "name", kind: "string", required: true },
      {
        name: "relationshipType",
        kind: "enum",
        required: true,
        note: "CLIENT, VENDOR, RESELLER or commission party. One table holds four kinds of party — without this a target merges suppliers into the customer list.",
      },
      {
        name: "managedByReseller",
        kind: "string",
        referencesEntity: "account",
        required: true,
        note: "Non-null means a reseller's end customer: contractually do-not-contact. Losing it means marketing to people you may not.",
      },
      { name: "stage", kind: "enum", required: true },
      { name: "industry", kind: "string", note: "Denormalised name. The picklist is mutable, so the value travels rather than a reference." },
      { name: "source", kind: "string" },
      { name: "owner", kind: "string", referencesEntity: "user", required: true, note: "The account manager — what every scoped view resolves against." },
      { name: "assignedTo", kind: "string", referencesEntity: "user" },
      { name: "website", kind: "string" },
      { name: "createdAt", kind: "date", required: true },
    ],
  },
  {
    key: "account_location",
    label: "Account locations",
    sourceModels: ["CompanyLocation"],
    naturalKey: ["account", "label"],
    keyNote:
      "Company key plus the location label. GSTIN is carried as an attribute, not a key component — it is nullable, and a composite key with a null component silently drops out of every reconciliation query instead of failing loudly.",
    area: "companies",
    fields: [
      { name: "account", kind: "string", referencesEntity: "account", required: true },
      { name: "label", kind: "string", required: true },
      { name: "isPrimary", kind: "boolean", required: true, note: "Now constrained to at most one per company — see migration 20260920120000." },
      { name: "gstNumber", kind: "string", note: "Reconciliation value only. Nullable, and one per state." },
      { name: "gstTreatment", kind: "enum" },
      { name: "address", kind: "string" },
      { name: "city", kind: "string" },
      { name: "state", kind: "string" },
      { name: "pincode", kind: "string" },
    ],
  },
  {
    key: "contact",
    label: "Contacts",
    sourceModels: ["Contact"],
    naturalKey: ["contactSeq"],
    keyNote:
      "CON-nnnnnn from contactSeq. Email is nullable and unconstrained here, and a contact who changes employer would be re-keyed by any composite anchored on their company.",
    area: "contacts",
    fields: [
      { name: "contactSeq", kind: "number", required: true },
      { name: "account", kind: "string", referencesEntity: "account", required: true },
      { name: "name", kind: "string", required: true },
      { name: "designation", kind: "enum" },
      { name: "email", kind: "string", note: "The value a target will actually match on. Carried, not keyed." },
      { name: "phone", kind: "string" },
      { name: "isPrimary", kind: "boolean" },
      { name: "emailStatus", kind: "enum", note: "Verification verdict — worth carrying, or the new system re-verifies everything." },
    ],
  },
  {
    key: "lead",
    label: "Leads",
    sourceModels: ["Lead", "LeadRequirement"],
    naturalKey: ["leadSeq"],
    keyNote:
      "LEAD-nnnnnn from leadSeq. The title is mutable free text that changes as a deal evolves, which would make any key built from it unstable — worse than non-unique, because a renamed record simply imports twice and nothing notices.",
    area: "companies",
    fields: [
      { name: "leadSeq", kind: "number", required: true },
      { name: "account", kind: "string", referencesEntity: "account", required: true },
      { name: "contact", kind: "string", referencesEntity: "contact" },
      { name: "title", kind: "string", required: true },
      { name: "status", kind: "enum", required: true },
      { name: "estimatedValue", kind: "number" },
      { name: "owner", kind: "string", referencesEntity: "user" },
      { name: "lostReason", kind: "string" },
      { name: "createdAt", kind: "date", required: true },
    ],
  },
  {
    key: "item",
    label: "Catalog items",
    sourceModels: ["Item", "Brand", "ProductFamily", "ResellerItemPrice"],
    naturalKey: ["itemSeq"],
    keyNote: "ITM-nnnnnn from the existing itemSeq. Brand and family travel as denormalised names.",
    area: "items",
    fields: [
      { name: "itemSeq", kind: "number", required: true },
      { name: "name", kind: "string", required: true },
      { name: "sku", kind: "string" },
      { name: "type", kind: "enum", required: true, note: "GOODS, SERVICE or SUBSCRIPTION — decides what a target does with it." },
      { name: "brand", kind: "string" },
      { name: "productFamily", kind: "string" },
      { name: "billingCycle", kind: "enum" },
      { name: "unit", kind: "string" },
      { name: "sellingPrice", kind: "number" },
      { name: "taxRatePercent", kind: "number" },
    ],
  },
  {
    key: "order",
    label: "Orders & subscriptions",
    sourceModels: ["CompanyProduct", "OrderExpense"],
    naturalKey: ["orderSeq"],
    keyNote: "ORD-nnnnnn from the existing orderSeq.",
    area: "orders",
    fields: [
      { name: "orderSeq", kind: "number", required: true },
      { name: "account", kind: "string", referencesEntity: "account", required: true },
      { name: "endCustomer", kind: "string", referencesEntity: "account", note: "Set on a reseller's order — who it is ultimately for." },
      { name: "item", kind: "string", referencesEntity: "item", required: true },
      { name: "location", kind: "string", referencesEntity: "account_location" },
      { name: "quantity", kind: "number", required: true },
      { name: "unitPrice", kind: "number" },
      {
        name: "fullTermUnitPrice",
        kind: "number",
        required: true,
        note: "What a full term costs, as distinct from what a mid-term addition was charged. Losing this under-bills every renewal.",
      },
      { name: "startDate", kind: "date" },
      { name: "endDate", kind: "date", note: "Present makes this a subscription; absent makes it a one-off sale." },
      {
        name: "renewedFrom",
        kind: "string",
        referencesEntity: "order",
        required: true,
        note: "The chain that makes renewal history legible. Without it every renewal looks like new business.",
      },
      {
        name: "parentOrder",
        kind: "string",
        referencesEntity: "order",
        required: true,
        note: "Set on a mid-term addition, which co-terminates with its parent. No target CRM has this shape — see PORTABILITY.md.",
      },
      { name: "orderStatus", kind: "enum", required: true },
      { name: "businessType", kind: "enum", required: true },
      { name: "poNumber", kind: "string" },
      { name: "addedBy", kind: "string", referencesEntity: "user" },
    ],
  },
  {
    key: "payment",
    label: "Payments",
    sourceModels: ["Payment", "PaymentAllocation", "CreditNoteApplication"],
    naturalKey: ["paymentSeq"],
    keyNote:
      "PAY-nnnnnn from paymentSeq. The composite alternative included a nullable reference, and a key with a null component silently drops out of every reconciliation query instead of failing loudly.",
    area: "payments",
    fields: [
      { name: "paymentSeq", kind: "number", required: true },
      { name: "account", kind: "string", referencesEntity: "account", required: true },
      { name: "amount", kind: "number", required: true },
      { name: "paidOn", kind: "date", required: true },
      { name: "method", kind: "enum" },
      { name: "reference", kind: "string" },
      { name: "allocations", kind: "json", required: true, note: "Which orders this was applied to, and how much to each. The unallocated remainder is meaningful." },
    ],
  },
  {
    key: "ticket",
    label: "Tickets",
    sourceModels: ["Ticket", "TicketComment"],
    naturalKey: ["ticketSeq"],
    keyNote: "TKT-nnnnnn from the existing ticketSeq.",
    area: "tickets",
    fields: [
      { name: "ticketSeq", kind: "number", required: true },
      { name: "account", kind: "string", referencesEntity: "account", required: true },
      { name: "title", kind: "string", required: true },
      { name: "status", kind: "enum", required: true },
      { name: "priority", kind: "enum", required: true },
      { name: "assignedTo", kind: "string", referencesEntity: "user" },
      { name: "createdBy", kind: "string", referencesEntity: "user" },
      { name: "comments", kind: "json", note: "The thread, which is most of a ticket's value." },
      { name: "createdAt", kind: "date", required: true },
    ],
  },
  {
    key: "consent",
    label: "Marketing consent",
    sourceModels: ["ContactConsent", "Suppression"],
    naturalKey: ["contact", "channel", "topic"],
    keyNote: "Contact key plus the channel and topic it applies to.",
    area: "suppression",
    fields: [
      { name: "contact", kind: "string", referencesEntity: "contact", required: true },
      { name: "channel", kind: "enum", required: true },
      { name: "topic", kind: "enum", required: true },
      { name: "status", kind: "enum", required: true },
      { name: "source", kind: "string", required: true, note: "How consent was obtained. The DPDP Act wants the artefact, not a boolean." },
      { name: "capturedAt", kind: "date", required: true },
      { name: "withdrawnAt", kind: "date", note: "A withdrawal is a timestamp, never a deletion." },
    ],
  },
  {
    key: "document",
    label: "Sales documents",
    sourceModels: ["TradeDocument", "TradeDocumentLine", "Proposal"],
    naturalKey: ["documentNumber"],
    keyNote:
      "The statutory document number. Unique by law and by numbering series, and the one identifier a tax authority recognises — so it is the key whatever a target system would prefer.",
    area: "statements",
    fields: [
      { name: "documentNumber", kind: "string", required: true },
      { name: "kind", kind: "enum", required: true, note: "Proposal, proforma, invoice or credit note." },
      { name: "account", kind: "string", referencesEntity: "account", required: true },
      { name: "status", kind: "enum", required: true },
      { name: "issueDate", kind: "date", required: true },
      { name: "lines", kind: "json", required: true, note: "Item, quantity, rate and tax per line. A document without its lines is a total with no explanation." },
      { name: "placeOfSupply", kind: "string", note: "Decides CGST+SGST versus IGST. Meaningless outside India and essential within it." },
      { name: "irn", kind: "string", note: "The e-invoice reference number where one was generated." },
      { name: "total", kind: "number", required: true },
    ],
  },
  {
    key: "interaction",
    label: "Calls & activity",
    sourceModels: ["CallLog", "Activity"],
    naturalKey: ["account", "occurredAt", "kind"],
    keyNote:
      "Account, timestamp and kind. These are append-only events with no identifier of their own, and the timestamp is precise enough to distinguish them.",
    area: "companies",
    fields: [
      { name: "account", kind: "string", referencesEntity: "account", required: true },
      { name: "contact", kind: "string", referencesEntity: "contact" },
      { name: "kind", kind: "enum", required: true },
      { name: "occurredAt", kind: "date", required: true },
      { name: "by", kind: "string", referencesEntity: "user", required: true },
      { name: "outcome", kind: "string" },
      { name: "notes", kind: "string" },
    ],
  },
  {
    key: "visit",
    label: "Field visits",
    sourceModels: ["Visit"],
    naturalKey: ["visitSeq"],
    keyNote: "VIS-nnnnnn from the existing visitSeq.",
    area: "visits",
    fields: [
      { name: "visitSeq", kind: "number", required: true },
      { name: "account", kind: "string", referencesEntity: "account", required: true },
      { name: "by", kind: "string", referencesEntity: "user", required: true },
      { name: "status", kind: "enum", required: true },
      { name: "plannedFor", kind: "date" },
      { name: "checkedInAt", kind: "date" },
      { name: "writeUp", kind: "string" },
    ],
  },
  {
    key: "task",
    label: "Tasks",
    sourceModels: ["Task"],
    naturalKey: ["account", "title", "createdAt"],
    keyNote:
      "No sequence exists on Task. The composite is stable enough for an append-only to-do list, and a collision here costs a duplicate task rather than a duplicate customer.",
    area: "companies",
    fields: [
      { name: "title", kind: "string", required: true },
      { name: "account", kind: "string", referencesEntity: "account", required: true },
      { name: "assignedTo", kind: "string", referencesEntity: "user" },
      { name: "dueDate", kind: "date" },
      { name: "done", kind: "boolean", required: true },
      { name: "createdAt", kind: "date", required: true },
    ],
  },
  {
    key: "it_asset",
    label: "IT assets",
    sourceModels: ["Asset", "Consignment"],
    naturalKey: ["serialNumber"],
    keyNote:
      "The manufacturer serial. The one identifier that survives the device changing hands, changing owner and changing system.",
    area: "assets",
    fields: [
      { name: "serialNumber", kind: "string", required: true },
      { name: "assetType", kind: "enum", required: true },
      { name: "account", kind: "string", referencesEntity: "account", note: "Null for an asset we own rather than manage for a customer." },
      { name: "custodian", kind: "string", referencesEntity: "user" },
      { name: "warrantyEnd", kind: "date" },
      { name: "amcEnd", kind: "date", note: "Cover we sold. Losing it loses the renewal." },
      { name: "status", kind: "enum", required: true },
    ],
  },
  {
    key: "employee",
    label: "Employees",
    sourceModels: ["EmployeeProfile", "LeaveBalance"],
    naturalKey: ["user"],
    keyNote:
      "Keyed through the user record, since an employee profile is an extension of an account rather than a thing in its own right.",
    area: "people",
    fields: [
      { name: "user", kind: "string", referencesEntity: "user", required: true },
      { name: "employeeCode", kind: "string" },
      { name: "joinedOn", kind: "date" },
      { name: "designation", kind: "string" },
      { name: "leaveBalances", kind: "json", note: "Accrued entitlement. A real liability, so it travels." },
      { name: "salary", kind: "number", sensitivity: "onRequest", note: "Omitted unless the export is explicitly asked for it." },
      { name: "bankAccountNumber", kind: "string", sensitivity: "onRequest" },
    ],
  },
  {
    key: "candidate",
    label: "Candidates",
    sourceModels: ["Candidate"],
    naturalKey: ["email"],
    keyNote: "The candidate's email. Unlike an employee they have no account, and the address is how every ATS identifies them.",
    area: "hiring",
    fields: [
      { name: "email", kind: "string", required: true },
      { name: "name", kind: "string", required: true },
      { name: "stage", kind: "enum", required: true },
      { name: "owner", kind: "string", referencesEntity: "user" },
      { name: "appliedFor", kind: "string" },
    ],
  },
  {
    key: "feedback",
    label: "Customer feedback",
    sourceModels: ["FeedbackRequest", "FeedbackResponse"],
    naturalKey: ["account", "requestedAt"],
    keyNote: "Account and the moment it was asked for. Requests are append-only.",
    area: "companies",
    fields: [
      { name: "account", kind: "string", referencesEntity: "account", required: true },
      { name: "contact", kind: "string", referencesEntity: "contact" },
      { name: "about", kind: "string", referencesEntity: "user", note: "Who the feedback concerns." },
      { name: "requestedAt", kind: "date", required: true },
      { name: "rating", kind: "number" },
      { name: "comment", kind: "string" },
    ],
  },
  {
    key: "campaign",
    label: "Campaigns",
    sourceModels: ["Campaign", "MarketingTemplate"],
    naturalKey: ["name"],
    keyNote:
      "The campaign name. Mutable, but campaigns are few and reviewed by a human on migration rather than matched automatically.",
    area: "suppression",
    fields: [
      { name: "name", kind: "string", required: true },
      { name: "channel", kind: "enum", required: true },
      { name: "subject", kind: "string" },
      { name: "body", kind: "string", note: "With its merge fields intact. A target will use different syntax; the placeholders still have to be findable." },
      { name: "topic", kind: "enum", required: true, note: "What somebody consented to receive. Ties the campaign to the consent record." },
      { name: "status", kind: "enum", required: true },
    ],
  },
];

const BY_KEY = new Map(CANONICAL_ENTITIES.map((e) => [e.key, e]));

export function getEntity(key: string): CanonicalEntity | undefined {
  return BY_KEY.get(key);
}

export const ENTITY_KEYS = CANONICAL_ENTITIES.map((e) => e.key);

/** Every Prisma model any canonical entity draws from — the basis of the coverage check. */
export const COVERED_MODELS = new Set(CANONICAL_ENTITIES.flatMap((e) => e.sourceModels));

/**
 * What happens to every model a canonical entity does not draw from.
 *
 * Four dispositions, because "excluded" was too blunt a word for three different things:
 *
 *   - **archive**   Immutable history. It leaves in the bundle but is not loaded into a target,
 *                   which has nowhere to put it. The retention obligation does not move with the
 *                   software, so it still has to leave.
 *   - **specification** Configuration. Exported as a description of behaviour rather than rows,
 *                   because no target can load a permission model or a numbering series.
 *   - **excluded**  Genuinely worthless elsewhere. Counters, caches, UI preferences.
 *
 * Stated rather than omitted: an omission is indistinguishable from an oversight, and the value of
 * `check:portability` is that adding a model to the schema forces this decision.
 */
export type ModelDisposition = "archive" | "specification" | "excluded";

export const MODEL_DISPOSITIONS: Record<string, { disposition: ModelDisposition; reason: string }> = {
  ActivityLog: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  AssetMovement: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  AttendanceDay: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  AttendanceRegularisation: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  EwayBill: {
    disposition: "archive",
    reason:
      "A filing made on the company’s GSTIN against a government portal, and immutable once raised. It belongs with the document it covers, which is already exported; kept in the archive bundle for the statutory retention period, because no target CRM has a place to load a bill that NIC already holds.",
  },
  Transporter: {
    disposition: "excluded",
    reason:
      "The list of couriers this business uses, with their GSTIN or TRANSIN. Reference data rather than records about a customer — the same disposition as CredentialTag, and rebuilt on the target in the few minutes it takes to type a dozen names.",
  },
  JournalCounter: {
    disposition: "excluded",
    reason:
      "A running serial, one row per financial year. It is bookkeeping about the bookkeeping — the journal entries it numbered are exported, and a target system issues its own numbers rather than continuing ours.",
  },
  Audience: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  Project: { disposition: "excluded", reason: "Delivery work, not CRM data. No target CRM has a project with milestones, billing stages and a stakeholder list to receive it, and a flattened version would be worse than an honest gap." },
  ProjectType: { disposition: "excluded", reason: "Configuration for Project — the list of work this business sells. Rebuilt on the target, not migrated." },
  ProjectTemplateMilestone: { disposition: "excluded", reason: "Configuration for ProjectType: the standard plan a kind of project starts from." },
  ProjectStakeholder: { disposition: "excluded", reason: "Meaningless without its Project, and its user half is an access grant rather than data." },
  ProjectDocument: { disposition: "excluded", reason: "Files live with their project. Same reasoning as EmployeeDocument: a migration moves records, and the files are fetched separately." },
  ProjectMilestone: { disposition: "excluded", reason: "The plan a project is measured against. Part of a Project and meaningless on its own." },
  ProjectBillingMilestone: { disposition: "excluded", reason: "Part of a Project. What was actually invoiced is already exported with the documents." },
  ProjectRisk: { disposition: "excluded", reason: "The risk and issue log for one Project, and unreadable separated from the work it describes." },
  ProjectUpdate: { disposition: "excluded", reason: "The written history of one Project. Part of it, and worthless as a standalone list of paragraphs." },
  ProjectCredential: { disposition: "excluded", reason: "Never exported, under any circumstance. An export is a file that leaves the server and loses every protection this module has — the encryption, the password prompt, the reveal log. A customer's admin passwords in a spreadsheet in somebody's downloads folder is the exact outcome the module exists to prevent." },
  CredentialReveal: { disposition: "archive", reason: "Immutable history: who opened which stored secret and when. Kept for the same reason as AuditLog, and for deciding what needs rotating after somebody leaves." },
  VaultCredential: { disposition: "excluded", reason: "Never exported, under any circumstance. An export is a file that leaves the server and loses every protection this module has — the encryption, the password prompt, the reveal log, the notification to the owner. The company's registrar and banking passwords sitting in a spreadsheet in somebody's downloads folder is the precise outcome the module exists to prevent." },
  VaultShare: { disposition: "excluded", reason: "An access grant rather than data, and meaningless away from the credential it grants access to." },
  VaultPin: {
    disposition: "excluded",
    reason:
      "Which credentials somebody keeps at the top of their own list. A preference about their screen, like TablePreference — and one person’s, so exporting it would put their shortlist in a file somebody else reads.",
  },
  VaultReveal: { disposition: "archive", reason: "Immutable history: who opened which stored secret, how they were entitled to it, and when. This is the record that answers what has to be rotated after somebody leaves." },
  CredentialTag: { disposition: "excluded", reason: "Configuration for the vault — the category and access-type lists. Rebuilt on the target rather than migrated with the data." },
  InternalFeedback: { disposition: "excluded", reason: "Never exported. An export is a file that leaves the server, and every protection here is a property of where the data sits: the missing author column, the coarsened date, the absent audit trail. A spreadsheet of anonymous grievances beside a spreadsheet of logins is a re-identification exercise waiting to happen." },
  FeedbackQuota: { disposition: "excluded", reason: "A per-person daily counter with no content. Exporting it alongside the feedback would hand somebody both halves of the ballot box, which is the one thing the design exists to prevent." },
  Survey: { disposition: "excluded", reason: "Internal forms and their questions. Configuration for a feature that does not exist in a target CRM." },
  SurveyQuestion: { disposition: "excluded", reason: "Part of a Survey, and meaningless separated from the form it belongs to." },
  SurveyTarget: { disposition: "excluded", reason: "Who a form was aimed at. An audience list rather than data about a customer." },
  SurveyParticipation: { disposition: "excluded", reason: "That somebody answered a form. Never exported beside the responses, for the same ballot-box reason as FeedbackQuota." },
  SurveyResponse: { disposition: "excluded", reason: "Answers to an internal form, anonymous by design. The anonymity is a property of the tables they sit in, and an export loses it." },
  SurveyAnswer: { disposition: "excluded", reason: "Part of a SurveyResponse, and carries the same anonymity guarantee." },
  VisitorInvite: { disposition: "excluded", reason: "A pending invitation carries a live code that lets somebody sign in at reception, so it is a credential with an expiry rather than a record. Arrived ones are already captured by the VisitorEntry they became." },
  VisitorKiosk: { disposition: "excluded", reason: "A reception tablet's configuration, and its token is a live credential that needs no login. Exporting it would put a key to the staff directory in a file that leaves the server." },
  VisitorCompany: { disposition: "excluded", reason: "The companies visitors say they are from. Deliberately not the CRM company list and not a substitute for it — half of it is names typed at a reception desk, unverified and often misspelt, which is exactly the wrong thing to migrate into a target system as customer data." },
  VisitorEntry: { disposition: "archive", reason: "The visitor book: who came to the building, when, and who they saw. Immutable history with a retention obligation of its own, and nothing a target CRM has a place for." },
  VisitorCompanion: { disposition: "archive", reason: "The people who came in alongside a visitor. Part of the same book entry and kept for the same reason." },
  Handover: { disposition: "archive", reason: "Immutable history — who moved whose work, when and why. It records decisions about this system's own users, so there is nothing in a target CRM for it to become, but it is the only account of why a book of business changed hands." },
  HandoverLine: { disposition: "archive", reason: "The per-area detail of a Handover, and meaningless without it." },
  BackupSchedule: {
    disposition: "excluded",
    reason:
      "What time this installation dumps itself, and how many dumps it keeps. Operational configuration for a machine, not data about the business — the target system backs itself up on its own terms.",
  },
  VendorStatement: {
    disposition: "archive",
    reason:
      "What a distributor billed us, month by month, and what we concluded about it. Immutable history with a commercial purpose — it is the evidence behind a credit note claim — but nothing a target CRM has a place for.",
  },
  VendorStatementLine: {
    disposition: "archive",
    reason:
      "The per-line detail of a VendorStatement, including who cleared each exception and why. Meaningless apart from the statement it belongs to, and kept for the same reason.",
  },
  VendorStatementMapping: {
    disposition: "excluded",
    reason:
      "Which column in one distributor's spreadsheet means what. Configuration for reading a file format, rebuilt on the target in the time it takes to upload one statement.",
  },
  NotificationPreference: {
    disposition: "excluded",
    reason:
      "Which of our own alerts one of our own staff has turned down. A preference about a bell in this app, like TablePreference — it describes a feature the target does not have, and the person it belongs to is an employee rather than a customer.",
  },
  PortalSettings: {
    disposition: "specification",
    reason:
      "Whether customers get a portal and what it shows them. Configuration for a feature of this installation — exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending a target could load it.",
  },
  PortalLogin: {
    disposition: "excluded",
    reason:
      "Never exported, under any circumstance. Each row holds a live bearer token that opens a customer's subscriptions, invoices and tickets to whoever has it. An export is a file that leaves the server and loses every protection this module has — the expiry, the revocation, the master switch — so a spreadsheet of these is a spreadsheet of working keys to other people's accounts.",
  },
  PortalRequest: {
    disposition: "archive",
    reason:
      "What customers asked for and what we did about it. Immutable history — the record of a conversation that started outside this system — and nothing a target CRM has a place for.",
  },
  Backup: {
    disposition: "excluded",
    reason:
      "The log of when this instance dumped itself, and to which folder on which machine. It describes the operation of this installation rather than the business — a target system has its own backups, and a filename plus a schema version means nothing over there. The dumps themselves are not in the database and never leave through an export.",
  },
  AuditLog: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  BankAccount: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  BankReconciliation: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  BankStatementLine: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  BiometricDevice: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  BiometricPunch: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  BrandingSettings: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  Celebration: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  CelebrationSeen: { disposition: "excluded", reason: "Whether somebody dismissed a birthday banner." },
  ContactVerification: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  DepreciationCharge: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  DocumentCounter: { disposition: "specification", reason: "The current value of a numbering series. The series definition exports; its counter is state." },
  DocumentNumberSetting: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  DocumentSeries: { disposition: "specification", reason: "Configuration rather than records: one GST registration's or one branch's numbering series. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  Branch: { disposition: "specification", reason: "Configuration rather than records: the company's places of business, their addresses and printed overrides. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  GstRegistration: { disposition: "specification", reason: "Configuration rather than records: the company's GSTINs and each one's intra-state e-way threshold. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded. Its IRP credentials never leave, encrypted or not — they are issued to this installation." },
  DocumentApprovalPolicy: {
    disposition: "specification",
    reason:
      "Who signs off each kind of document. Configuration rather than records, and it names roles and people by id — neither of which survives a move to a system with its own idea of both. Exported in the workflow specification so the rule can be rebuilt deliberately rather than loaded into a shape that would silently approve the wrong things.",
  },
  EmployeeDocument: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  EmployeeLetter: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  EmploymentHistory: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  Expense: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  FinalSettlement: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  FiscalYearClose: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  FixedAsset: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  IpRule: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  NetworkAddress: { disposition: "excluded", reason: "A cache of addresses and their looked-up places, rebuilt as people sign in. Nothing in it is a record of anything." },
  RoleAccessPolicy: { disposition: "specification", reason: "Who may sign in on what and from where, per role. Configuration, and keyed on roles by id — rebuilt deliberately rather than loaded." },
  PasswordResetToken: { disposition: "excluded", reason: "One-hour links to set a new password — secrets, and gone within the hour anyway." },
  SignIn: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  UserDevice: { disposition: "excluded", reason: "A device is a hash of a cookie in one of this installation's browsers. It identifies nothing anywhere else, and carrying it over would only carry over approvals nobody can re-check." },
  ActivityAward: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  MarketingAsset: { disposition: "archive", reason: "Pictures from uploaded email templates, kept so mail already sent still shows them. Exported to the archive bundle with the templates' history rather than migrated." },
  MarketingList: { disposition: "archive", reason: "Who was uploaded for a mass mail, and the consent statement they were uploaded under — evidence to keep, not configuration to load. The people themselves travel as contacts." },
  MarketingListMember: { disposition: "archive", reason: "Which contacts were on which uploaded list — part of the consent evidence, archived with the list." },
  CopilotSettings: { disposition: "excluded", reason: "Which AI provider this installation uses, with its keys encrypted under this installation's secret. Meaningless — and undecryptable — anywhere else." },
  CopilotConversation: { disposition: "excluded", reason: "People's private chats with the copilot. Not business records, and not something to carry into another system." },
  CopilotMessage: { disposition: "excluded", reason: "The turns of a private copilot chat, including what it looked up — copies of records that travel as themselves." },
  CopilotUsage: { disposition: "excluded", reason: "How many AI tokens each person used per day, for this installation's allowance. Billing state, not a record." },
  CopilotProposal: { disposition: "excluded", reason: "Tasks and notes the copilot drafted; the ones confirmed exist as ordinary tasks and notes, which travel as themselves." },
  CompanyLock: { disposition: "excluded", reason: "Whether this installation's CRM is locked for everybody but the super admin, and the notice shown. A switch, not a record." },
  MailConnection: { disposition: "excluded", reason: "A person's connection to their own Outlook: a Microsoft token encrypted under this installation's secret. Useless anywhere else — each person connects again." },
  DocumentRenderGrant: { disposition: "excluded", reason: "Two-minute passes for the server to print a document it is emailing. Spent or expired within minutes; nothing to carry." },
  DocumentEmailTemplate: { disposition: "specification", reason: "The wording sent with an emailed document, per type. Configuration rather than records." },
  HelpDesk: { disposition: "specification", reason: "The helpline number, hours and support address shown on the dashboard. Configuration rather than records — set again in a new system." },
  HelpLink: { disposition: "specification", reason: "Links to help articles and training videos listed in the rail. An index of material that lives elsewhere; configuration, not records." },
  Announcement: { disposition: "archive", reason: "What's new posts — what the company told its people, and when. History worth keeping, with no place in a target CRM." },
  MaintenanceMode: { disposition: "excluded", reason: "Whether this installation is down for maintenance right now, and until when. A switch, not a record — it means nothing anywhere else." },
  CompanyMerge: { disposition: "archive", reason: "Which duplicate companies were merged into which, with what each looked like and what moved. The record of a decision, exported to the archive bundle; the surviving company travels as itself." },
  CompanyDuplicateDismissal: { disposition: "excluded", reason: "Pairs of companies somebody said are not duplicates, so the list stops offering them. A note to this installation's duplicate finder, keyed on its own ids — meaningless anywhere else." },
  CustomerCategory: { disposition: "specification", reason: "How customers are grouped, with icons, colours and handling notes. Configuration rather than records — rebuilt deliberately in a new system rather than loaded; each company's place in it travels as a label on the company." },
  Prize: { disposition: "specification", reason: "What is up for grabs, per place and period. Configuration rather than records — rebuilt deliberately in a new system rather than loaded." },
  PrizeWinner: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  PrizeAnnouncement: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  ActivityAwardSettings: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  SalesCelebrationSettings: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  ForecastCommit: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  ForecastStageWeight: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  FormAccessGrant: {
    disposition: "specification",
    reason:
      "Who may see, change, invite to and read each form. Configuration that names people and roles by id — neither survives a move to a system with its own idea of both — so it is described in the workflow specification to be rebuilt deliberately, not loaded into a shape that would share customers' answers with the wrong people.",
  },
  FormInvite: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  FormSubmission: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  Holiday: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  InboundForm: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  IncentiveEarning: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  IncentiveScheme: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  IncentiveSlab: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  Industry: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  JournalEntry: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  JournalLine: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  Journey: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  JourneyEnrolment: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  JourneyStep: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  LeaveRequest: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  LeaveType: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  LedgerAccount: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  LedgerLock: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  MarketingMessage: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  MarketingTick: { disposition: "excluded", reason: "A scheduler run log, meaningless outside this codebase." },
  MessageEvent: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  MessagingProvider: { disposition: "specification", reason: "Mail and WhatsApp provider credentials, encrypted at rest. They have no legitimate export." },
  Notification: { disposition: "archive", reason: "Transient in-app alerts. Nothing is lost by leaving them behind." },
  OrganisationSettings: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  PageLayout: {
    disposition: "excluded",
    reason: "Where somebody dragged the cards on a page. A preference about their own screen, like TablePreference.",
  },
  PayrollRun: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  Payslip: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  PermissionChange: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  Role: {
    disposition: "specification",
    reason:
      "Configuration rather than records, and the half that gives `RolePermission` its meaning — a table of permissions keyed on roles nobody can name describes nothing. Exported in the workflow specification, where a role appears with its name, its description and every permission it grants, which is what somebody rebuilding this on another system actually needs. It is not loadable: the target has its own idea of what a role is.",
  },
  RolePermission: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  SalaryStructure: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  ScreenshotAllowance: { disposition: "excluded", reason: "A per-day counter. The evidence it counts lives in ActivityLog." },
  SecurityPolicy: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  SecuritySettings: { disposition: "specification", reason: "Sign-in policy, including the SSO client secret. The policy is specified; the secret never leaves." },
  StickyNote: {
    disposition: "archive",
    reason:
      "Somebody's own notes. They leave in the archive bundle because they are the company's content and a PRIVATE note is readable by nobody else — including by whoever runs the export — so there is no honest way to load them into a target as anybody's record. A note that belongs on an account should be written on the account.",
  },
  StockMovement: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  SystemModule: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  TablePreference: { disposition: "excluded", reason: "Which table columns somebody likes. A preference, not data." },
  Target: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  UserDailyActivity: { disposition: "excluded", reason: "Heartbeat-derived time tracking, specific to this application's own measure of activity." },
  UserPermission: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  UserPhoto: { disposition: "archive", reason: "Binary, served from its own route and referenced by the user record rather than inlined into a bundle." },
  Workbook: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  WorkbookAssignee: { disposition: "specification", reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded." },
  WorkbookRecord: { disposition: "archive", reason: "Immutable history. Exported to the archive bundle rather than migrated: no target CRM has a place for it, and the retention obligation does not move with the software." },
  LeadCaptureKey: {
    disposition: "excluded",
    reason: "API credentials for this install’s websites. Only a digest of each secret is kept, which no other system could use — a new CRM issues its own keys.",
  },
  LeadAssignmentRule: {
    disposition: "specification",
    reason: "Configuration rather than records. Exported in the workflow specification, which describes the behaviour faithfully enough to rebuild rather than pretending it can be loaded.",
  },
  CreditDecision: {
    disposition: "archive",
    reason:
      "Immutable history — who gave which customer more credit than their record supported, and why. The rating behind it is recomputed from the payments, which export as records; the decisions are the part a target could not rebuild, and the part an auditor asks for.",
  },
  // ─── Revenue & Close (the add-on) ──────────────────────────────────────────────────────────────
  RevenueSchedule: {
    disposition: "archive",
    reason:
      "Immutable history — which invoice's revenue was deferred, over which period, and who approved the plan. The journal entries it posted archive with the ledger; the schedule is what explains them to an auditor, and no target CRM has a place for it.",
  },
  RevenueScheduleLine: { disposition: "archive", reason: "Immutable history. Each month's share of a revenue schedule and the entry that recognised it — archived beside the ledger it posted into." },
  RevenueScheduleAdjustment: { disposition: "archive", reason: "Immutable history. What a credit note took off a revenue schedule — archived with the schedule it adjusted." },
  AccountingSchedule: { disposition: "archive", reason: "Immutable history. A prepaid or accrual schedule and the entries it posted — archived beside the ledger, as depreciation charges are." },
  AccountingScheduleLine: { disposition: "archive", reason: "Immutable history. One month of a prepaid or accrual schedule and the entries (and reversal) it posted." },
  CloseMonth: { disposition: "archive", reason: "Immutable history. When each month was closed or reopened and by whom — the evidence behind the period lock." },
  CloseTask: { disposition: "archive", reason: "Immutable history. The month-end checklist as it was worked: who did what, when, and what the automatic checks found." },
  CloseTaskAttachment: { disposition: "archive", reason: "Immutable history. The working papers attached to a month-end task — archived with the task." },
  FluxNote: { disposition: "archive", reason: "Immutable history. Why an account moved as it did in a month, as explained at the close." },
  CloseTaskTemplate: { disposition: "specification", reason: "Configuration rather than records. The month-end checklist's tasks are described in the workflow specification, to be rebuilt in the target." },
  RevenueCloseSettings: { disposition: "specification", reason: "Configuration rather than records: automatic posting on or off, how revenue is spread, and the thresholds for explaining a month's movements." },
  DailyJobRun: { disposition: "excluded", reason: "Which once-a-day job ran on which day, so it runs only once. Operational bookkeeping of this installation, not a record." },
  // ─── Orders: the hand-off to purchase and the distributor price ────────────────────────────────
  OrderPriceChange: {
    disposition: "archive",
    reason:
      "Immutable history — every distributor price, purchase, higher price proposed, accepted or sent back on an order, with who and why. The order's final vendor and price export with the order; this is the argument behind them, which no target CRM has a place for.",
  },
  PurchaseSaving: {
    disposition: "archive",
    reason:
      "Immutable history — what each purchaser saved (or, where an increase was accepted, gave up) against the salesperson's distributor price. A performance record rather than a trading one, kept for the reviews it was used in; a cancelled order's stays, marked cancelled.",
  },
};
