import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/company-name";
import { companyFamily, FAMILY_LABELS, phoneKey } from "@/lib/companies/duplicates";
import { formatCompanyId } from "@/lib/order-id";
import { paymentTermsLabels } from "@/lib/gst";
import { valuesOf } from "@/lib/custom-fields/server";
import { isEmptyValue, type CustomFieldValues } from "@/lib/custom-fields/rules";

/**
 * Folding a duplicate company into the one that stays.
 *
 * "Xyz Technologies Pvt Ltd" and "XYZ Companies" are one customer entered twice. Merging moves every
 * record under the duplicate — contacts, leads, orders, invoices, payments, tickets, visits, calls,
 * projects, assets, ledger lines, everything — onto the one that stays, combines the people who
 * appear in both, and removes the duplicate. A `CompanyMerge` row keeps what it was, what moved and
 * what was kept from which side, and it is what sends the duplicate's old links (its COM number, its
 * id in a bookmark or a notification) to the company it became. There is no undo.
 *
 * ## Every link, not a list of them
 *
 * The obvious way to write this is one `updateMany` per table that points at a company. There are
 * forty-seven of those today, and the forty-eighth — added next month by somebody who has never heard
 * of this file — would be missed. Most company links are `onDelete: Cascade`, so a missed one does not
 * fail: the duplicate is deleted and its rows quietly go with it.
 *
 * So the links are read from the database's own catalog — its foreign keys, and the unique indexes
 * each is in — and every one of them moves.
 * Only links that can *clash* need a rule here — a table where a company or a contact may appear at
 * most once, or once per something (one reseller profile per company, one price per item per
 * reseller, one consent per topic per person). `unsettledClashes()` lists any such link without a rule;
 * `check:company-merge` fails when it isn't empty, and a merge refuses to start. Before the duplicate
 * is deleted every link is counted again and must be zero, so a cascade can never take anything.
 *
 * One constraint Prisma can't describe lives in a migration — at most one primary address per
 * company — and is settled by hand below.
 *
 * ## People in both
 *
 * The same person under both companies — the same email, or the same phone and name — is combined
 * into one contact, the one under the company that stays. Their calls, visits, tickets and leads move
 * to it; blanks on it are filled from the other; an unsubscribe on either side stays an unsubscribe.
 * The preview lists every pair, and any pair can be left uncombined.
 *
 * ## What else changes
 *
 *   · Quotes and invoices already issued keep printing the name they were issued under — see
 *     `TradeDocument.partyName` — because a merged name on a GST invoice would not be the invoice
 *     that was sent.
 *   · Suppressions (stored by company or contact id) follow the record; if both were suppressed the
 *     longer one stands.
 *   · A "new customer" celebration follows too, so the customer isn't celebrated a second time.
 *   · The cached credit rating is cleared: the payment history just changed, and it is worked out
 *     again straight after the merge.
 *   · The workspace's own fields (src/lib/custom-fields) are combined like blanks are: the staying
 *     company's answer wins, the duplicate's fills what it left empty — and the same for a person in
 *     both. The duplicate's own answers stay in the merge record's snapshot.
 */

type Tx = Prisma.TransactionClient;
type Row = Record<string, unknown>;

// ─── The links ───────────────────────────────────────────────────────────────

export type Link = {
  model: string;
  field: string;
  /**
   * For each unique constraint this column is in, the *other* columns in it. `[[]]` means the column
   * is unique by itself; `[]` means it can never clash.
   */
  uniqueWith: string[][];
};

export const linkKey = (l: Link) => `${l.model}.${l.field}`;

type Catalog = Pick<Tx, "$queryRaw">;
type Keyed = { table: string; columns: string[] };
export type Links = { company: Link[]; contact: Link[] };

/**
 * Every column that points at a company or at a contact, read from the database's catalog: its
 * foreign keys, and for each the unique indexes it is in. Prisma's own description of the schema, as
 * the Rust-free client carries it, no longer says which column a relation uses — and the catalog is
 * the truth anyway. No column is renamed with @map, so a column's name is its field's. Partial and
 * expression indexes are left out, as Prisma leaves them out: the ones that exist are handled below
 * (check:company-merge lists them). Tables Prisma does not model are skipped, as before.
 *
 * Two small queries, one after the other — inside a transaction they share one connection.
 */
export async function links(client: Catalog = db): Promise<Links> {
  const models = Prisma.dmmf.datamodel.models;
  const tableOf = (model: string) => models.find((m) => m.name === model)?.dbName ?? model;
  const modelOf = new Map(models.map((m) => [m.dbName ?? m.name, m]));
  const [companies, contacts] = [tableOf("Company"), tableOf("Contact")];
  const foreign = await client.$queryRaw<(Keyed & { target: string })[]>`
    SELECT ch.relname::text AS "table", pa.relname::text AS target, array_agg(a.attname::text ORDER BY k.ord) AS columns
    FROM pg_constraint c
    JOIN pg_class ch ON ch.oid = c.conrelid
    JOIN pg_class pa ON pa.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = c.connamespace
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.contype = 'f' AND n.nspname = current_schema() AND pa.relname IN (${companies}, ${contacts})
    GROUP BY c.oid, ch.relname, pa.relname`;
  const unique = await client.$queryRaw<Keyed[]>`
    SELECT t.relname::text AS "table", array_agg(a.attname::text ORDER BY k.ord) AS columns
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL AND n.nspname = current_schema()
    GROUP BY i.indexrelid, t.relname`;
  const uniqueOn = new Map<string, string[][]>();
  for (const u of unique) uniqueOn.set(u.table, [...(uniqueOn.get(u.table) ?? []), u.columns]);

  const out: Links = { company: [], contact: [] };
  for (const fk of foreign) {
    const model = modelOf.get(fk.table);
    if (!model) continue;
    const target = fk.target === companies ? "company" : "contact";
    if (fk.columns.length !== 1) throw new Error(`${model.name} points at a ${target} by more than one column — merge.ts can't move it`);
    const field = fk.columns[0]!;
    const uniqueWith = (uniqueOn.get(fk.table) ?? []).filter((cols) => cols.includes(field)).map((cols) => cols.filter((c) => c !== field));
    out[target].push({ model: model.name, field, uniqueWith });
  }
  // In the schema's own order, as they always came.
  const rank = (l: Link) => {
    const m = models.findIndex((x) => x.name === l.model);
    return m * 10_000 + (models[m]?.fields.findIndex((x) => x.name === l.field) ?? 0);
  };
  out.company.sort((a, b) => rank(a) - rank(b));
  out.contact.sort((a, b) => rank(a) - rank(b));
  return out;
}

/** The columns pointing at one kind of record — for check:company-merge. */
export async function linksTo(target: "Company" | "Contact", client: Catalog = db): Promise<Link[]> {
  const all = await links(client);
  return target === "Company" ? all.company : all.contact;
}

type Delegate = {
  count(args: { where: object }): Promise<number>;
  findMany(args: { where: object; select?: object }): Promise<Row[]>;
  updateMany(args: { where: object; data: object }): Promise<{ count: number }>;
  deleteMany(args: { where: object }): Promise<{ count: number }>;
};

function delegate(client: object, model: string): Delegate {
  const d = (client as unknown as Record<string, Delegate | undefined>)[model.charAt(0).toLowerCase() + model.slice(1)];
  if (!d) throw new Error(`No Prisma delegate for ${model}`);
  return d;
}

// ─── Clashes ─────────────────────────────────────────────────────────────────

/**
 * How a clash on one link is settled. `keys` are the rows on the moving side that the staying side
 * already has — `{}` for a column unique on its own — and the rule makes room for the rest to move.
 */
type ClashRule = {
  /** How the preview and the merge record describe it: "{n} {what} both had — {outcome}". */
  what: string;
  outcome: string;
  settle: "remove-theirs" | ((tx: Tx, fromId: string, intoId: string, keys: Row[]) => Promise<void>);
};

/** Of two answers about the same topic, which one counts: an unsubscribe always, then a confirmed yes. */
const CONSENT_WEIGHT: Record<string, number> = { UNSUBSCRIBED: 2, SUBSCRIBED: 1, PENDING: 0 };

const CLASH_RULES: Record<string, ClashRule> = {
  // ─ company links
  "ResellerProfile.companyId": { what: "reseller profile", outcome: "the one staying keeps its own", settle: "remove-theirs" },
  "DomainProfile.companyId": { what: "domain profile", outcome: "the one staying keeps its own; it is looked up again anyway", settle: "remove-theirs" },
  "VendorStatementMapping.vendorId": { what: "vendor statement layout", outcome: "the one staying keeps its own", settle: "remove-theirs" },
  "ResellerItemPrice.resellerId": { what: "reseller price for the same item", outcome: "the one staying keeps its price", settle: "remove-theirs" },
  "CommissionPartyLink.companyId": { what: "link to the same commission party", outcome: "kept once", settle: "remove-theirs" },
  "CommissionPartyLink.commissionPartyId": { what: "link to the same customer", outcome: "kept once", settle: "remove-theirs" },
  "WorkbookRecord.companyId": { what: "entry on the same calling list", outcome: "the one staying keeps its entry and outcome", settle: "remove-theirs" },
  "VendorCredit.vendorId": {
    what: "vendor credit with the same number",
    outcome: "both stay — each posted to the books — the moving one's number marked “(merged)” so one recorded twice can be found and cancelled",
    settle: async (tx, fromId, intoId, keys) => {
      for (const k of keys) {
        const reference = String(k.reference);
        // Never removed: a vendor credit has its own journal entry and settlements. Renamed to the
        // first free "(merged)" number instead, free under both companies.
        let next = `${reference} (merged)`;
        for (let n = 2; await tx.vendorCredit.findFirst({ where: { vendorId: { in: [fromId, intoId] }, reference: next }, select: { id: true } }); n += 1) {
          next = `${reference} (merged ${n})`;
        }
        await tx.vendorCredit.updateMany({ where: { vendorId: fromId, reference }, data: { reference: next } });
      }
    },
  },
  // ─ contact links, for people combined into one
  "MarketingListMember.contactId": { what: "place on the same mailing list", outcome: "kept once", settle: "remove-theirs" },
  // A person's record at the company they moved to points back at this one (src/lib/contacts/moves.ts):
  // two people combined who had each moved on keep one link — the staying contact's.
  "Contact.previousContactId": {
    what: "record of the same person at a later company",
    outcome: "the one staying keeps its link; the other's later record stays, unlinked",
    settle: async (tx, fromId) => {
      await tx.contact.updateMany({ where: { previousContactId: fromId }, data: { previousContactId: null } });
    },
  },
  "ProjectStakeholder.contactId": { what: "place on the same project", outcome: "kept once, in the role the contact staying has", settle: "remove-theirs" },
  "ContactConsent.contactId": {
    what: "consent for the same topic",
    outcome: "an unsubscribe on either side stands",
    settle: async (tx, fromId, intoId, keys) => {
      for (const k of keys) {
        const where = (contactId: string) => ({ contactId_channel_topic: { contactId, channel: k.channel, topic: k.topic } }) as Prisma.ContactConsentWhereUniqueInput;
        const [theirs, ours] = await Promise.all([tx.contactConsent.findUnique({ where: where(fromId) }), tx.contactConsent.findUnique({ where: where(intoId) })]);
        if (!theirs || !ours) continue;
        // The row with the answer that counts stays, evidence and all; the other goes.
        const theirsWins = (CONSENT_WEIGHT[theirs.status] ?? 0) > (CONSENT_WEIGHT[ours.status] ?? 0);
        await tx.contactConsent.delete({ where: { id: theirsWins ? ours.id : theirs.id } });
      }
    },
  },
  "FormInvite.contactId": {
    what: "invitation to the same form",
    outcome: "the answered one is kept",
    settle: async (tx, fromId, intoId, keys) => {
      for (const k of keys) {
        const find = (contactId: string) =>
          tx.formInvite.findUnique({ where: { formId_contactId: { formId: String(k.formId), contactId } }, select: { id: true, submission: { select: { id: true } } } });
        const [theirs, ours] = await Promise.all([find(fromId), find(intoId)]);
        if (!theirs || !ours) continue;
        // An answer outlives its invitation (the submission is only detached), but the invitation
        // that was answered is the one worth keeping.
        await tx.formInvite.delete({ where: { id: theirs.submission && !ours.submission ? ours.id : theirs.id } });
      }
    },
  },
  "MarketingMessage.contactId": {
    what: "copy of the same campaign",
    outcome: "both stay in the history; one not yet sent is held back",
    settle: async (tx, fromId, _intoId, keys) => {
      const campaignIds = keys.map((k) => String(k.campaignId));
      await tx.marketingMessage.updateMany({
        where: { contactId: fromId, campaignId: { in: campaignIds }, status: "QUEUED" },
        data: { status: "SUPPRESSED", suppressedReason: "Combined with a duplicate of this contact, who is getting this campaign already" },
      });
      // The copy that went out keeps its place in the report, without a contact: two copies under
      // one person is what the unique index exists to stop. Its unsubscribe link still works — see
      // contactForToken.
      await tx.marketingMessage.updateMany({ where: { contactId: fromId, campaignId: { in: campaignIds } }, data: { contactId: null } });
    },
  },
};

/** Links that can clash and that no rule settles. Must be empty: `check:company-merge` asserts it, and a merge won't start. */
export function unsettledClashes({ company, contact }: Links): string[] {
  return [...company, ...contact].filter((l) => l.uniqueWith.length > 0 && !CLASH_RULES[linkKey(l)]).map(linkKey);
}

/** The moving side's rows that the staying side already has, per unique constraint. */
async function clashesOn(tx: object, link: Link, fromId: string, intoId: string): Promise<Row[]> {
  const found: Row[] = [];
  for (const keys of link.uniqueWith) {
    const d = delegate(tx, link.model);
    if (keys.length === 0) {
      const [theirs, ours] = await Promise.all([d.count({ where: { [link.field]: fromId } }), d.count({ where: { [link.field]: intoId } })]);
      if (theirs > 0 && ours > 0) found.push({});
      continue;
    }
    const select = Object.fromEntries(keys.map((k) => [k, true]));
    const [theirs, ours] = await Promise.all([
      d.findMany({ where: { [link.field]: fromId }, select }),
      d.findMany({ where: { [link.field]: intoId }, select }),
    ]);
    // Postgres treats NULLs in a unique index as distinct, so a row with a null key never clashes.
    const complete = (r: Row) => keys.every((k) => r[k] !== null && r[k] !== undefined);
    const keyOf = (r: Row) => JSON.stringify(keys.map((k) => r[k]));
    const taken = new Set(ours.filter(complete).map(keyOf));
    found.push(...theirs.filter((r) => complete(r) && taken.has(keyOf(r))));
  }
  return found;
}

/** Settles every clash on the links given, moving side `fromId`. Returns what was settled, for the record. */
async function settleClashes(tx: Tx, list: Link[], fromId: string, intoId: string): Promise<string[]> {
  const notes: string[] = [];
  for (const link of list) {
    if (link.uniqueWith.length === 0) continue;
    const rule = CLASH_RULES[linkKey(link)];
    if (!rule) throw new Error(`${linkKey(link)} can clash in a merge and has no rule — add one to CLASH_RULES in src/lib/companies/merge.ts`);
    const keys = await clashesOn(tx, link, fromId, intoId);
    if (keys.length === 0) continue;
    if (rule.settle === "remove-theirs") {
      const where = keys.length === 1 && Object.keys(keys[0]!).length === 0 ? { [link.field]: fromId } : { [link.field]: fromId, OR: keys };
      await delegate(tx, link.model).deleteMany({ where });
    } else {
      await rule.settle(tx, fromId, intoId, keys);
    }
    notes.push(clashNote(rule, keys.length));
  }
  return notes;
}

function clashNote(rule: ClashRule, n: number) {
  return `${n === 1 ? "A" : n} ${rule.what}${n === 1 ? "" : "s"} both had — ${rule.outcome}.`;
}

/** Moves every row on the links given from one id to another. Returns how many moved per link. */
async function repoint(tx: Tx, list: Link[], fromId: string, intoId: string): Promise<Record<string, number>> {
  const moved: Record<string, number> = {};
  for (const link of list) {
    const { count } = await delegate(tx, link.model).updateMany({ where: { [link.field]: fromId }, data: { [link.field]: intoId } });
    if (count) moved[linkKey(link)] = count;
  }
  return moved;
}

// ─── What people read ────────────────────────────────────────────────────────

const LINK_LABELS: Record<string, string> = {
  "Contact.companyId": "Contacts",
  "CompanyLocation.companyId": "Addresses",
  "Lead.companyId": "Leads",
  "CompanyProduct.companyId": "Orders and subscriptions",
  "CompanyProduct.vendorId": "Orders bought from them",
  "CompanyProduct.endCustomerId": "Orders placed on their behalf",
  "TradeDocument.companyId": "Quotes and invoices",
  "Payment.companyId": "Payments",
  "Ticket.companyId": "Tickets",
  "Task.companyId": "Tasks",
  "Visit.companyId": "Visits",
  "CallLog.companyId": "Calls",
  "Project.companyId": "Projects",
  "Asset.ownerCompanyId": "IT assets",
  "Asset.siteCompanyId": "IT assets on their site",
  "Asset.vendorCompanyId": "IT assets they supplied",
  "FixedAsset.vendorCompanyId": "Fixed assets they supplied",
  "AssetMovement.fromCompanyId": "Asset movements from them",
  "AssetMovement.toCompanyId": "Asset movements to them",
  "Consignment.toCompanyId": "Consignments",
  "JournalEntry.companyId": "Journal entries",
  "JournalLine.companyId": "Ledger lines",
  "Expense.companyId": "Expenses",
  "OrderExpense.payeeCompanyId": "Commissions paid to them",
  "FeedbackRequest.companyId": "Feedback requests",
  "JourneyEnrolment.companyId": "Marketing journeys",
  "MarketingMessage.companyId": "Marketing emails",
  "FormInvite.companyId": "Form invitations",
  "FormSubmission.companyId": "Form answers",
  "CreditDecision.companyId": "Credit decisions",
  "StickyNote.companyId": "Notes",
  "VaultCredential.companyId": "Vault credentials",
  "VisitorCompany.companyId": "Website visitor matches",
  "PortalLogin.companyId": "Portal logins",
  "PortalRequest.companyId": "Portal requests",
  "Company.managedByResellerId": "End customers",
  "CommissionPartyLink.companyId": "Commission party links",
  "CommissionPartyLink.commissionPartyId": "Linked customers",
  "CommissionPartyAccount.commissionPartyId": "Payee accounts",
  "ResellerProfile.companyId": "Reseller profile",
  "ResellerItemPrice.resellerId": "Reseller prices",
  "DomainProfile.companyId": "Domain profile",
  "VendorStatement.vendorId": "Vendor statements",
  "VendorStatementLine.matchedCompanyId": "Statement lines matched to them",
  "VendorStatementMapping.vendorId": "Vendor statement layout",
  "WorkbookRecord.companyId": "Calling-list entries",
  "ContactVerification.companyId": "Contact checks",
  "CompanyMerge.intoCompanyId": "Companies merged into it before",
};

export function linkLabel(key: string): string {
  if (LINK_LABELS[key]) return LINK_LABELS[key];
  const model = key.split(".")[0] ?? key;
  return model.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()) + " records";
}

// ─── Company details, field by field ─────────────────────────────────────────

const COMPANY_INCLUDE = {
  industry: { select: { name: true } },
  customerCategory: { select: { name: true, parent: { select: { name: true } } } },
  owner: { select: { name: true } },
  assignedTo: { select: { name: true } },
  managedByReseller: { select: { name: true } },
  locations: { select: { id: true, label: true, city: true, state: true, gstNumber: true, isPrimary: true }, orderBy: [{ isPrimary: "desc" as const }, { createdAt: "asc" as const }] },
  bankAccounts: { select: { id: true, isPrimary: true } },
} satisfies Prisma.CompanyInclude;

type Loaded = Prisma.CompanyGetPayload<{ include: typeof COMPANY_INCLUDE }>;

const humanise = (v: string) => v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, " ");
const rupees = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const STAGE_RANK: Record<string, number> = { DISQUALIFIED: 0, PROSPECT: 1, LEAD: 2, CUSTOMER: 3 };

type FieldSpec = {
  key: string;
  label: string;
  /** The columns that go together — a bank account is four of them, and taking half of one is nonsense. */
  columns: (keyof Loaded & string)[];
  show: (c: Loaded) => string | null;
  /** When the duplicate's value is the better default even though the staying one has a value. */
  preferDrop?: (keep: Loaded, drop: Loaded) => boolean;
  /**
   * Never suggest the duplicate's, even over a blank: taking it is a decision in its own right — a
   * credit limit somebody set with a reason for another record — so it is made on purpose or not at all.
   */
  keepByDefault?: true;
};

export const MERGE_FIELDS: FieldSpec[] = [
  { key: "name", label: "Name", columns: ["name"], show: (c) => c.name },
  { key: "relationshipType", label: "Kind", columns: ["relationshipType"], show: (c) => humanise(c.relationshipType) },
  {
    key: "customerCategoryId",
    label: "Customer category",
    columns: ["customerCategoryId"],
    show: (c) => (c.customerCategory ? (c.customerCategory.parent ? `${c.customerCategory.parent.name} › ${c.customerCategory.name}` : c.customerCategory.name) : null),
  },
  { key: "industryId", label: "Industry", columns: ["industryId"], show: (c) => c.industry?.name ?? null },
  { key: "companyType", label: "Company type", columns: ["companyType"], show: (c) => (c.companyType ? humanise(c.companyType) : null) },
  {
    key: "stage",
    label: "Stage",
    columns: ["stage"],
    show: (c) => humanise(c.stage),
    // A customer entered twice is a customer, not a prospect.
    preferDrop: (keep, drop) => (STAGE_RANK[drop.stage] ?? 0) > (STAGE_RANK[keep.stage] ?? 0),
  },
  { key: "source", label: "Source", columns: ["source"], show: (c) => humanise(c.source) },
  { key: "ownerUserId", label: "Account manager", columns: ["ownerUserId"], show: (c) => c.owner?.name ?? null },
  { key: "assignedToUserId", label: "Caller", columns: ["assignedToUserId", "assignedByUserId", "assignedAt"], show: (c) => c.assignedTo?.name ?? null },
  { key: "website", label: "Website", columns: ["website"], show: (c) => c.website },
  { key: "linkedinUrl", label: "LinkedIn", columns: ["linkedinUrl"], show: (c) => c.linkedinUrl },
  { key: "employeeCount", label: "Employees", columns: ["employeeCount"], show: (c) => (c.employeeCount === null ? null : String(c.employeeCount)) },
  { key: "dunsNumber", label: "DUNS number", columns: ["dunsNumber"], show: (c) => c.dunsNumber },
  { key: "paymentTerms", label: "Payment terms", columns: ["paymentTerms"], keepByDefault: true, show: (c) => paymentTermsLabels[c.paymentTerms as keyof typeof paymentTermsLabels] ?? humanise(c.paymentTerms) },
  { key: "creditLimit", label: "Credit limit", columns: ["creditLimit"], keepByDefault: true, show: (c) => (c.creditLimit === null ? null : rupees(Number(c.creditLimit))) },
  { key: "panNumber", label: "PAN", columns: ["panNumber"], show: (c) => c.panNumber },
  // No bank account here: they are a list of their own since 8 Oct 2026, and move across with the merge.
  { key: "vendorStatus", label: "Vendor status", columns: ["vendorStatus"], show: (c) => (c.vendorStatus ? humanise(c.vendorStatus) : null) },
  { key: "vendorCode", label: "Vendor code", columns: ["vendorCode"], show: (c) => c.vendorCode },
  { key: "managedByResellerId", label: "Managed by reseller", columns: ["managedByResellerId"], show: (c) => c.managedByReseller?.name ?? null },
  {
    key: "portalEnabled",
    label: "Customer portal",
    columns: ["portalEnabled"],
    show: (c) => (c.portalEnabled === null ? "As the default" : c.portalEnabled ? "On" : "Off"),
  },
];

export type FieldDiff = { key: string; label: string; keep: string | null; drop: string | null; suggested: "keep" | "drop" };

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return (a as Date | null)?.getTime?.() === (b as Date | null)?.getTime?.();
  if (a instanceof Prisma.Decimal || b instanceof Prisma.Decimal) return String(a) === String(b);
  return a === b;
}

/** The details that differ, each with the side to keep by default. The assignment timestamp alone differing is not a difference. */
export function fieldDiffs(keep: Loaded, drop: Loaded): FieldDiff[] {
  return MERGE_FIELDS.filter((f) => {
    const cols = f.key === "assignedToUserId" ? (["assignedToUserId"] as const) : f.columns;
    return cols.some((col) => !same(keep[col], drop[col]));
  }).map((f) => {
    const k = f.show(keep);
    const d = f.show(drop);
    const suggested = !f.keepByDefault && ((k === null && d !== null) || f.preferDrop?.(keep, drop)) ? "drop" : "keep";
    return { key: f.key, label: f.label, keep: k, drop: d, suggested };
  });
}

// ─── Contacts in both ────────────────────────────────────────────────────────

export type PairCandidate = { id: string; name: string; email: string | null; phone: string | null };
export type ContactPair = { keepId: string; dropId: string; reason: string };

export const pairId = (p: { keepId: string; dropId: string }) => `${p.keepId}:${p.dropId}`;

const personName = (n: string) => n.toLowerCase().replace(/[^a-z]+/g, " ").trim();

/**
 * The same person under both companies. The same address is the same person. The same phone is only
 * when the name agrees too, or one side has no address — a switchboard number is shared by the whole
 * office, and combining everybody who gave it would be a disaster.
 */
export function contactPairs(keep: PairCandidate[], drop: PairCandidate[]): ContactPair[] {
  const pairs: ContactPair[] = [];
  const used = new Set<string>();
  const email = (c: PairCandidate) => c.email?.trim().toLowerCase() || null;
  for (const d of drop) {
    const byEmail = email(d) && keep.find((k) => !used.has(k.id) && email(k) === email(d));
    if (byEmail) {
      used.add(byEmail.id);
      pairs.push({ keepId: byEmail.id, dropId: d.id, reason: `Same email ${email(d)}` });
      continue;
    }
    const phone = d.phone ? phoneKey(d.phone) : null;
    if (!phone) continue;
    const byPhone = keep.find(
      (k) =>
        !used.has(k.id) &&
        k.phone &&
        phoneKey(k.phone) === phone &&
        (personName(k.name) === personName(d.name) || !email(k) || !email(d)) &&
        // Two different addresses are two people, whatever the phone says.
        !(email(k) && email(d) && email(k) !== email(d)),
    );
    if (byPhone) {
      used.add(byPhone.id);
      pairs.push({ keepId: byPhone.id, dropId: d.id, reason: `Same phone …${phone.slice(-4)}${personName(byPhone.name) === personName(d.name) ? " and name" : ""}` });
    }
  }
  return pairs;
}

// ─── Blockers ────────────────────────────────────────────────────────────────

type BlockerSubject = { id: string; name: string; relationshipType: string; managedByResellerId: string | null };

export function mergeBlockers(keep: BlockerSubject, drop: BlockerSubject): string[] {
  const out: string[] = [];
  if (keep.id === drop.id) out.push("That's the same company twice.");
  const [fk, fd] = [companyFamily(keep.relationshipType), companyFamily(drop.relationshipType)];
  if (fk !== fd) {
    out.push(
      `${keep.name} is a ${FAMILY_LABELS[fk]} and ${drop.name} is a ${FAMILY_LABELS[fd]}. Only two of the same kind can be merged — a customer and a vendor with one name are two relationships with one business.`,
    );
  }
  if (keep.managedByResellerId === drop.id || drop.managedByResellerId === keep.id) out.push("One of these is the other's reseller.");
  return out;
}

// ─── The preview ─────────────────────────────────────────────────────────────

export type MergeSide = {
  id: string;
  ref: string;
  name: string;
  kind: string;
  place: string | null;
  gstins: string[];
  accountManager: string | null;
  ownerUserId: string | null;
  createdAt: Date;
  contacts: PairCandidate[];
  /** Quotes and invoices issued, which keep printing this name if the other one is kept. */
  issuedDocuments: number;
};

export type MergePlan = {
  keep: MergeSide;
  drop: MergeSide;
  blockers: string[];
  fields: FieldDiff[];
  /** What moves from the duplicate, by kind, largest first. */
  moves: { key: string; label: string; count: number }[];
  /** Records both have where only one can stay, and what happens. */
  clashes: string[];
  contactPairs: (ContactPair & { id: string })[];
};

async function side(c: Loaded): Promise<MergeSide> {
  const [contacts, issuedDocuments] = await Promise.all([
    db.contact.findMany({ where: { companyId: c.id }, select: { id: true, name: true, email: true, phone: true }, orderBy: { createdAt: "asc" } }),
    db.tradeDocument.count({ where: { companyId: c.id, status: { not: "DRAFT" }, partyName: null } }),
  ]);
  const primary = c.locations[0];
  return {
    id: c.id,
    ref: formatCompanyId(c.companySeq),
    name: c.name,
    kind: humanise(c.relationshipType),
    place: primary ? [primary.city, primary.state].filter(Boolean).join(", ") || null : null,
    gstins: [...new Set(c.locations.map((l) => l.gstNumber).filter((g): g is string => !!g))],
    accountManager: c.owner?.name ?? null,
    ownerUserId: c.ownerUserId,
    createdAt: c.createdAt,
    contacts,
    issuedDocuments,
  };
}

/** Everything the merge screen shows before anything moves. Null when either company isn't there. */
export async function planMerge(keepId: string, dropId: string): Promise<MergePlan | null> {
  const [keep, drop] = await Promise.all([
    db.company.findUnique({ where: { id: keepId }, include: COMPANY_INCLUDE }),
    db.company.findUnique({ where: { id: dropId }, include: COMPANY_INCLUDE }),
  ]);
  if (!keep || !drop) return null;
  const [keepSide, dropSide] = await Promise.all([side(keep), side(drop)]);
  const all = await links();
  const { company } = all;

  const moves = (
    await Promise.all(company.map(async (l) => ({ key: linkKey(l), label: linkLabel(linkKey(l)), count: await delegate(db, l.model).count({ where: { [l.field]: dropId } }) })))
  )
    .filter((m) => m.count > 0)
    .sort((a, b) => b.count - a.count);

  // Clashes are worked out read-only here, against the database as it is now.
  const clashes: string[] = [];
  if (keep.id !== drop.id) {
    for (const l of company) {
      if (l.uniqueWith.length === 0) continue;
      const rule = CLASH_RULES[linkKey(l)];
      if (!rule) continue;
      const found = await clashesOn(db, l, dropId, keepId);
      if (found.length) clashes.push(clashNote(rule, found.length));
    }
    const keepPrimary = keep.locations.some((l) => l.isPrimary);
    if (keepPrimary && drop.locations.some((l) => l.isPrimary)) clashes.push("Both have a primary address — the one staying keeps its own as primary; the other moves across as an ordinary address.");
    if (keep.bankAccounts.some((a) => a.isPrimary) && drop.bankAccounts.some((a) => a.isPrimary)) {
      clashes.push("Both have a primary bank account — the one staying keeps its own as primary; the other's move across as ordinary accounts.");
    }
  }

  return {
    keep: keepSide,
    drop: dropSide,
    blockers: [...mergeBlockers(keep, drop), ...(unsettledClashes(all).length ? ["Merging is switched off until every link that can clash has a rule — see check:company-merge."] : [])],
    fields: fieldDiffs(keep, drop),
    moves,
    clashes,
    contactPairs: keep.id === drop.id ? [] : contactPairs(keepSide.contacts, dropSide.contacts).map((p) => ({ ...p, id: pairId(p) })),
  };
}

// ─── The merge ───────────────────────────────────────────────────────────────

export type MergeInput = {
  keepId: string;
  dropId: string;
  /** Field key → which side's value to keep. Anything not named keeps the staying company's. */
  choices: Record<string, "keep" | "drop">;
  /** The contact pairs, by `pairId`, to combine. Pairs no longer found are skipped. */
  combine: string[];
  userId: string | null;
};

export type MergeOutcome = {
  mergeId: string;
  keepId: string;
  fromRef: string;
  fromName: string;
  moved: { label: string; count: number }[];
  combinedContacts: number;
  notes: string[];
};

export class MergeRefused extends Error {}

type FullContact = Prisma.ContactGetPayload<object>;

/** The workspace's own fields on the records a merge touches, by id — see `customFieldsOf`. */
type MergeFields = { companies: Map<string, CustomFieldValues>; contacts: Map<string, CustomFieldValues> };

/**
 * The workspace's own fields (src/lib/custom-fields) on both companies, on the duplicate's people and
 * on the people who may be combined — read before the transaction, by the reader that copes with a
 * workspace still waiting for the column.
 *
 * Not inside it: a workspace's pool has two connections, the transaction holds one, and a second
 * merge waiting on the same row lock holds the other — a read on `db` from in there would wait for a
 * connection that only frees once it has given up. What that costs: a field saved on either company
 * in the moment between this read and the lock is not seen by the merge.
 */
async function customFieldsOf(input: MergeInput): Promise<MergeFields> {
  const dropContacts = await db.contact.findMany({ where: { companyId: input.dropId }, select: { id: true } });
  const [companies, contacts] = await Promise.all([
    valuesOf("COMPANY", [input.keepId, input.dropId]),
    valuesOf("CONTACT", [...dropContacts.map((c) => c.id), ...input.combine.flatMap((p) => p.split(":"))]),
  ]);
  return { companies, contacts };
}

/**
 * Two records' own fields as the one that stays keeps them: its answer wherever it has one, the
 * other's wherever it has none. Null when that changes nothing — nothing is written then, so a
 * workspace still waiting for the column is never asked to store one.
 */
function mergedCustomFields(ours: CustomFieldValues = {}, theirs: CustomFieldValues = {}): Prisma.InputJsonValue | null {
  const merged: CustomFieldValues = { ...ours };
  let filled = false;
  for (const [key, value] of Object.entries(theirs)) {
    if (!isEmptyValue(merged[key]) || isEmptyValue(value)) continue;
    merged[key] = value;
    filled = true;
  }
  return filled ? (merged as Prisma.InputJsonValue) : null;
}

/**
 * One person, two records: the one under the staying company absorbs the other. Everything pointing
 * at the second — calls, visits, tickets, leads, consent, list places — moves to the first, blanks on
 * the first are filled from the second, and the second is removed.
 */
async function combineContacts(
  tx: Tx,
  contact: Link[],
  ours: FullContact,
  theirs: FullContact,
  companyHadPrimary: boolean,
  fields: MergeFields["contacts"],
): Promise<string[]> {
  const notes = await settleClashes(tx, contact, theirs.id, ours.id);
  await moveSuppression(tx, "CONTACT", theirs.id, ours.id);
  await repoint(tx, contact, theirs.id, ours.id);

  const data: Prisma.ContactUncheckedUpdateInput = {};
  if (!ours.email && theirs.email) {
    // The address and its verdict travel together — a verdict belongs to the address it was about.
    Object.assign(data, {
      email: theirs.email,
      emailStatus: theirs.emailStatus,
      emailCheckedValue: theirs.emailCheckedValue,
      emailCheckedAt: theirs.emailCheckedAt,
      emailCheckMethod: theirs.emailCheckMethod,
      emailCheckDetail: theirs.emailCheckDetail,
      emailCheckedByUserId: theirs.emailCheckedByUserId,
    });
  }
  if (!ours.phone && theirs.phone) data.phone = theirs.phone;
  if (!ours.linkedinUrl && theirs.linkedinUrl) data.linkedinUrl = theirs.linkedinUrl;
  if (ours.designation === "OTHER" && theirs.designation !== "OTHER") data.designation = theirs.designation;
  if (!companyHadPrimary && theirs.isPrimary) data.isPrimary = true;
  // The workspace's own fields, the same way: the staying contact's answers, then the other's.
  const customFields = mergedCustomFields(fields.get(ours.id), fields.get(theirs.id));
  if (customFields) data.customFields = customFields;

  // Mail already sent to the other record carries its preference link, and it has to keep working.
  const former = new Set([...ours.formerPreferenceTokens, ...theirs.formerPreferenceTokens]);
  if (theirs.preferenceToken && !ours.preferenceToken) data.preferenceToken = theirs.preferenceToken;
  else if (theirs.preferenceToken) former.add(theirs.preferenceToken);
  data.formerPreferenceTokens = [...former];

  await tx.contact.delete({ where: { id: theirs.id } });
  await tx.contact.update({ where: { id: ours.id }, data });
  return notes;
}

/** A suppression stored against the moving id follows it; if both were suppressed, the longer one stands. */
async function moveSuppression(tx: Tx, scope: "COMPANY" | "CONTACT", fromId: string, intoId: string) {
  const [theirs, ours] = await Promise.all([
    tx.suppression.findUnique({ where: { scope_value: { scope, value: fromId } } }),
    tx.suppression.findUnique({ where: { scope_value: { scope, value: intoId } } }),
  ]);
  if (!theirs) return;
  if (!ours) {
    await tx.suppression.update({ where: { id: theirs.id }, data: { value: intoId } });
    return;
  }
  if (ours.expiresAt && (!theirs.expiresAt || theirs.expiresAt > ours.expiresAt)) {
    await tx.suppression.update({ where: { id: ours.id }, data: { expiresAt: theirs.expiresAt } });
  }
  await tx.suppression.delete({ where: { id: theirs.id } });
}

/** A customer is new once: the duplicate's "new customer" celebration becomes the staying company's, if it has none. */
async function moveFirstOrderWin(tx: Tx, fromId: string, intoId: string) {
  const [from, into] = [`first-order:${fromId}`, `first-order:${intoId}`];
  const theirs = await tx.celebration.findUnique({ where: { occasionKey: from }, select: { id: true, details: true } });
  if (!theirs) return;
  if (await tx.celebration.findUnique({ where: { occasionKey: into }, select: { id: true } })) return; // left behind; the wall leaves out wins for companies that are gone
  const details = theirs.details && typeof theirs.details === "object" && !Array.isArray(theirs.details) ? theirs.details : {};
  await tx.celebration.update({ where: { id: theirs.id }, data: { occasionKey: into, details: { ...details, companyId: intoId } } });
  // Whoever has seen it has seen it — re-keyed with it, so it doesn't splash across their screen again.
  await tx.celebrationSeen.deleteMany({ where: { occasionKey: into } });
  await tx.celebrationSeen.updateMany({ where: { occasionKey: from }, data: { occasionKey: into } });
}

function snapshotOf(c: Loaded, contacts: FullContact[], fields: MergeFields) {
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
  const { industry, customerCategory, owner, assignedTo, managedByReseller, locations, bankAccounts, ...row } = c;
  return plain({
    // Its own fields too: where both companies had an answer only the staying one's is kept, and this
    // is where the duplicate's still is.
    company: { ...row, customFields: fields.companies.get(c.id) ?? {} },
    names: {
      industry: industry?.name ?? null,
      customerCategory: customerCategory?.name ?? null,
      accountManager: owner?.name ?? null,
      caller: assignedTo?.name ?? null,
      reseller: managedByReseller?.name ?? null,
    },
    locations,
    // Which of its bank accounts moved to the staying company (they are not copied here).
    bankAccountIds: bankAccounts.map((a) => a.id),
    contacts: contacts.map((x) => ({
      id: x.id,
      contactSeq: x.contactSeq,
      name: x.name,
      email: x.email,
      phone: x.phone,
      designation: x.designation,
      isPrimary: x.isPrimary,
      customFields: fields.contacts.get(x.id) ?? {},
    })),
  });
}

/**
 * Merges `dropId` into `keepId`, in one transaction. Authorisation is the caller's — this checks only
 * what makes a merge impossible, and checks it again inside the transaction with both rows locked, so
 * two people merging the same pair at once get one merge and one refusal.
 */
export async function executeMerge(input: MergeInput): Promise<MergeOutcome> {
  const all = await links();
  const unsettled = unsettledClashes(all);
  if (unsettled.length) throw new MergeRefused(`These links can clash and have no rule: ${unsettled.join(", ")}.`);
  const { company: companyLinks, contact: contactLinks } = all;
  const fields = await customFieldsOf(input);

  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE id IN (${input.keepId}, ${input.dropId}) FOR UPDATE`;
      const [keep, drop] = await Promise.all([
        tx.company.findUnique({ where: { id: input.keepId }, include: COMPANY_INCLUDE }),
        tx.company.findUnique({ where: { id: input.dropId }, include: COMPANY_INCLUDE }),
      ]);
      if (!keep || !drop) throw new MergeRefused("One of these companies isn't there any more — it may have been merged already.");
      const blockers = mergeBlockers(keep, drop);
      if (blockers.length) throw new MergeRefused(blockers[0]);

      const [keepContacts, dropContacts] = await Promise.all([
        tx.contact.findMany({ where: { companyId: keep.id }, orderBy: { createdAt: "asc" } }),
        tx.contact.findMany({ where: { companyId: drop.id }, orderBy: { createdAt: "asc" } }),
      ]);
      const snapshot = snapshotOf(drop, dropContacts, fields);
      const notes: string[] = [];

      // People in both, as the preview showed them and only those still paired the same way.
      const wanted = new Set(input.combine);
      const pairs = contactPairs(keepContacts, dropContacts).filter((p) => wanted.has(pairId(p)));
      const keepHadPrimaryContact = keepContacts.some((c) => c.isPrimary);
      for (const p of pairs) {
        const ours = keepContacts.find((c) => c.id === p.keepId)!;
        const theirs = dropContacts.find((c) => c.id === p.dropId)!;
        notes.push(...(await combineContacts(tx, contactLinks, ours, theirs, keepHadPrimaryContact, fields.contacts)));
      }
      if (keepHadPrimaryContact) await tx.contact.updateMany({ where: { companyId: drop.id, isPrimary: true }, data: { isPrimary: false } });

      // At most one primary address per company — an index Prisma can't see (migration 20260920120000).
      if (keep.locations.some((l) => l.isPrimary) && drop.locations.some((l) => l.isPrimary)) {
        await tx.companyLocation.updateMany({ where: { companyId: drop.id, isPrimary: true }, data: { isPrimary: false } });
      }
      // And one primary bank account (company_bank_accounts_one_primary, migration 20261028110000).
      if (keep.bankAccounts.some((a) => a.isPrimary) && drop.bankAccounts.some((a) => a.isPrimary)) {
        await tx.companyBankAccount.updateMany({ where: { companyId: drop.id, isPrimary: true }, data: { isPrimary: false } });
      }

      notes.push(...(await settleClashes(tx, companyLinks, drop.id, keep.id)));
      await moveSuppression(tx, "COMPANY", drop.id, keep.id);
      await moveFirstOrderWin(tx, drop.id, keep.id);

      // What an issued document says it was issued to doesn't change with a merge.
      const finalName = input.choices.name === "drop" ? drop.name : keep.name;
      for (const c of [keep, drop]) {
        if (c.name === finalName) continue;
        await tx.tradeDocument.updateMany({ where: { companyId: c.id, status: { not: "DRAFT" }, partyName: null }, data: { partyName: c.name } });
      }

      const moved = await repoint(tx, companyLinks, drop.id, keep.id);

      // Nothing may still point at the duplicate: most links cascade, and a row left behind would be
      // deleted with it rather than fail.
      for (const l of companyLinks) {
        const left = await delegate(tx, l.model).count({ where: { [l.field]: drop.id } });
        if (left) {
          throw new Error(`${left} ${linkKey(l)} still point at the duplicate after moving — nothing was merged`);
        }
      }
      await tx.company.delete({ where: { id: drop.id } });

      // The details picked from the duplicate, now that its name is free.
      const data: Record<string, unknown> = {};
      const choices: Record<string, "keep" | "drop"> = {};
      for (const f of fieldDiffs(keep, drop)) {
        const pick = input.choices[f.key] === "drop" ? "drop" : "keep";
        choices[f.key] = pick;
        if (pick === "drop") for (const col of MERGE_FIELDS.find((x) => x.key === f.key)!.columns) data[col] = drop[col];
      }
      if (typeof data.name === "string") data.normalizedName = normalizeCompanyName(data.name);
      data.tags = [...new Set([...keep.tags, ...drop.tags])];
      if (!keep.category && drop.category) data.category = drop.category;
      // The workspace's own fields: the staying company's answers, then the duplicate's.
      const customFields = mergedCustomFields(fields.companies.get(keep.id), fields.companies.get(drop.id));
      if (customFields) data.customFields = customFields;
      // Worked out again straight after — the payment history it came from just changed.
      Object.assign(data, { creditRating: null, creditScore: null, creditScoredAt: null });
      await tx.company.update({ where: { id: keep.id }, data: data as Prisma.CompanyUncheckedUpdateInput });

      const record = await tx.companyMerge.create({
        data: {
          fromCompanyId: drop.id,
          fromSeq: drop.companySeq,
          fromName: drop.name,
          intoCompanyId: keep.id,
          snapshot,
          moved: { counts: moved, combinedContacts: pairs.map((p) => ({ kept: p.keepId, removed: p.dropId, reason: p.reason })), notes },
          choices,
          mergedById: input.userId,
        },
        select: { id: true },
      });

      return {
        mergeId: record.id,
        keepId: keep.id,
        fromRef: formatCompanyId(drop.companySeq),
        fromName: drop.name,
        moved: Object.entries(moved)
          .map(([key, count]) => ({ label: linkLabel(key), count }))
          .sort((a, b) => b.count - a.count),
        combinedContacts: pairs.length,
        notes,
      };
    },
    { timeout: 120_000, maxWait: 15_000 },
  );
}

/**
 * Where a merged company's old link goes — by its COM number or its id. Null when it was never
 * merged. A chain of merges needs no walking: a later merge re-points `intoCompanyId` like any other
 * link, so this is always the company that exists.
 */
export async function mergedInto(ref: { kind: "seq"; seq: number } | { kind: "id"; id: string }) {
  return db.companyMerge.findFirst({
    where: ref.kind === "seq" ? { fromSeq: ref.seq } : { fromCompanyId: ref.id },
    select: { fromSeq: true, into: { select: { id: true, companySeq: true, ownerUserId: true, relationshipType: true } } },
  });
}

/** The line a company page shows after an old link brought somebody to it. Null unless that company really was merged into this one. */
export async function mergedNotice(companyId: string, fromRef: string | undefined) {
  const seq = fromRef?.match(/^COM-0*(\d+)$/)?.[1];
  if (!seq) return null;
  const merge = await db.companyMerge.findFirst({
    where: { fromSeq: Number(seq), intoCompanyId: companyId },
    select: { fromSeq: true, fromName: true, mergedAt: true, mergedBy: { select: { name: true } } },
  });
  return merge ? { ref: formatCompanyId(merge.fromSeq), name: merge.fromName, mergedAt: merge.mergedAt, by: merge.mergedBy?.name ?? null } : null;
}
