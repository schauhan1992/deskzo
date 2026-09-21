import type { Prisma, MarketingTopic, MessageChannel } from "@prisma/client";
import { buildWhere, type WorkbookFilters } from "@/lib/workspace/filters";

/**
 * Who a campaign goes to.
 *
 * Two halves, because a marketing audience asks two different questions. *Which companies* is the
 * same question the calling workspace asks, so the company half is a `WorkbookFilters` and runs
 * through the very same `buildWhere` — one DSL, one place it can be wrong, and the reseller
 * exclusion it now applies is inherited for free.
 *
 * *Which people at those companies* is new. A renewal notice goes to whoever signs off the spend,
 * not to all eleven contacts on the account — and mailing all eleven is how a company becomes the
 * one everybody filters.
 */

export type ContactFilters = {
  /** ContactDesignation values. Empty means everybody. */
  designation?: string[];
  /** Only the contact marked primary — the default for anything commercial. */
  primaryOnly?: boolean;
  /**
   * Only addresses with a current verdict of VALID. Protects the sending domain, at the cost of
   * missing people nobody has got round to checking.
   */
  verifiedOnly?: boolean;
  /** Cap on how many contacts at one company may receive the same campaign. */
  maxPerCompany?: number;
};

export const DEFAULT_CONTACT_FILTERS: ContactFilters = {
  designation: [],
  primaryOnly: false,
  verifiedOnly: true,
  maxPerCompany: 2,
};

/**
 * The company half.
 *
 * Nothing added on top of `buildWhere` — the reseller exclusion lives in there now, so an audience
 * and a calling list cannot disagree about who may be reached.
 */
export function audienceCompanyWhere(filters: WorkbookFilters): Prisma.CompanyWhereInput {
  return buildWhere(filters);
}

/**
 * The people half.
 *
 * `emailCheckedValue: { equals: db.contact.fields.email }` is the Prisma field-reference trick from
 * src/actions/email-verification.ts:203 — it compares two columns in SQL, so "the verdict belongs to
 * the address it is currently on" is decided in the query rather than by loading every contact.
 */
export function contactWhere(
  filters: ContactFilters,
  channel: MessageChannel,
  emailField: unknown,
): Prisma.ContactWhereInput {
  const and: Prisma.ContactWhereInput[] = [];

  if (channel === "EMAIL") and.push({ email: { not: null } });
  if (channel === "WHATSAPP") and.push({ phone: { not: null } });

  if (filters.designation && filters.designation.length > 0) {
    and.push({ designation: { in: filters.designation as never } });
  }
  if (filters.primaryOnly) and.push({ isPrimary: true });

  if (filters.verifiedOnly && channel === "EMAIL") {
    and.push({
      emailStatus: "VALID",
      emailCheckedValue: { equals: emailField as never },
    });
  }

  return and.length > 0 ? { AND: and } : {};
}

/**
 * Trims each company down to the cap, keeping the primary contact first.
 *
 * Applied after the rows are loaded rather than in SQL, for the same reason `billedMin` is
 * (`isPostFilter`, src/lib/workspace/filters.ts:263): "the first two per company" is not a `where`.
 */
export function capPerCompany<T extends { companyId: string; isPrimary: boolean }>(
  contacts: T[],
  maxPerCompany: number | undefined,
): T[] {
  const cap = maxPerCompany ?? DEFAULT_CONTACT_FILTERS.maxPerCompany ?? 0;
  if (cap <= 0) return contacts;

  const taken = new Map<string, number>();
  // Primary first, so a cap of one always keeps the person who signs things.
  const ordered = [...contacts].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  const kept: T[] = [];
  for (const contact of ordered) {
    const soFar = taken.get(contact.companyId) ?? 0;
    if (soFar >= cap) continue;
    taken.set(contact.companyId, soFar + 1);
    kept.push(contact);
  }
  return kept;
}

/** Reads whatever is in the `contactFilters` JSON column, falling back rather than throwing. */
export function parseContactFilters(value: unknown): ContactFilters {
  if (!value || typeof value !== "object") return { ...DEFAULT_CONTACT_FILTERS };
  const raw = value as Record<string, unknown>;
  return {
    designation: Array.isArray(raw.designation) ? (raw.designation as string[]) : [],
    primaryOnly: raw.primaryOnly === true,
    verifiedOnly: raw.verifiedOnly !== false,
    maxPerCompany: typeof raw.maxPerCompany === "number" ? raw.maxPerCompany : DEFAULT_CONTACT_FILTERS.maxPerCompany,
  };
}

/** Same tolerance for the company half — an old saved filter degrades to a broader list. */
export function parseCompanyFilters(value: unknown): WorkbookFilters {
  return value && typeof value === "object" ? (value as WorkbookFilters) : {};
}

/** The summary line on an audience card, so it reads without opening it. */
export function describeContactFilters(filters: ContactFilters, topic?: MarketingTopic): string {
  const bits: string[] = [];
  if (filters.primaryOnly) bits.push("primary contact only");
  else if (filters.designation && filters.designation.length > 0) {
    bits.push(filters.designation.map((d) => d.toLowerCase().replaceAll("_", " ")).join(", "));
  } else bits.push("any contact");
  if (filters.verifiedOnly) bits.push("verified addresses");
  if (filters.maxPerCompany && filters.maxPerCompany > 0) {
    bits.push(`max ${filters.maxPerCompany} per company`);
  }
  if (topic) bits.push(`opted in to ${topic.toLowerCase().replaceAll("_", " ")}`);
  return bits.join(" · ");
}
