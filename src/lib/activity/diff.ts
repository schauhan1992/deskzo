import type { FieldChange } from "@/lib/activity/types";

/**
 * What an edit changed, field by field, for its audit entry (owner, 19 Oct 2026 — "before → after on the
 * main edits"): the company, contact and lead forms. Only the fields that did change; a field marked
 * `withhold` says that it changed, never from what to what.
 */

export type FieldSpec = {
  key: string;
  label: string;
  /** How a stored value reads — a label for an id or a code; plain text otherwise. */
  show?: (value: unknown) => string | null;
  withhold?: boolean;
};

/** A value as the feed shows it: blank as nothing, a list joined, a day as its date, yes or no. */
export function plainValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) return value.length ? value.map((v) => String(v)).join(", ") : null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function changesBetween(before: Record<string, unknown>, after: Record<string, unknown>, specs: FieldSpec[]): FieldChange[] {
  const out: FieldChange[] = [];
  for (const spec of specs) {
    if (!(spec.key in after)) continue;
    const from = plainValue(before[spec.key]);
    const to = plainValue(after[spec.key]);
    if (from === to) continue;
    out.push(
      spec.withhold
        ? { field: spec.key, label: spec.label, from: null, to: null, withheld: true }
        : { field: spec.key, label: spec.label, from: spec.show ? spec.show(before[spec.key]) : from, to: spec.show ? spec.show(after[spec.key]) : to },
    );
  }
  return out;
}
