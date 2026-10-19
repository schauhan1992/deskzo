import { db } from "@/lib/db";
import { paymentTermsLabels } from "@/lib/gst";
import { relationshipTypeLabels, vendorStatusLabels } from "@/lib/validation/company";
import { changesBetween, plainValue } from "@/lib/activity/diff";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import type { FieldChange } from "@/lib/activity/types";

/**
 * The main edit forms' fields, as their Activity line spells them (owner, 19 Oct 2026): a company's, a
 * contact's, a lead's. A contact's email and phone are said to have changed, never to what — some see them
 * hidden (a reseller's customer, a masked field).
 */

const label = (labels: Record<string, string>) => (v: unknown) => (v === null || v === undefined || v === "" ? null : (labels[String(v)] ?? String(v)));
/** A code as words: SALES_MANAGER → "Sales manager". */
const words = (v: unknown) => {
  const text = plainValue(v)?.replace(/_/g, " ").toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
};
/** A value as the lead page shows it — ₹24,00,000. */
const money = (v: unknown) => (v === null || v === undefined || v === "" ? null : formatCurrency(String(v)));
/** A calendar day as words — 30 Nov 2026 — the day it holds, whatever the zone. */
const day = (v: unknown) => (v instanceof Date || typeof v === "string" ? formatCalendarDay(v) : null);

async function namesOf(model: "industry" | "customerCategory", ids: unknown[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((v): v is string => typeof v === "string" && v.length > 0))];
  if (!wanted.length) return new Map();
  const rows = model === "industry" ? await db.industry.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } }) : await db.customerCategory.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function companyChanges(before: Record<string, unknown>, after: Record<string, unknown>): Promise<FieldChange[]> {
  const [industries, categories] = await Promise.all([namesOf("industry", [before.industryId, after.industryId]), namesOf("customerCategory", [before.customerCategoryId, after.customerCategoryId])]);
  const named = (names: Map<string, string>) => (v: unknown) => (typeof v === "string" && v ? (names.get(v) ?? "(removed)") : null);
  return changesBetween(before, after, [
    { key: "name", label: "Name" },
    { key: "relationshipType", label: "Relationship", show: label(relationshipTypeLabels) },
    { key: "industryId", label: "Industry", show: named(industries) },
    { key: "customerCategoryId", label: "Category", show: named(categories) },
    { key: "companyType", label: "Company type", show: words },
    { key: "website", label: "Website" },
    { key: "linkedinUrl", label: "LinkedIn" },
    { key: "employeeCount", label: "Employees" },
    { key: "paymentTerms", label: "Payment terms", show: label(paymentTermsLabels) },
    { key: "dunsNumber", label: "DUNS number" },
    { key: "tags", label: "Tags" },
    { key: "source", label: "Source", show: words },
    { key: "vendorStatus", label: "Onboarding status", show: label(vendorStatusLabels) },
  ]);
}

export function contactChanges(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  return changesBetween(before, after, [
    { key: "name", label: "Name" },
    { key: "designation", label: "Designation", show: words },
    { key: "email", label: "Email", withhold: true },
    { key: "phone", label: "Phone", withhold: true },
    { key: "linkedinUrl", label: "LinkedIn" },
    { key: "isPrimary", label: "Primary contact" },
    { key: "receivesDocuments", label: "Receives documents" },
  ]);
}

export async function leadChanges(before: Record<string, unknown>, after: Record<string, unknown>): Promise<FieldChange[]> {
  const ids = [before.contactId, after.contactId].filter((v): v is string => typeof v === "string" && v.length > 0);
  const contacts = ids.length ? new Map((await db.contact.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name])) : new Map<string, string>();
  return changesBetween(before, after, [
    { key: "title", label: "Title" },
    { key: "description", label: "Description" },
    { key: "estimatedValue", label: "Value", show: money },
    { key: "expectedCloseDate", label: "Expected close", show: day },
    { key: "contactId", label: "Contact", show: (v) => (typeof v === "string" && v ? (contacts.get(v) ?? "(removed)") : null) },
  ]);
}
