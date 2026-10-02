import {
  coerceValue,
  formatValue,
  isEmptyValue,
  type CustomFieldDef,
  type CustomFieldEntityKey,
  type CustomFieldValues,
} from "@/lib/custom-fields/rules";

/**
 * The workspace's own fields, filled from outside (owner, 2 Oct 2026): a website's call to the lead
 * capture API (src/lib/lead-capture/intake.ts) and a stranger's answers to a public form
 * (src/actions/marketing-public.ts). src/lib/custom-fields/outside-server.ts reads the definitions.
 *
 * Pure: no database, no session — the form builder imports it too.
 *
 * Somebody outside is not a person in the workspace, so three things differ from a form somebody
 * signed in fills (src/lib/custom-fields/rules.ts `applyInput`):
 *
 *   · **Only some fields can be set.** A retired field is hidden everywhere. A restricted one is seen
 *     and changed only by holders of `fields.seeRestricted`, which no website and no stranger holds —
 *     whatever the person who made the key or the form may see. A person field names somebody in the
 *     workspace, and a stranger can't choose who that is.
 *   · **Nothing is required.** A required field left empty doesn't turn an enquiry away: the record is
 *     made, the lead says what is still to fill in, and the next person to edit the record is asked for
 *     it, as they always are.
 *   · **Each value stands alone.** One that can't be used is set aside with the reason; the rest are kept.
 *
 * Values are only ever set on a record the enquiry itself creates — the lead, and the company or
 * contact when they are new. What a stranger types never changes a customer already on file.
 */

/** The record types an enquiry makes: the lead, and — when they are new — its company and contact. */
export const OUTSIDE_ENTITIES = ["LEAD", "COMPANY", "CONTACT"] as const satisfies readonly CustomFieldEntityKey[];
export type OutsideEntity = (typeof OUTSIDE_ENTITIES)[number];

export function isOutsideEntity(value: unknown): value is OutsideEntity {
  return typeof value === "string" && (OUTSIDE_ENTITIES as readonly string[]).includes(value);
}

/** Whether a value for this field may come from outside. */
export function fillableFromOutside(def: CustomFieldDef): boolean {
  return !def.archived && !def.restricted && def.type !== "USER";
}

/** The fields that can be filled from outside, in their order. */
export function outsideDefs<D extends CustomFieldDef>(defs: D[]): D[] {
  return defs.filter(fillableFromOutside);
}

/**
 * A value set aside, and why. `label` and `value` only for a field that can be filled — the value
 * was simply not one it takes. A key that isn't one of those says nothing more than that.
 */
export type SkippedValue = { key: string; reason: string; label?: string; value?: string };

/**
 * The one answer for a key no field has, a retired field, a restricted one and a person field. Which
 * of them it is isn't the sender's business: "restricted" would say a field exists that they can't see.
 */
export const NOT_FILLABLE = "Not one of the fields that can be filled from outside.";

/** Long enough to recognise, short enough for a note. */
const SHOWN = 100;

function shown(raw: unknown): string {
  const text = Array.isArray(raw) ? raw.map(String).join("; ") : raw && typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  return text.length > SHOWN ? `${text.slice(0, SHOWN - 1)}…` : text;
}

function blank(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === "string") return raw.trim() === "";
  if (Array.isArray(raw)) return raw.every((v) => typeof v === "string" && v.trim() === "");
  return false;
}

/**
 * What a new record gets from what came from outside, one key at a time: the key looked up among all
 * of the record type's definitions (retired ones too, so a retired key is answered as any other that
 * can't be filled), the value checked as the field checks it. An empty value is passed over — nothing
 * was lost.
 */
export function applyOutsideInput(defs: CustomFieldDef[], input: unknown): { values: CustomFieldValues; skipped: SkippedValue[] } {
  const values: CustomFieldValues = {};
  const skipped: SkippedValue[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { values, skipped };
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (blank(raw)) continue;
    const def = byKey.get(key);
    if (!def || !fillableFromOutside(def)) {
      skipped.push({ key: shown(key), reason: NOT_FILLABLE });
      continue;
    }
    // Nothing is held yet, so a retired option can't be chosen from outside either.
    const coerced = coerceValue(def, raw);
    if (!coerced.ok) skipped.push({ key, reason: coerced.error, label: def.label, value: shown(raw) });
    else if (coerced.value !== null && !isEmptyValue(coerced.value)) values[def.key] = coerced.value;
  }
  return { values, skipped };
}

/**
 * The required fields still empty, by label — what the lead names as still to fill in. Only fields
 * anybody may see: a restricted field's name isn't written where everybody who reads the lead reads it,
 * and the people who can see it are asked for it when they next edit the record.
 */
export function stillToFill(defs: CustomFieldDef[], values: CustomFieldValues): string[] {
  return defs.filter((d) => d.required && !d.archived && !d.restricted && isEmptyValue(values[d.key])).map((d) => d.label);
}

const ON_RECORD: Record<OutsideEntity, string> = { LEAD: "", COMPANY: " on the company", CONTACT: " on the contact" };

/** "Still to fill in: Tower, Floor" for the lead, and the same for a new company or contact, named as such. */
export function stillToFillLines(missing: Partial<Record<OutsideEntity, string[]>>): string[] {
  return OUTSIDE_ENTITIES.filter((e) => (missing[e]?.length ?? 0) > 0).map((e) => `Still to fill in${ON_RECORD[e]}: ${missing[e]!.join(", ")}`);
}

/** Values in words, for a note somebody reads: "Region: North". */
export function describeValues(defs: CustomFieldDef[], values: CustomFieldValues): string[] {
  return defs.filter((d) => values[d.key] !== undefined).map((d) => `${d.label}: ${formatValue(d, values[d.key])}`);
}
