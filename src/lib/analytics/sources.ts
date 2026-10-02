import { db } from "@/lib/db";
import { accountScopeIds } from "@/lib/authz/company-scope";
import { scopeUserIds } from "@/lib/authz/scope";
import { notMigratedYet } from "@/lib/custom-fields/server";
import type { CustomFieldEntityKey } from "@/lib/custom-fields/rules";
import { buildWhere, countActiveFilters } from "@/lib/workspace/filters";
import { NONE, ROW_CAP, type FactSource, type SourceContext } from "./types";

/**
 * The fact tables, and everything each one can be sliced by.
 *
 * One entry per kind of record. A dimension listed here is a dimension the explorer offers, so this
 * file is the answer to "what can I break this down by" — there is nowhere else to look. The one
 * exception is the workspace's own fields, which no file can list because each workspace makes its
 * own: each source names the records its rows reach (`customFields`), and src/lib/analytics/custom.ts
 * adds the fields on them that the person asking may see.
 *
 * Every `load` applies the same account scoping the screens use. That is the whole security surface
 * of this module: a report is a way to read thousands of rows at once, so if scoping were wrong
 * here it would be wrong in the most consequential possible place, and it would look like a
 * feature rather than a leak.
 */

/**
 * The window is half-open: `gte: from, lt: to`.
 *
 * `ctx.to` is the midnight that *begins* the day after the one asked for — see `indianWindow` in
 * src/actions/analytics.ts. Comparing with `lte` against an inclusive `23:59:59.999` is the
 * traditional way to write this and it leaves a millisecond nothing is supposed to land in; a
 * half-open interval has no edge at all.
 */

const money = (v: unknown) => Number(v ?? 0);

/**
 * The company predicate for a source: the account scope, and the workspace filters on top.
 *
 * Both, always, and in that order. The scope decides what this person may see at all and the
 * filters narrow within it — so no combination of filters can ever widen the result, which is the
 * property that makes it safe to hand somebody forty of them.
 */
/**
 * The date window, on the column the report was actually placed on.
 *
 * Every `load` used to hard-code its own column while the "Dated on" control only steered the
 * bucketing — so choosing "Expires on" loaded the orders *punched* in the window and then grouped
 * them by expiry. A renewals report, which is the commonest question this business asks, returned
 * entirely the wrong rows and looked plausible because the columns were labelled with expiry dates.
 *
 * A nullable column excludes nulls, which is right: an order with no expiry is not "expiring in
 * October", and including it would put a row in a window it has no date for.
 */
const dateWindow = (ctx: SourceContext) => ({ [ctx.dateColumn]: { gte: ctx.from, lt: ctx.to } });

async function companyWhere(ctx: SourceContext) {
  const ids = await accountScopeIds(ctx.userId);
  const scope = ids === null ? {} : { ownerUserId: { in: ids } };
  const filters = ctx.companyFilters ? buildWhere(ctx.companyFilters) : {};
  const merged = { ...scope, ...filters };
  return Object.keys(merged).length === 0 ? {} : { company: merged };
}

/**
 * A scope note, plus what the account filters did to it.
 *
 * Every `scopeNote` below branched on the permission check alone and never consulted
 * `ctx.companyFilters` — so a report narrowed to a single industry announced full-company scope,
 * word for word. Measured as one admin over one window: 378 rows and 12.86 crore plain, 32 rows and
 * 71.9 lakh with an industry filter, under a byte-identical note. A scope note is the one line
 * somebody quotes when they forward a report, so it has to be derived from everything the query
 * narrows by rather than from the half of it that is about permissions.
 *
 * `includeResellerManaged` and `productExcludes` are deliberately not counted. Neither narrows on
 * its own: the first *widens*, by lifting the reseller exclusion `buildWhere` applies by default,
 * and the second only flips the sense of the product clause a sibling filter supplies — and is
 * already counted through that sibling. Counting them would print "narrowed" over a report nothing
 * narrowed, which is the failure this is here to fix rather than a smaller version of it.
 */
function withAccountFilters(ctx: SourceContext, note: string): string {
  /**
   * The same count the rest of the screen uses, with nothing excused.
   *
   * This subtracted `includeResellerManaged` and `productExcludes` first, on the reasoning that
   * neither narrows on its own. Both halves of that were wrong, in opposite directions:
   * `productExcludes` **inverts** the sibling product clause, so a report and its exact opposite
   * carried a byte-identical note; and `includeResellerManaged` **widens** the set, so a report that
   * reached into a reseller's end customers claimed to have been narrowed by one filter fewer.
   *
   * It also put a third number on a screen that already had two: the Filters badge and the print
   * sheet both call `countActiveFilters` unmodified, so a report could say "2 account filters" beside
   * a badge reading 3. One definition, used everywhere.
   *
   * "Applied", not "narrowed", because a count cannot tell the reader which direction a filter moved
   * the set and it should not pretend to.
   */
  const applied = ctx.companyFilters ? countActiveFilters(ctx.companyFilters) : 0;
  if (applied === 0) return note;
  return `${note} ${applied} account filter${applied === 1 ? "" : "s"} applied.`;
}

/** A company's tags, or a single "untagged" bucket. Multi-valued — see `Dimension.of`. */
const tagsOf = (tags: string[]): string | string[] => (tags.length === 0 ? NONE : tags);

type Wanted = ReadonlySet<CustomFieldEntityKey>;
const NO_FIELDS: Wanted = new Set();

/**
 * A load, carrying the workspace's own fields it was asked for (`ctx.customFields`) — or, in a
 * workspace whose records don't have the column yet, the same load without them.
 *
 * A release serves before `tenants:migrate` has reached every workspace (NOT_YET_EVERYWHERE in
 * src/lib/tenancy/clients.ts), and a query naming a column that isn't there fails outright. A report
 * that fails because one of its optional breakdowns can't be read yet is worse than one that reads
 * those breakdowns as empty, so the query is made again without them. In practice a workspace that
 * far behind has no field definitions either (`definitionsFor` reads none), so it is never asked.
 *
 * Asked for nothing, the query names none of those columns: the same SQL the load always sent.
 */
async function withOwnFields<T>(ctx: SourceContext, query: (want: Wanted) => Promise<T>): Promise<T> {
  const want = ctx.customFields ?? NO_FIELDS;
  if (want.size === 0) return query(NO_FIELDS);
  try {
    return await query(want);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return query(NO_FIELDS);
  }
}

/**
 * The record's own `customFields`, when wanted. It is left out of every query that doesn't name it
 * (NOT_YET_EVERYWHERE), so `false` here is how it is named — and `true` is what it already was.
 */
const ownFields = (want: Wanted, entity: CustomFieldEntityKey) => ({ customFields: !want.has(entity) });

// ─── Orders ─────────────────────────────────────────────────────────────────────────────────────

const orderInclude = (want: Wanted) =>
  ({
    company: {
      select: {
        name: true,
        tags: true,
        source: true,
        industry: { select: { name: true } },
        owner: { select: { name: true } },
        locations: { select: { city: true, state: true, isPrimary: true } },
        customFields: want.has("COMPANY"),
      },
    },
    item: {
      select: {
        name: true,
        sku: true,
        type: true,
        category: true,
        brand: { select: { name: true } },
        productFamily: { select: { name: true } },
        customFields: want.has("ITEM"),
      },
    },
    vendor: { select: { name: true } },
    addedBy: { select: { name: true, department: { select: { name: true } } } },
  }) as const;

type OrderRow = Awaited<ReturnType<typeof loadOrders>>[number];

async function loadOrders(ctx: SourceContext) {
  const scope = await companyWhere(ctx);
  return withOwnFields(ctx, (want) =>
    db.companyProduct.findMany({
      where: {
        ...scope,
        ...dateWindow(ctx),
      },
      include: orderInclude(want),
      omit: ownFields(want, "ORDER"),
      take: ROW_CAP,
      orderBy: { createdAt: "asc" },
    }),
  );
}

/** The primary location's city/state, falling back to the first one on file. */
const place = (row: OrderRow, which: "city" | "state") => {
  const loc = row.company.locations.find((l) => l.isPrimary) ?? row.company.locations[0];
  return loc?.[which] || NONE;
};

/** What this line sold for. `unitPrice` null means the item's list price was used. */
const orderValue = (row: OrderRow) => money(row.unitPrice ?? 0) * row.quantity;

const ordersSource: FactSource<OrderRow> = {
  key: "orders",
  companyAnchored: true,
  label: "Orders",
  description: "Everything punched — value, margin, quantity — by whoever, whatever and whenever.",
  moduleKey: "orders",
  load: loadOrders,
  scopeNote: async (ctx) =>
    withAccountFilters(
      ctx,
      (await accountScopeIds(ctx.userId)) === null
        ? "Every account in the company."
        : "Only the accounts you and your team manage.",
    ),
  dateFields: [
    { key: "createdAt", label: "Punched on", get: (r) => r.createdAt },
    { key: "startDate", label: "Starts on", get: (r) => r.startDate },
    { key: "endDate", label: "Expires on", get: (r) => r.endDate },
  ],
  measures: [
    { key: "value", label: "Order value", unit: "currency", value: orderValue },
    {
      key: "margin",
      label: "Margin",
      unit: "currency",
      // Only where a cost was actually recorded. Treating a missing cost as zero would report the
      // whole sale price as profit, which is the most flattering possible way to be wrong.
      value: (r) => (r.purchasePrice === null ? 0 : (money(r.unitPrice) - money(r.purchasePrice)) * r.quantity),
      description: "Sale less the purchase price on file. Lines with no cost recorded contribute nothing.",
    },
    { key: "quantity", label: "Quantity", unit: "number", value: (r) => r.quantity },
    { key: "count", label: "Number of orders", unit: "number", value: () => 1 },
  ],
  dimensions: [
    { key: "salesperson", label: "Salesperson", of: (r) => r.addedBy?.name ?? NONE },
    { key: "team", label: "Team / department", of: (r) => r.addedBy?.department?.name ?? NONE },
    { key: "accountManager", label: "Account manager", of: (r) => r.company.owner?.name ?? NONE },
    { key: "company", label: "Customer", of: (r) => r.company.name },
    { key: "industry", label: "Industry", of: (r) => r.company.industry?.name ?? NONE },
    { key: "tag", label: "Customer tag", of: (r) => tagsOf(r.company.tags), multi: true },
    { key: "source", label: "Lead source", of: (r) => r.company.source ?? NONE },
    { key: "city", label: "City", of: (r) => place(r, "city") },
    { key: "state", label: "State", of: (r) => place(r, "state") },
    { key: "item", label: "Product", of: (r) => r.item.name },
    { key: "sku", label: "SKU", of: (r) => r.item.sku },
    { key: "category", label: "Product category", of: (r) => r.item.category || NONE },
    { key: "brand", label: "Brand", of: (r) => r.item.brand?.name ?? NONE },
    { key: "family", label: "Product family", of: (r) => r.item.productFamily?.name ?? NONE },
    { key: "itemType", label: "Product type", of: (r) => r.item.type },
    { key: "businessType", label: "New vs renewal", of: (r) => r.businessType.replaceAll("_", " ") },
    { key: "orderStatus", label: "Order status", of: (r) => r.orderStatus.replaceAll("_", " ") },
    { key: "vendor", label: "Vendor", of: (r) => r.vendor?.name ?? NONE },
  ],
  customFields: [
    { entity: "ORDER", noun: "Order", own: true, values: (r) => r.customFields },
    { entity: "COMPANY", noun: "Customer", values: (r) => r.company.customFields },
    { entity: "ITEM", noun: "Product", values: (r) => r.item.customFields },
  ],
};

// ─── Leads ──────────────────────────────────────────────────────────────────────────────────────

type LeadRow = Awaited<ReturnType<typeof loadLeads>>[number];

async function loadLeads(ctx: SourceContext) {
  /**
   * Through the account, on `companies.viewAll` — the same rule as every other source here and the
   * same rule as the leads screen.
   *
   * This read `scopeUserIds(ctx.userId, "targets.viewAll")` and filtered on `Lead.ownerUserId`,
   * with a comment saying it matched the leads screen. Both halves were wrong and the comment was
   * the reason nobody looked:
   *
   *   · **The key.** `targets.viewAll` is a different permission, held far more widely — 31 of the
   *     98 active users in this database hold it *without* `companies.viewAll`. For every one of
   *     them `scopeUserIds` returned `null` and the spread collapsed to nothing, so the query ran
   *     with no account filter at all. A sales executive whose own leads screen showed 60 got all
   *     482 leads in the business, 422 of them on accounts she may not open.
   *
   *   · **The relation.** `leadListWhere` (src/actions/lead.ts) scopes through `company.ownerUserId`
   *     and its docblock argues explicitly against the owner branch — assignment is a field anybody
   *     with the bulk-edit bar can set, so an OR on it lets reassignment quietly widen the scope.
   *     This took the branch that file had already rejected.
   *
   * The failure was invisible in the ordinary way: `scopeNote` truthfully said "Every lead in the
   * company", and nobody queries a report for returning too much.
   */
  // `companyWhere`, the same helper every other source uses — which is the point. Leads had their
  // own hand-rolled predicate, and that is where the divergence lived.
  const scope = await companyWhere(ctx);
  return withOwnFields(ctx, (want) =>
    db.lead.findMany({
      where: {
        ...scope,
        ...dateWindow(ctx),
      },
      include: {
        company: {
          select: {
            name: true,
            tags: true,
            source: true,
            industry: { select: { name: true } },
            customFields: want.has("COMPANY"),
          },
        },
        owner: { select: { name: true, department: { select: { name: true } } } },
        sourcedBy: { select: { name: true } },
      },
      omit: ownFields(want, "LEAD"),
      take: ROW_CAP,
      orderBy: { createdAt: "asc" },
    }),
  );
}

const leadsSource: FactSource<LeadRow> = {
  key: "leads",
  companyAnchored: true,
  label: "Leads",
  description: "The pipeline — how many, worth how much, from where, and what became of them.",
  moduleKey: null,
  load: loadLeads,
  /**
   * The note said "Only leads owned by you and your team", which described the old owner-based
   * filter rather than the rule — and said it while the query was in fact returning everything.
   * A scope note is the one line somebody quotes when they forward a report, so it has to be
   * derived from the same thing the query is.
   */
  scopeNote: async (ctx) =>
    withAccountFilters(
      ctx,
      (await accountScopeIds(ctx.userId)) === null
        ? "Every lead in the company."
        : "Only leads on the accounts you and your team manage.",
    ),
  dateFields: [{ key: "createdAt", label: "Created on", get: (r) => r.createdAt }],
  measures: [
    { key: "count", label: "Number of leads", unit: "number", value: () => 1 },
    { key: "value", label: "Estimated value", unit: "currency", value: (r) => money(r.estimatedValue) },
    { key: "won", label: "Won", unit: "number", value: (r) => (r.status === "WON" ? 1 : 0) },
    {
      key: "wonValue",
      label: "Won value",
      unit: "currency",
      value: (r) => (r.status === "WON" ? money(r.estimatedValue) : 0),
    },
    { key: "lost", label: "Lost", unit: "number", value: (r) => (r.status === "LOST" ? 1 : 0) },
  ],
  dimensions: [
    { key: "source", label: "Lead source", of: (r) => r.company.source ?? NONE },
    { key: "status", label: "Status", of: (r) => r.status.replaceAll("_", " ") },
    { key: "owner", label: "Owner", of: (r) => r.owner?.name ?? NONE },
    { key: "team", label: "Team / department", of: (r) => r.owner?.department?.name ?? NONE },
    { key: "sourcedBy", label: "Sourced by", of: (r) => r.sourcedBy?.name ?? NONE },
    { key: "company", label: "Company", of: (r) => r.company.name },
    { key: "industry", label: "Industry", of: (r) => r.company.industry?.name ?? NONE },
    { key: "tag", label: "Company tag", of: (r) => tagsOf(r.company.tags), multi: true },
    { key: "lostReason", label: "Lost reason", of: (r) => r.lostReason || NONE },
  ],
  customFields: [
    { entity: "LEAD", noun: "Lead", own: true, values: (r) => r.customFields },
    { entity: "COMPANY", noun: "Company", values: (r) => r.company.customFields },
  ],
};

// ─── Tickets ────────────────────────────────────────────────────────────────────────────────────

type TicketRow = Awaited<ReturnType<typeof loadTickets>>[number];

async function loadTickets(ctx: SourceContext) {
  const scope = await companyWhere(ctx);
  return withOwnFields(ctx, (want) =>
    db.ticket.findMany({
      where: {
        ...scope,
        ...dateWindow(ctx),
      },
      include: {
        company: {
          select: { name: true, tags: true, industry: { select: { name: true } }, customFields: want.has("COMPANY") },
        },
        assignedTo: { select: { name: true, department: { select: { name: true } } } },
      },
      take: ROW_CAP,
      orderBy: { createdAt: "asc" },
    }),
  );
}

const DAY = 86_400_000;

const ticketsSource: FactSource<TicketRow> = {
  key: "tickets",
  companyAnchored: true,
  label: "Tickets",
  description: "Support load — how many raised, how many closed, and how long they took.",
  moduleKey: "helpdesk",
  load: loadTickets,
  scopeNote: async (ctx) =>
    withAccountFilters(
      ctx,
      (await accountScopeIds(ctx.userId)) === null
        ? "Every account in the company."
        : "Only tickets against accounts you and your team manage.",
    ),
  dateFields: [
    { key: "createdAt", label: "Raised on", get: (r) => r.createdAt },
    { key: "resolvedAt", label: "Resolved on", get: (r) => r.resolvedAt },
  ],
  measures: [
    { key: "count", label: "Tickets raised", unit: "number", value: () => 1 },
    { key: "resolved", label: "Tickets resolved", unit: "number", value: (r) => (r.resolvedAt ? 1 : 0) },
    { key: "open", label: "Still open", unit: "number", value: (r) => (r.resolvedAt ? 0 : 1) },
    {
      key: "resolutionDays",
      label: "Average days to resolve",
      unit: "days",
      // Averaged over resolved tickets only. Summing days across tickets is a number with no
      // meaning, and counting unresolved ones as zero would make a bad month look like a good one.
      average: true,
      value: (r) => (r.resolvedAt ? (r.resolvedAt.getTime() - r.createdAt.getTime()) / DAY : 0),
    },
  ],
  dimensions: [
    { key: "priority", label: "Priority", of: (r) => r.priority },
    { key: "status", label: "Status", of: (r) => r.status.replaceAll("_", " ") },
    { key: "assignee", label: "Assigned to", of: (r) => r.assignedTo?.name ?? NONE },
    { key: "team", label: "Team / department", of: (r) => r.assignedTo?.department?.name ?? NONE },
    { key: "company", label: "Customer", of: (r) => r.company.name },
    { key: "industry", label: "Industry", of: (r) => r.company.industry?.name ?? NONE },
    { key: "tag", label: "Customer tag", of: (r) => tagsOf(r.company.tags), multi: true },
  ],
  customFields: [{ entity: "COMPANY", noun: "Customer", values: (r) => r.company.customFields }],
};

// ─── Invoices ───────────────────────────────────────────────────────────────────────────────────

type InvoiceRow = Awaited<ReturnType<typeof loadInvoices>>[number];

async function loadInvoices(ctx: SourceContext) {
  const scope = await companyWhere(ctx);
  return withOwnFields(ctx, (want) =>
    db.tradeDocument.findMany({
      where: {
        direction: "SALES",
        docType: { in: ["INVOICE", "CREDIT_NOTE"] },
        status: { in: ["ISSUED", "PARTIALLY_PAID", "PAID"] },
        ...scope,
        ...dateWindow(ctx),
      },
      include: {
        company: {
          select: {
            name: true,
            tags: true,
            source: true,
            industry: { select: { name: true } },
            owner: { select: { name: true } },
            customFields: want.has("COMPANY"),
          },
        },
      },
      take: ROW_CAP,
      orderBy: { issueDate: "asc" },
    }),
  );
}

const invoicesSource: FactSource<InvoiceRow> = {
  key: "invoices",
  companyAnchored: true,
  label: "Invoices",
  description: "What was actually billed, net of credit notes, with the tax split out.",
  moduleKey: "sales_documents",
  load: loadInvoices,
  scopeNote: async (ctx) =>
    withAccountFilters(
      ctx,
      (await accountScopeIds(ctx.userId)) === null
        ? "Every account in the company."
        : "Only the accounts you and your team manage.",
    ),
  dateFields: [
    { key: "issueDate", label: "Issued on", get: (r) => r.issueDate },
    { key: "dueDate", label: "Due on", get: (r) => r.dueDate },
  ],
  measures: [
    {
      key: "net",
      label: "Invoiced (net of credit notes)",
      unit: "currency",
      // A credit note is a negative invoice. Adding them up is the whole point of netting.
      value: (r) => (r.docType === "CREDIT_NOTE" ? -money(r.total) : money(r.total)),
    },
    { key: "tax", label: "Tax", unit: "currency", value: (r) => money(r.cgstAmount) + money(r.sgstAmount) + money(r.igstAmount) },
    { key: "count", label: "Number of documents", unit: "number", value: () => 1 },
  ],
  dimensions: [
    { key: "company", label: "Customer", of: (r) => r.company.name },
    { key: "accountManager", label: "Account manager", of: (r) => r.company.owner?.name ?? NONE },
    { key: "industry", label: "Industry", of: (r) => r.company.industry?.name ?? NONE },
    { key: "tag", label: "Customer tag", of: (r) => tagsOf(r.company.tags), multi: true },
    { key: "source", label: "Lead source", of: (r) => r.company.source ?? NONE },
    { key: "docType", label: "Document type", of: (r) => r.docType.replaceAll("_", " ") },
    { key: "status", label: "Status", of: (r) => r.status.replaceAll("_", " ") },
    { key: "placeOfSupply", label: "Place of supply", of: (r) => r.placeOfSupplyCode || NONE },
  ],
  customFields: [{ entity: "COMPANY", noun: "Customer", values: (r) => r.company.customFields }],
};

// ─── Payments ───────────────────────────────────────────────────────────────────────────────────

type PaymentRow = Awaited<ReturnType<typeof loadPayments>>[number];

async function loadPayments(ctx: SourceContext) {
  const scope = await companyWhere(ctx);
  return withOwnFields(ctx, (want) =>
    db.payment.findMany({
      where: {
        ...scope,
        ...dateWindow(ctx),
      },
      include: {
        company: {
          select: {
            name: true,
            tags: true,
            industry: { select: { name: true } },
            owner: { select: { name: true } },
            customFields: want.has("COMPANY"),
          },
        },
        recordedBy: { select: { name: true } },
      },
      take: ROW_CAP,
      orderBy: { paidOn: "asc" },
    }),
  );
}

const paymentsSource: FactSource<PaymentRow> = {
  key: "payments",
  companyAnchored: true,
  label: "Payments",
  description: "Money in — when it landed, from whom, and how.",
  moduleKey: "payments",
  load: loadPayments,
  scopeNote: async (ctx) =>
    withAccountFilters(
      ctx,
      (await accountScopeIds(ctx.userId)) === null
        ? "Every account in the company."
        : "Only the accounts you and your team manage.",
    ),
  dateFields: [{ key: "paidOn", label: "Received on", get: (r) => r.paidOn }],
  measures: [
    { key: "amount", label: "Amount collected", unit: "currency", value: (r) => money(r.amount) },
    { key: "count", label: "Number of receipts", unit: "number", value: () => 1 },
  ],
  dimensions: [
    { key: "company", label: "Customer", of: (r) => r.company?.name ?? NONE },
    { key: "accountManager", label: "Account manager", of: (r) => r.company?.owner?.name ?? NONE },
    { key: "industry", label: "Industry", of: (r) => r.company?.industry?.name ?? NONE },
    { key: "tag", label: "Customer tag", of: (r) => tagsOf(r.company?.tags ?? []), multi: true },
    { key: "method", label: "Method", of: (r) => r.method?.replaceAll("_", " ") ?? NONE },
    { key: "recordedBy", label: "Recorded by", of: (r) => r.recordedBy?.name ?? NONE },
  ],
  // Through `?.`, as the dimensions above read the company: a payment without one reads as no value.
  customFields: [{ entity: "COMPANY", noun: "Customer", values: (r) => r.company?.customFields }],
};

// ─── Visits ─────────────────────────────────────────────────────────────────────────────────────

type VisitRow = Awaited<ReturnType<typeof loadVisits>>[number];

async function loadVisits(ctx: SourceContext) {
  // Two gates, both applied: the account has to be visible, and so does the person — a visit log is
  // a record of where somebody spent their day, which the visits screen scopes by user as well.
  const people = await scopeUserIds(ctx.userId, "visits.viewAll");
  const scope = await companyWhere(ctx);
  return withOwnFields(ctx, (want) =>
    db.visit.findMany({
      where: {
        ...scope,
        ...(people === null ? {} : { userId: { in: people } }),
        ...dateWindow(ctx),
      },
      include: {
        company: {
          select: { name: true, tags: true, industry: { select: { name: true } }, customFields: want.has("COMPANY") },
        },
        user: { select: { name: true, department: { select: { name: true } } } },
      },
      take: ROW_CAP,
      orderBy: { scheduledFor: "asc" },
    }),
  );
}

const visitsSource: FactSource<VisitRow> = {
  key: "visits",
  companyAnchored: true,
  label: "Field visits",
  description: "Who went where, what for, and whether it happened.",
  moduleKey: "visits",
  load: loadVisits,
  /**
   * Both gates, because `loadVisits` applies both.
   *
   * This branched on `visits.viewAll` alone, so somebody behind the account gate as well was told
   * "Only visits by you and your team" over a set the account gate had narrowed further. Twenty-six
   * active users are behind both gates today; for one of them the note claimed a team's three visits
   * over a report that returned none of them, because not one of those visits was against an account
   * he can see. The note has to name the same gates the query applies or it is a guess about it.
   */
  scopeNote: async (ctx) => {
    const [people, accounts] = await Promise.all([
      scopeUserIds(ctx.userId, "visits.viewAll"),
      accountScopeIds(ctx.userId),
    ]);
    return withAccountFilters(
      ctx,
      people === null
        ? // No person gate; the account gate is named whether or not it is narrowing, which is what
          // this branch already said and is still true.
          "Every visit against accounts you can see."
        : accounts === null
          ? "Only visits by you and your team."
          : "Only visits by you and your team, against accounts you can see.",
    );
  },
  dateFields: [
    { key: "scheduledFor", label: "Scheduled for", get: (r) => r.scheduledFor },
    { key: "checkInAt", label: "Checked in", get: (r) => r.checkInAt },
  ],
  measures: [
    { key: "count", label: "Visits", unit: "number", value: () => 1 },
    { key: "completed", label: "Completed", unit: "number", value: (r) => (r.status === "COMPLETED" ? 1 : 0) },
    { key: "distance", label: "Distance (km)", unit: "number", value: (r) => money(r.distanceKm) },
  ],
  dimensions: [
    { key: "person", label: "Person", of: (r) => r.user?.name ?? NONE },
    { key: "team", label: "Team / department", of: (r) => r.user?.department?.name ?? NONE },
    { key: "purpose", label: "Purpose", of: (r) => r.purpose.replaceAll("_", " ") },
    { key: "status", label: "Status", of: (r) => r.status.replaceAll("_", " ") },
    { key: "company", label: "Customer", of: (r) => r.company.name },
    { key: "industry", label: "Industry", of: (r) => r.company.industry?.name ?? NONE },
    { key: "tag", label: "Customer tag", of: (r) => tagsOf(r.company.tags), multi: true },
  ],
  customFields: [{ entity: "COMPANY", noun: "Customer", values: (r) => r.company.customFields }],
};

// ─── The registry ───────────────────────────────────────────────────────────────────────────────

// The `never` in FactSource<never> makes the array assignable while each entry stays fully typed
// against its own row — the alternative is `any` on every `of` and `value`, which would defeat the
// point of declaring them.
export const FACT_SOURCES = [
  ordersSource,
  leadsSource,
  invoicesSource,
  paymentsSource,
  ticketsSource,
  visitsSource,
] as unknown as FactSource<never>[];

export function getSource(key: string): FactSource<never> | undefined {
  return FACT_SOURCES.find((s) => s.key === key);
}
