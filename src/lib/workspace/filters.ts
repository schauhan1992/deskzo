import type { Prisma } from "@prisma/client";
import { marketableCompanyFilter } from "@/lib/reseller";

/**
 * The filter set behind a workbook.
 *
 * Stored as JSON rather than columns, because the useful filters change as the business does and a
 * migration per filter would mean nobody ever adds one. The trade-off is that a workbook saved
 * today can name a filter a later release removed — `buildWhere` ignores anything it doesn't
 * recognise rather than failing, so an old workbook degrades to a broader list instead of an error.
 *
 * Every field is optional and an absent field means "don't narrow on this". An empty array means
 * the same, so a half-built filter never silently returns nothing.
 */
export type WorkbookFilters = {
  // ── Who they are ────────────────────────────────────────────────────────────
  relationshipType?: string[];
  stage?: string[];
  industryId?: string[];
  category?: string[];
  companyType?: string[];
  source?: string[];
  tags?: string[];
  /** Matched against the company's locations, so a multi-site customer matches on any of them. */
  city?: string[];
  state?: string[];
  employeeMin?: number;
  employeeMax?: number;
  /** "yes" narrows to companies with a website, "no" to those without. */
  hasWebsite?: "yes" | "no";

  // ── Who owns them ───────────────────────────────────────────────────────────
  ownerUserId?: string[];
  assignedToUserId?: string[];
  /** Companies with nobody on them — the list a manager hands out. */
  unowned?: boolean;

  // ── What they've bought ─────────────────────────────────────────────────────
  hasOrders?: "yes" | "no";
  orderBusinessType?: string[];
  orderStatus?: string[];
  /** Against the sum of that company's issued invoices. */
  billedMin?: number;
  billedMax?: number;
  /** Only companies with an unsettled invoice. */
  hasOutstanding?: boolean;
  /** Companies that have bought a particular product, brand or family. */
  itemId?: string[];
  brandId?: string[];
  productFamilyId?: string[];
  itemType?: string[];
  /** Flips the product filters to "has never bought" — the cross-sell list. */
  productExcludes?: boolean;

  // ── Renewals ────────────────────────────────────────────────────────────────
  /** Subscriptions expiring within this many days — 30, 60, 90 are the usual windows. */
  renewalWithinDays?: number;
  renewalExpired?: boolean;

  // ── Pipeline ────────────────────────────────────────────────────────────────
  leadStatus?: string[];
  hasOpenLead?: boolean;
  /** Companies whose every lead was lost or disqualified — worth a second run at. */
  allLeadsLost?: boolean;
  neverHadLead?: boolean;

  // ── Engagement ──────────────────────────────────────────────────────────────
  /** Nobody has logged a call in this many days, counting "never called" as overdue. */
  noCallInDays?: number;
  createdFrom?: string;
  createdTo?: string;

  // ── What their domain says ──────────────────────────────────────────────────
  emailProvider?: string[];
  webPlatform?: string[];
  /** Domains with no DMARC, or DMARC set to monitor-only — the security opening. */
  spoofable?: boolean;
  notScanned?: boolean;

  // ── Reach ───────────────────────────────────────────────────────────────────
  /**
   * Lets a list include a reseller's end customers, which every list otherwise excludes.
   *
   * Off by default and deliberately awkward to turn on: these companies belong to the reseller,
   * and neither a caller nor a campaign may reach them (src/lib/reseller.ts). Set it only for a
   * report that is counting them rather than contacting them.
   */
  includeResellerManaged?: boolean;
};

const has = (value: unknown[] | undefined): value is string[] => Array.isArray(value) && value.length > 0;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function daysAhead(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

/**
 * Turns a saved filter set into a Prisma `where`.
 *
 * Every clause is additive — filters narrow, they never widen — so the result is the intersection
 * of everything chosen. That's what people expect from a list builder, and it means an empty filter
 * set returns everything rather than nothing.
 *
 * The one clause nobody asked for: a reseller's end customers are excluded unless the filter set
 * explicitly says otherwise. They belong to the reseller, and this is the seam every list in the
 * app passes through — a calling workbook and a marketing audience alike. Enforcing it anywhere
 * further out would mean enforcing it in several places, which is how it stops being enforced.
 */
export function buildWhere(filters: WorkbookFilters): Prisma.CompanyWhereInput {
  const and: Prisma.CompanyWhereInput[] = [];

  if (!filters.includeResellerManaged) and.push(marketableCompanyFilter);

  if (has(filters.relationshipType)) and.push({ relationshipType: { in: filters.relationshipType as never } });
  if (has(filters.stage)) and.push({ stage: { in: filters.stage as never } });
  if (has(filters.industryId)) and.push({ industryId: { in: filters.industryId } });
  if (has(filters.category)) and.push({ category: { in: filters.category } });
  if (has(filters.companyType)) and.push({ companyType: { in: filters.companyType as never } });
  if (has(filters.source)) and.push({ source: { in: filters.source as never } });
  // `hasSome`, not `hasEvery`: picking three tags means "any of these", which is how people read it.
  if (has(filters.tags)) and.push({ tags: { hasSome: filters.tags } });

  if (has(filters.city)) and.push({ locations: { some: { city: { in: filters.city, mode: "insensitive" } } } });
  if (has(filters.state)) and.push({ locations: { some: { state: { in: filters.state, mode: "insensitive" } } } });

  if (isNumber(filters.employeeMin)) and.push({ employeeCount: { gte: filters.employeeMin } });
  if (isNumber(filters.employeeMax)) and.push({ employeeCount: { lte: filters.employeeMax } });
  if (filters.hasWebsite === "yes") and.push({ website: { not: null } });
  if (filters.hasWebsite === "no") and.push({ website: null });

  if (has(filters.ownerUserId)) and.push({ ownerUserId: { in: filters.ownerUserId } });
  if (has(filters.assignedToUserId)) and.push({ assignedToUserId: { in: filters.assignedToUserId } });
  if (filters.unowned) and.push({ ownerUserId: null });

  if (filters.hasOrders === "yes") and.push({ products: { some: {} } });
  if (filters.hasOrders === "no") and.push({ products: { none: {} } });
  if (has(filters.orderBusinessType)) {
    and.push({ products: { some: { businessType: { in: filters.orderBusinessType as never } } } });
  }
  if (has(filters.orderStatus)) {
    and.push({ products: { some: { orderStatus: { in: filters.orderStatus as never } } } });
  }

  // Product, brand and family all narrow through the same orders relation. `productExcludes` turns
  // the question round — "customers who have never bought Autodesk" is the cross-sell list, and is
  // asked at least as often as "who has".
  const itemWhere: Prisma.ItemWhereInput = {};
  if (has(filters.brandId)) itemWhere.brandId = { in: filters.brandId };
  if (has(filters.productFamilyId)) itemWhere.productFamilyId = { in: filters.productFamilyId };
  if (has(filters.itemType)) itemWhere.type = { in: filters.itemType as never };

  const productWhere: Prisma.CompanyProductWhereInput = {};
  if (has(filters.itemId)) productWhere.itemId = { in: filters.itemId };
  if (Object.keys(itemWhere).length > 0) productWhere.item = itemWhere;

  if (Object.keys(productWhere).length > 0) {
    and.push(filters.productExcludes ? { products: { none: productWhere } } : { products: { some: productWhere } });
  }

  if (filters.hasOutstanding) {
    and.push({
      tradeDocuments: {
        some: { docType: "INVOICE", status: { in: ["ISSUED", "PARTIALLY_PAID", "ACCEPTED"] } },
      },
    });
  }

  if (isNumber(filters.renewalWithinDays)) {
    and.push({
      products: {
        some: {
          item: { type: "SUBSCRIPTION" },
          endDate: { gte: new Date(), lte: daysAhead(filters.renewalWithinDays) },
        },
      },
    });
  }
  if (filters.renewalExpired) {
    and.push({ products: { some: { item: { type: "SUBSCRIPTION" }, endDate: { lt: new Date() } } } });
  }

  if (has(filters.leadStatus)) and.push({ leads: { some: { status: { in: filters.leadStatus as never } } } });
  if (filters.hasOpenLead) {
    and.push({ leads: { some: { status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } } } });
  }
  if (filters.allLeadsLost) {
    // At least one lead, and none of them still alive or won — a dead account worth reopening.
    and.push({ leads: { some: {} } });
    and.push({ leads: { none: { status: { notIn: ["LOST", "DISQUALIFIED"] } } } });
  }
  if (filters.neverHadLead) and.push({ leads: { none: {} } });

  if (isNumber(filters.noCallInDays)) {
    // "None since the cutoff" also catches companies never called, which is the point of the filter.
    and.push({ calls: { none: { startedAt: { gte: daysAgo(filters.noCallInDays) } } } });
  }
  if (filters.createdFrom) and.push({ createdAt: { gte: new Date(filters.createdFrom) } });
  if (filters.createdTo) {
    const to = new Date(filters.createdTo);
    to.setHours(23, 59, 59, 999);
    and.push({ createdAt: { lte: to } });
  }

  if (has(filters.emailProvider)) {
    and.push({ domainProfile: { is: { emailProvider: { in: filters.emailProvider } } } });
  }
  if (has(filters.webPlatform)) and.push({ domainProfile: { is: { platform: { in: filters.webPlatform } } } });
  if (filters.spoofable) {
    and.push({
      domainProfile: { is: { OR: [{ dmarcRecord: null }, { dmarcPolicy: "none" }] } },
    });
  }
  if (filters.notScanned) and.push({ website: { not: null }, domainProfile: { is: null } });

  return and.length > 0 ? { AND: and } : {};
}

/** How many filters are actually narrowing, for the "3 filters" label on a saved workbook. */
export function countActiveFilters(filters: WorkbookFilters) {
  return Object.entries(filters).filter(([, value]) => {
    if (value === undefined || value === null || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    if (value === false) return false;
    return true;
  }).length;
}

/** Labels for the summary line on a saved workbook, so it reads without opening it. */
export const filterLabels: Record<keyof WorkbookFilters, string> = {
  relationshipType: "Relationship",
  stage: "Stage",
  industryId: "Industry",
  category: "Category",
  companyType: "Company type",
  source: "Source",
  tags: "Tags",
  city: "City",
  state: "State",
  employeeMin: "Employees from",
  employeeMax: "Employees up to",
  hasWebsite: "Website",
  ownerUserId: "Account manager",
  assignedToUserId: "Caller",
  unowned: "Unassigned",
  hasOrders: "Orders",
  orderBusinessType: "Order type",
  orderStatus: "Order status",
  billedMin: "Billed from",
  billedMax: "Billed up to",
  hasOutstanding: "Has outstanding",
  itemId: "Product",
  brandId: "Brand",
  productFamilyId: "Product family",
  itemType: "Product type",
  productExcludes: "Has never bought",
  renewalWithinDays: "Renewal due within",
  renewalExpired: "Renewal expired",
  leadStatus: "Lead status",
  hasOpenLead: "Has an open lead",
  allLeadsLost: "Every lead lost",
  neverHadLead: "Never had a lead",
  noCallInDays: "Not called in",
  createdFrom: "Added from",
  createdTo: "Added up to",
  emailProvider: "Email provider",
  webPlatform: "Website platform",
  spoofable: "Spoofable domain",
  notScanned: "Domain not looked up",
  includeResellerManaged: "Including resellers' customers",
};

/**
 * Just enough of `workbookFilterOptions` to turn a stored id back into the name somebody picked.
 *
 * Structural rather than the action's return type, because this module is imported by client
 * components and must not pull a `"use server"` module's types across with it. Every field optional
 * so a caller holding only part of the options can still describe the filters it does know.
 */
export type FilterNameLookup = {
  industries?: readonly { id: string; name: string }[];
  users?: readonly { id: string; name: string }[];
  items?: readonly { id: string; name: string }[];
  brands?: readonly { id: string; name: string }[];
  families?: readonly { id: string; name: string }[];
};

const ID_FILTERS: Partial<Record<keyof WorkbookFilters, keyof FilterNameLookup>> = {
  industryId: "industries",
  ownerUserId: "users",
  assignedToUserId: "users",
  itemId: "items",
  brandId: "brands",
  productFamilyId: "families",
};

/**
 * The active filters, in words, for anywhere that has to show what a list was narrowed by.
 *
 * Six of these keys hold an id. Printed raw they read as
 * "Account manager: 0f3a…" — which is not just ugly, it is unreadable in the one place it matters
 * most: a sheet printed and handed to somebody who did not run the report and cannot ask. Resolved
 * against the same options the builder chose from, so the chip says what the person clicked.
 *
 * A boolean's value is dropped rather than printed: `filterLabels` already reads as a statement
 * ("Has outstanding", "Never had a lead", "Unassigned"), so "Unassigned: true" says it twice and
 * "Unassigned: false" — which cannot occur, since `false` is not an active filter — would say the
 * opposite of the truth.
 */
export function describeFilters(
  filters: WorkbookFilters,
  lookup: FilterNameLookup = {},
): { key: keyof WorkbookFilters; label: string; value: string }[] {
  const name = (key: keyof WorkbookFilters, raw: string) => {
    const from = ID_FILTERS[key];
    if (!from) return raw;
    return lookup[from]?.find((o) => o.id === raw)?.name ?? raw;
  };

  return Object.entries(filters)
    .filter(([, value]) => {
      if (value === undefined || value === null || value === "") return false;
      if (Array.isArray(value)) return value.length > 0;
      return value !== false;
    })
    .map(([rawKey, value]) => {
      const key = rawKey as keyof WorkbookFilters;
      return {
        key,
        label: filterLabels[key] ?? rawKey,
        value:
          value === true
            ? ""
            : Array.isArray(value)
              ? value.map((v) => name(key, String(v))).join(", ")
              : name(key, String(value)),
      };
    });
}

/** Kept out of `buildWhere` because they're applied after the rows are loaded, not in SQL. */
export function isPostFilter(key: keyof WorkbookFilters) {
  return key === "billedMin" || key === "billedMax";
}
