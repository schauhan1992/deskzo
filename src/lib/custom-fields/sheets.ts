import type { FieldChange } from "@/lib/portability/importers/types";
import { exportValue, type CustomFieldDef, type CustomFieldEntityKey, type CustomFieldValues } from "@/lib/custom-fields/rules";
import { fieldsFor, prepareCustomFields, valuesOf } from "@/lib/custom-fields/server";
import { db } from "@/lib/db";
import { PEOPLE_ONLY } from "@/lib/people";

/**
 * Custom fields in spreadsheets — the Settings → Data exports and imports (src/lib/portability), the
 * products CSV and the leads CSV.
 *
 * A field's column is headed by its label. Where that heading is taken — by a built-in column
 * ("Website" on companies) or by an earlier field — it becomes "Website (custom)", then "(custom 2)",
 * so no two columns share a heading and none overwrites another. The headings are worked out the same
 * way, in the same order, for an export and for the import that reads it back.
 *
 * An export writes every field the person may see, empty or not, because a sheet's headings come from
 * its first row; numbers and amounts go out as numbers. An import reads only the cells that hold
 * something — a blank cell leaves the value alone, as it does for every built-in column — and checks
 * each value with the same rules the forms use (src/lib/custom-fields/rules.ts).
 */

/** Each field's heading, in order: its label, or the label marked "(custom)" where that is taken. */
function headings(defs: CustomFieldDef[], builtInColumns: string[]): Map<string, string> {
  const taken = new Set(builtInColumns.map((c) => c.trim().toLowerCase()));
  const out = new Map<string, string>();
  for (const d of defs) {
    let heading = d.label;
    for (let n = 1; taken.has(heading.trim().toLowerCase()); n += 1) heading = `${d.label} (custom${n > 1 ? ` ${n}` : ""})`;
    taken.add(heading.trim().toLowerCase());
    out.set(d.key, heading);
  }
  return out;
}

async function namesFor(defs: CustomFieldDef[], values: CustomFieldValues[]): Promise<Map<string, string>> {
  const keys = defs.filter((d) => d.type === "USER").map((d) => d.key);
  const ids = [...new Set(values.flatMap((v) => keys.map((k) => v[k]).filter((x): x is string => typeof x === "string")))];
  if (ids.length === 0) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The custom columns for an export: given the records' ids, each one's cells by heading. Fields the
 * person may not see are not written at all. `sanitize` guards the text cells of a CSV a spreadsheet
 * will open (src/lib/csv.ts `sanitizeCsvCell`); numbers carry no formula and stay numbers.
 *
 * `hiddenFor` names, for one record, the fields whose cells are left blank there although the column
 * is written — hidden from this person on that record alone (a reseller's end customer's contact
 * details, src/lib/authz/contact-access.ts). Blank, because blank is "leave alone" when the file comes
 * back.
 */
export async function exportCells(
  entity: CustomFieldEntityKey,
  userId: string,
  ids: string[],
  builtInColumns: string[],
  options: { sanitize?: (text: string) => string; hiddenFor?: (id: string) => ReadonlySet<string> | undefined } = {},
): Promise<(id: string) => Record<string, string | number>> {
  const { visible } = await fieldsFor(entity, userId);
  if (visible.length === 0) return () => ({});
  const heads = headings(visible, builtInColumns);
  const values = await valuesOf(entity, ids);
  const names = await namesFor(visible, [...values.values()]);
  return (id) => {
    const v = values.get(id) ?? {};
    const hidden = options.hiddenFor?.(id);
    const out: Record<string, string | number> = {};
    for (const d of visible) {
      if (hidden?.has(d.key)) {
        out[heads.get(d.key)!] = "";
        continue;
      }
      const value = v[d.key];
      const numeric = (d.type === "NUMBER" || d.type === "MONEY") && typeof value === "number";
      const text = numeric ? value : exportValue(d, value, (pid) => names.get(pid));
      out[heads.get(d.key)!] = typeof text === "string" && options.sanitize ? options.sanitize(text) : text;
    }
    return out;
  };
}

/**
 * A person field's cells as the ids the field stores, in place in `input`.
 *
 * An export writes the person's name (`exportValue`), so that is what comes back. A cell that reads
 * exactly as this record's export would is the person it holds, unchanged, even one who has since
 * left. Anything else names somebody by full name or email address, and must be a current person.
 */
async function personIds(
  defs: CustomFieldDef[],
  input: Record<string, string>,
  existing: CustomFieldValues,
  heads: Map<string, string>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (defs.length === 0) return { ok: true };
  const held = await namesFor(defs, [existing]);
  for (const d of defs) {
    const cell = input[d.key]!;
    const current = existing[d.key];
    if (typeof current === "string" && cell === exportValue(d, current, (pid) => held.get(pid))) {
      input[d.key] = current;
      continue;
    }
    const person = await db.user.findFirst({
      // An id still works: until names were read back, it was the only thing this column took.
      where: { active: true, ...PEOPLE_ONLY, OR: [{ id: cell }, { email: cell.toLowerCase() }, { name: { equals: cell, mode: "insensitive" } }] },
      select: { id: true },
    });
    if (!person) return { ok: false, error: `No current person matches "${cell}" (${heads.get(d.key)}). Use their full name or their email address.` };
    input[d.key] = person.id;
  }
  return { ok: true };
}

export type CustomSheet = {
  /** The columns the template offers and the unknown-column check accepts. */
  headers: string[];
  /**
   * What one record's values become with this row's cells, and the changes for the preview. `existing`
   * is the record's values today ({} for a new record).
   *
   * `skip` names fields hidden from this person on this record (see `exportCells`' `hiddenFor`): their
   * cells are read as blank — nothing compared, so nothing about the value shows, and nothing written.
   * `ignored` is the headings of those that held something, for the preview to say so.
   */
  merge(
    existing: CustomFieldValues,
    row: Record<string, string>,
    options?: { skip?: Iterable<string> },
  ): Promise<{ ok: true; values: CustomFieldValues; changes: FieldChange[]; ignored: string[] } | { ok: false; error: string }>;
};

/** The custom columns an import of one record type understands, for this person — null when there are none. */
export async function customSheetFor(entity: CustomFieldEntityKey, userId: string, builtInColumns: string[]): Promise<CustomSheet | null> {
  const { visible } = await fieldsFor(entity, userId);
  if (visible.length === 0) return null;
  const heads = headings(visible, builtInColumns);
  const byHeading = new Map(visible.map((d) => [heads.get(d.key)!.trim().toLowerCase(), d]));

  return {
    headers: visible.map((d) => heads.get(d.key)!),
    async merge(existing, row, options = {}) {
      const skip = new Set(options.skip ?? []);
      const input: Record<string, string> = {};
      const ignored: string[] = [];
      for (const [heading, cell] of Object.entries(row)) {
        const def = byHeading.get(heading.trim().toLowerCase());
        if (!def || String(cell ?? "").trim() === "") continue;
        if (skip.has(def.key)) ignored.push(heads.get(def.key)!);
        else input[def.key] = String(cell).trim();
      }
      const keys = Object.keys(input);
      if (keys.length === 0) return { ok: true, values: existing, changes: [], ignored };
      const named = await personIds(visible.filter((d) => d.type === "USER" && input[d.key] !== undefined), input, existing, heads);
      if (!named.ok) return named;
      const prepared = await prepareCustomFields({ entity, userId, input, existing, checkRequired: false, only: keys });
      if (!prepared.ok) return { ok: false, error: prepared.error };
      const names = await namesFor(visible, [existing, prepared.values]);
      const changes: FieldChange[] = [];
      for (const d of visible) {
        if (!keys.includes(d.key)) continue;
        const from = exportValue(d, existing[d.key], (pid) => names.get(pid));
        const to = exportValue(d, prepared.values[d.key], (pid) => names.get(pid));
        if (from !== to) changes.push({ field: heads.get(d.key)!, from: from || "(empty)", to: to || "(empty)" });
      }
      return { ok: true, values: prepared.values, changes, ignored };
    },
  };
}
