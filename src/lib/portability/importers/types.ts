import type { CustomFieldEntityKey } from "@/lib/custom-fields/rules";
import type { CustomSheet } from "@/lib/custom-fields/sheets";

/**
 * The contract every importer satisfies, and the helpers that keep them consistent.
 *
 * ## One resolver, two callers
 *
 * An importer exposes `plan` and `apply`, but it must not implement them independently. Both have to
 * run the row through the same reading of it — conventionally a private `resolve()` that returns
 * either an error or the values to be written. Written the other way, the two drift, and the drift
 * is invisible: the preview says a field will be set, the writer quietly ignores it, and because the
 * value never lands the next run of the same file reports the same change again forever.
 *
 * `check:import` catches exactly this by importing a file twice and requiring the second run to be a
 * no-op. If you are adding an importer and that check fails, this is why.
 *
 * ## Blank means "leave alone", never "clear"
 *
 * Somebody who deletes a column from an exported file is narrowing what they are editing, not asking
 * to wipe those fields. Every importer treats an empty cell as absent. Clearing a value is done on
 * the record's own screen, where it is one deliberate act rather than a side effect of a spreadsheet.
 */

export type RowAction = "create" | "update" | "skip" | "error";

export type FieldChange = { field: string; from: string; to: string };

export type PlannedRow = {
  /** 1-based, counting the header, so it matches what the spreadsheet shows. */
  line: number;
  action: RowAction;
  key: string;
  label: string;
  /** For an update: which fields change, old → new. The reason a dry run is worth reading. */
  changes: FieldChange[];
  error?: string;
  /**
   * Something in the row that is left as it is, and why — neither a change nor a reason to refuse the
   * row (cells naming details hidden from this person). The preview gathers these by wording, with the
   * rows each applies to, so nothing in the file is dropped without a word.
   */
  notice?: string;
};

/**
 * Who is importing, into which area, and what earlier rows in the same file will have created.
 *
 * `pendingKeys` exists because some records point at others of their own kind. A chart of accounts
 * is the clear case: every exported chart lists a parent before its children, and importing it into
 * an empty system has to work in one pass. Judging each row purely against what is already stored
 * would refuse every child in the file and tell somebody to "import the parent first" — while they
 * are looking at the parent, two rows above.
 *
 * So a row may reference a key an earlier row is going to create. `plan` fills this in as it goes,
 * and `apply` writes rows in order, so by the time the child is written the parent exists. Only
 * *earlier* rows count: a forward reference would still be refused, which is right, because nothing
 * guarantees the later row is valid.
 */
export type ImportContext = {
  actorUserId: string;
  area: string;
  /**
   * The workspace's own fields this person may import, for an importer with a `customEntity` —
   * src/lib/custom-fields/sheets.ts. Null when there are none.
   */
  custom?: CustomSheet | null;
  /** Natural keys that rows before this one in the file will create. */
  pendingKeys: Set<string>;
};

/** Either a reason the row cannot be used, or the values it resolves to. */
export type Resolved<T> = { error: string } | { value: T };

export type Importer = {
  /** Columns the template offers, and what the unknown-column warning is checked against. */
  templateColumns: string[];
  /**
   * The record type whose custom fields (src/lib/custom-fields) this import also carries — their
   * columns join the template, and `ctx.custom` reads them.
   */
  customEntity?: CustomFieldEntityKey;
  /**
   * What this row would do. **Must not write.** A preview somebody abandons has to leave the
   * database exactly as it found it, including lookup tables like industries and brands.
   */
  plan(row: Record<string, string>, line: number, ctx: ImportContext): Promise<PlannedRow>;
  /** Carries out one row, re-reading it through the same resolver `plan` used. */
  apply(row: Record<string, string>, ctx: ImportContext): Promise<void>;
};

// ─── Reading cells ──────────────────────────────────────────────────────────────────────────────

export const trim = (v: unknown) => String(v ?? "").trim();

/** Only report a change when something actually differs, or every row looks like an update. */
export function diff(field: string, from: unknown, to: unknown): FieldChange | null {
  const a = trim(from);
  const b = trim(to);
  return a === b ? null : { field, from: a || "(empty)", to: b || "(empty)" };
}

/**
 * Reads a spreadsheet cell into an enum value, or explains why it cannot.
 *
 * Case and separators are forgiving — "Purchase Manager", "purchase-manager" and "PURCHASE_MANAGER"
 * are the same thing — because the file has usually been round-tripped through Excel by somebody who
 * typed what the word looks like. What is *not* forgiving is an unrecognised value: it becomes an
 * error row naming the accepted ones, rather than being dropped. Silently ignoring "Custommer"
 * leaves the record at its default and nothing says so.
 */
export function parseEnum<T extends string>(
  field: string,
  raw: string,
  allowed: Record<string, T>,
): { value?: T; error?: string } {
  if (!raw) return {};
  const key = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  const hit = allowed[key];
  if (!hit) return { error: `${field} "${raw}" isn't one of: ${Object.keys(allowed).join(", ")}.` };
  return { value: hit };
}

/** A number cell, tolerant of the commas, currency symbols and spaces Excel leaves behind. */
export function parseNumber(field: string, raw: string): { value?: number; error?: string } {
  if (!raw) return {};
  const cleaned = raw.replace(/[₹$,\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { error: `${field} "${raw}" isn't a number.` };
  return { value: n };
}

/**
 * A date cell.
 *
 * Bare `new Date(str)` reads "01/02/2026" as January 2nd, which in India is the 1st of February.
 * Getting a warranty end date wrong by eleven months is the kind of error nobody finds until the
 * renewal is missed, so day-first is explicit here and an ambiguous value is refused rather than
 * guessed.
 */
export function parseDate(field: string, raw: string): { value?: Date; error?: string } {
  if (!raw) return {};

  // ISO, which is what our own export writes.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(d.getTime()) ? { error: `${field} "${raw}" isn't a date.` } : { value: d };
  }

  // Day-first, which is what somebody in India types.
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    if (month > 12) return { error: `${field} "${raw}" has no such month. Use DD/MM/YYYY or YYYY-MM-DD.` };
    const d = new Date(Date.UTC(dmy[3] ? Number(dmy[3]) : 0, month - 1, day));
    return Number.isNaN(d.getTime()) ? { error: `${field} "${raw}" isn't a date.` } : { value: d };
  }

  // Anything else — "15 Jan 2024", a locale string Excel produced. Parsed at local midnight, which
  // in IST is 18:30 the previous day in UTC, so the calendar date is rebuilt in UTC afterwards.
  // Getting a warranty date wrong by one day is not obviously wrong, which is what makes it bite.
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { error: `${field} "${raw}" isn't a date. Use DD/MM/YYYY or YYYY-MM-DD.` };
  return { value: new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) };
}

/**
 * A date compared as a calendar day.
 *
 * A stored timestamp and the same date read out of a spreadsheet are rarely the same instant — the
 * cell carries no time, and CSV carries no type at all. Comparing them as instants reports a change
 * on every run and the file never converges, which is the failure `check:import` exists to catch.
 */
export function diffDate(field: string, from: Date | null | undefined, to: Date | null | undefined): FieldChange | null {
  const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
  const a = day(from);
  const b = day(to);
  return a === b ? null : { field, from: a || "(empty)", to: b || "(empty)" };
}

/** A yes/no cell. Excel exports booleans as TRUE/FALSE; people type Yes, Y and 1. */
export function parseBoolean(field: string, raw: string): { value?: boolean; error?: string } {
  if (!raw) return {};
  const v = raw.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(v)) return { value: true };
  if (["false", "no", "n", "0"].includes(v)) return { value: false };
  return { error: `${field} "${raw}" isn't yes or no.` };
}

/** Pulls the number out of a key like ORD-000123, so an exported file round-trips. */
export function seqFromKey(prefix: string, raw: string): number | null {
  const m = new RegExp(`^${prefix}-(\\d+)$`, "i").exec(trim(raw));
  return m ? Number(m[1]) : null;
}

/** Formats a sequence back into the key an export writes. */
export function keyOf(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}

// ─── Building rows ──────────────────────────────────────────────────────────────────────────────

export function errorRow(line: number, label: string, error: string): PlannedRow {
  return { line, action: "error", key: "", label, changes: [], error };
}

/** A create, described by the fields that carry a value. Undefined ones are simply not mentioned. */
export function createRow(
  line: number,
  key: string,
  label: string,
  fields: Record<string, unknown>,
): PlannedRow {
  return {
    line,
    action: "create",
    key,
    label,
    changes: Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([field, v]) => ({ field, from: "(new)", to: v instanceof Date ? v.toISOString().slice(0, 10) : String(v) })),
  };
}

/** An update, or a skip when nothing differs — the distinction the whole preview turns on. */
export function updateRow(
  line: number,
  key: string,
  label: string,
  changes: (FieldChange | null)[],
): PlannedRow {
  const real = changes.filter((c): c is FieldChange => c !== null);
  return { line, action: real.length === 0 ? "skip" : "update", key, label, changes: real };
}

/** Collects field errors so a row reports the first problem rather than throwing. */
export class RowReader {
  private failure: string | null = null;

  constructor(private readonly row: Record<string, string>) {}

  text(column: string): string {
    return trim(this.row[column]);
  }

  enum<T extends string>(column: string, allowed: Record<string, T>): T | undefined {
    const r = parseEnum(column, this.text(column), allowed);
    if (r.error) this.fail(r.error);
    return r.value;
  }

  number(column: string): number | undefined {
    const r = parseNumber(column, this.text(column));
    if (r.error) this.fail(r.error);
    return r.value;
  }

  date(column: string): Date | undefined {
    const r = parseDate(column, this.text(column));
    if (r.error) this.fail(r.error);
    return r.value;
  }

  boolean(column: string): boolean | undefined {
    const r = parseBoolean(column, this.text(column));
    if (r.error) this.fail(r.error);
    return r.value;
  }

  fail(message: string) {
    this.failure ??= message;
  }

  get error(): string | null {
    return this.failure;
  }
}
