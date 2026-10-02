/**
 * What a form asks, and what counts as a usable answer.
 *
 * `InboundForm.fields` is a JSON column the form builder writes, so this module exists to stand
 * between that column and everything that trusts it. It is deliberately pure: the public page renders
 * from it, the builder previews from it, and `submitForm` validates against it, and those agreeing is
 * the whole point. A form that renders one set of questions and accepts a different one is worse than
 * a hardcoded form.
 *
 * ## Tolerant on the way in, strict on the way out
 *
 * The parser never throws and never returns something unusable. A spec that is missing, empty,
 * malformed, or full of entries with no key falls back to the default questions, because a public
 * page that renders zero fields is a dead end for a stranger who has no idea anything is wrong —
 * and `prisma/seed-marketing.ts` genuinely writes `fields: []`.
 *
 * The builder's save goes through `checkFieldsForSave` instead, which refuses rather than repairs:
 * a person building a form should be told "the second question has no label", not have it quietly
 * turned into something else.
 *
 * ## Saving an answer to the workspace's own fields
 *
 * A question can also save its answer to one of the workspace's own fields (src/lib/custom-fields)
 * on the lead the form makes, or on the company or contact when the answer is what creates them —
 * `saveTo`. It is then asked as that field is: its type, and for a choice its options, come from the
 * field as it stands when the form is shown or answered (`linkQuestions`), never from a copy that has
 * gone stale. A field since retired, restricted or deleted turns the question back into a plain one.
 */

import { CUSTOM_FIELD_LIMITS, FIELD_KEY_PATTERN, hasOptions, type CustomFieldDef, type CustomFieldTypeKey, type CustomFieldValues } from "@/lib/custom-fields/rules";
import { applyOutsideInput, fillableFromOutside, isOutsideEntity, type OutsideEntity } from "@/lib/custom-fields/outside";

export type FieldType =
  | "TEXT"
  | "EMAIL"
  | "PHONE"
  | "TEXTAREA"
  | "SELECT"
  | "RADIO"
  | "MULTISELECT"
  | "CHECKBOX"
  | "NUMBER"
  | "DATE"
  | "RATING"
  | "HEADING";

export type FormField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** The choice types only. One with none is demoted to a text box. */
  options: string[];
  placeholder: string | null;
  /** A line under the question — "Include add-ons", "Roughly is fine". A heading's paragraph. */
  help: string | null;
  /**
   * The workspace's own field the answer is saved to as well. Never on a heading or on one of
   * RESERVED_KEYS, which fill in the contact and company already. Absent when there is none.
   */
  saveTo?: SaveTo | null;
};

/** One of the workspace's own fields, on one of the records a form's answer makes. */
export type SaveTo = { entity: OutsideEntity; key: string };

export const FIELD_TYPES: { type: FieldType; label: string; hint: string }[] = [
  { type: "TEXT", label: "Short answer", hint: "One line of text" },
  { type: "TEXTAREA", label: "Paragraph", hint: "Several lines" },
  { type: "SELECT", label: "Dropdown", hint: "Pick one from a list" },
  { type: "RADIO", label: "Single choice", hint: "Pick one, every option on show" },
  { type: "MULTISELECT", label: "Multiple choice", hint: "Tick any that apply" },
  { type: "CHECKBOX", label: "Tick box", hint: "One yes/no box — agreements, opt-ins" },
  { type: "NUMBER", label: "Number", hint: "Seats, users, sites" },
  { type: "DATE", label: "Date", hint: "A renewal date, a deadline" },
  { type: "RATING", label: "Rating", hint: "1 to 5" },
  { type: "EMAIL", label: "Email address", hint: "Checked for shape" },
  { type: "PHONE", label: "Phone number", hint: "" },
  { type: "HEADING", label: "Section heading", hint: "Not a question — breaks a long form up" },
];

const TYPES = FIELD_TYPES.map((t) => t.type);

/** The types whose answer has to be one of the options offered. */
export const CHOICE_TYPES: FieldType[] = ["SELECT", "RADIO", "MULTISELECT"];

export function isChoice(type: FieldType): boolean {
  return CHOICE_TYPES.includes(type);
}

/**
 * The keys that are more than answers.
 *
 * `name` and `email` become the contact, `companyName` becomes — or matches — the company, and
 * `phone` is the contact's number. Everything else is just an answer, kept on the submission and
 * repeated into the lead so somebody reads it.
 */
export const RESERVED_KEYS = ["name", "email", "phone", "companyName"] as const;
export type ReservedKey = (typeof RESERVED_KEYS)[number];

export function isReserved(key: string): key is ReservedKey {
  return (RESERVED_KEYS as readonly string[]).includes(key);
}

/**
 * Required whatever the spec says.
 *
 * Without a name and an email there is no contact to create and nobody to reply to, so an admin who
 * deletes those fields — or marks them optional — does not get to break the submit path. They are
 * put back by `parseFields` rather than checked for later.
 */
export const MANDATORY_KEYS: ReservedKey[] = ["name", "email"];

const blank = { options: [] as string[], placeholder: null, help: null };

export const DEFAULT_FIELDS: FormField[] = [
  { key: "name", label: "Your name", type: "TEXT", required: true, ...blank },
  { key: "email", label: "Work email", type: "EMAIL", required: true, ...blank },
  { key: "companyName", label: "Company", type: "TEXT", required: false, ...blank },
  { key: "phone", label: "Phone", type: "PHONE", required: false, ...blank },
  { key: "message", label: "What do you need?", type: "TEXTAREA", required: false, ...blank },
];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A key the builder would write: starts with a letter, then letters, digits and underscores. */
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

export const MAX_FIELDS = 80;
export const MAX_OPTIONS = 40;
const MAX_ANSWER = 4000;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The options as a list somebody can pick from: trimmed, one line each, no blanks, no repeats.
 *
 * One line each because a multiple-choice answer is stored as its picks one per line — an option
 * with a line break in it would come back as two answers, neither of which was offered. A question
 * saved to a field may have as many as the field does.
 */
export function cleanOptions(value: unknown, max: number = MAX_OPTIONS): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const text = str(raw)?.replace(/\s*[\r\n]+\s*/g, " ").slice(0, 200);
    if (text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, max);
}

/** A stored `saveTo`, or null for anything that isn't one. */
export function readSaveTo(value: unknown): SaveTo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { entity, key } = value as Record<string, unknown>;
  if (!isOutsideEntity(entity) || typeof key !== "string" || !FIELD_KEY_PATTERN.test(key)) return null;
  return { entity, key };
}

/** One string per field a question can save to, for telling two questions apart. */
export const targetId = (t: SaveTo) => `${t.entity}:${t.key}`;

function readOne(raw: unknown): FormField | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const key = str(row.key);
  if (!key) return null;

  // `type` is what the schema documents; `kind` is accepted because that is what an earlier writer
  // used, and a form that silently renders every question as a text box is a rotten way to find out.
  const declared = str(row.type) ?? str(row.kind);
  const upper = declared?.toUpperCase();
  const type = (TYPES as string[]).includes(upper ?? "") ? (upper as FieldType) : "TEXT";

  // A heading is words on the page, not a question. It cannot be required, because nothing can
  // answer it — and a required heading would make the form impossible to send.
  if (type === "HEADING") {
    return { key, label: str(row.label) ?? "", type, required: false, options: [], placeholder: null, help: str(row.help) };
  }

  // Nothing to save for the keys that already fill in the contact and company.
  const saveTo = isReserved(key) ? null : readSaveTo(row.saveTo);
  const options = cleanOptions(row.options, saveTo ? CUSTOM_FIELD_LIMITS.options : MAX_OPTIONS);

  return {
    key,
    label: str(row.label) ?? key,
    // A choice with nothing to choose cannot be answered, so it becomes a text box rather than a
    // question nobody can get past.
    type: isChoice(type) && options.length === 0 ? "TEXT" : type,
    required: row.required === true || row.required === "true",
    options: isChoice(type) ? options : [],
    placeholder: str(row.placeholder),
    help: str(row.help),
    ...(saveTo ? { saveTo } : {}),
  };
}

/** Reads the stored spec. Never throws, never returns an empty list. */
export function parseFields(value: unknown): FormField[] {
  const rows = Array.isArray(value) ? value : [];

  const out: FormField[] = [];
  const seen = new Set<string>();
  const targets = new Set<string>();
  for (const raw of rows) {
    const field = readOne(raw);
    // First definition of a key wins. Two fields sharing one key would write over each other's
    // answer, and which of them won would depend on render order.
    if (!field || seen.has(field.key)) continue;
    seen.add(field.key);
    // The same for two questions saving to one field: the first keeps it, the second is a plain question.
    if (field.saveTo && targets.has(targetId(field.saveTo))) delete field.saveTo;
    if (field.saveTo) targets.add(targetId(field.saveTo));
    out.push(field);
  }

  if (!out.some((f) => f.type !== "HEADING")) return DEFAULT_FIELDS;

  // Put back what the submit path cannot do without, at the front where a person expects it.
  for (const key of [...MANDATORY_KEYS].reverse()) {
    const existing = out.findIndex((f) => f.key === key);
    if (existing === -1) {
      out.unshift({ ...DEFAULT_FIELDS.find((f) => f.key === key)! });
    } else {
      out[existing] = { ...out[existing]!, required: true };
    }
  }

  // Whatever an admin called it, the address field is validated as an address.
  const email = out.find((f) => f.key === "email");
  if (email && email.type !== "EMAIL") email.type = "EMAIL";

  return out;
}

/** The questions, without the headings between them. */
export function questionsOf(fields: FormField[]): FormField[] {
  return fields.filter((f) => f.type !== "HEADING");
}

export type Answers = Record<string, string>;

/** A multiple-choice answer is its picks, one per line. */
export function splitPicks(value: string): string[] {
  return value
    .split("\n")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function joinPicks(picks: string[]): string {
  return picks.join("\n");
}

/** `yyyy-mm-dd` that is a real day — not 31 February. */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** "1,20,000" is how a number is written here, so the grouping commas are allowed and ignored. */
export function readNumber(value: string): number | null {
  const plain = value.replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(plain)) return null;
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}

/**
 * Whether the answers satisfy the questions.
 *
 * Returned per field rather than as one message so the page can mark the box that is wrong, and
 * used unchanged on the server, where it is the authority — a client can be made to send anything.
 *
 * `onlyMandatory` is the "can't make it" case on an event: somebody declining needs to say who they
 * are, not answer the questions about the session they are not coming to.
 */
export function validateAnswers(
  fields: FormField[],
  answers: Answers,
  opts: { onlyMandatory?: boolean } = {},
): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const field of questionsOf(fields)) {
    const value = (answers[field.key] ?? "").trim();
    const required = field.required && (!opts.onlyMandatory || (MANDATORY_KEYS as string[]).includes(field.key));

    if (!value) {
      if (required) errors[field.key] = `${field.label} is needed.`;
      // An unanswered optional question is not checked any further. Validating the shape of an
      // empty string is how a blank phone number becomes "that doesn't look like a phone number".
      continue;
    }

    if (field.type === "EMAIL" && !EMAIL_SHAPE.test(value)) {
      errors[field.key] = "That doesn't look like an email address.";
    }
    // An answer that is not one of the offered options did not come from the dropdown.
    if ((field.type === "SELECT" || field.type === "RADIO") && field.options.length > 0 && !field.options.includes(value)) {
      errors[field.key] = `Choose one of the options for ${field.label}.`;
    }
    if (field.type === "MULTISELECT" && splitPicks(value).some((pick) => !field.options.includes(pick))) {
      errors[field.key] = `Choose from the options for ${field.label}.`;
    }
    if (field.type === "NUMBER" && readNumber(value) === null) {
      errors[field.key] = `${field.label} should be a number.`;
    }
    if (field.type === "DATE" && !isCalendarDate(value)) {
      errors[field.key] = `${field.label} should be a date.`;
    }
    if (field.type === "RATING" && !["1", "2", "3", "4", "5"].includes(value)) {
      errors[field.key] = `Pick a rating from 1 to 5 for ${field.label}.`;
    }
    if (field.type === "CHECKBOX" && value !== "yes") {
      errors[field.key] = `${field.label} is a tick box.`;
    }
    if (value.length > MAX_ANSWER) {
      errors[field.key] = `${field.label} is too long.`;
    }
  }

  return errors;
}

/** The first error, for the places that can only show one. */
export function firstError(errors: Record<string, string>): string | null {
  const [first] = Object.values(errors);
  return first ?? null;
}

/**
 * An answer as a person reads it: picks separated by commas, a tick as "Yes", a rating out of five.
 * Blank stays blank, so a table can tell "not answered" from an answer.
 */
export function formatAnswer(field: Pick<FormField, "type">, value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "";
  if (field.type === "MULTISELECT") return splitPicks(text).join(", ");
  if (field.type === "CHECKBOX") return text === "yes" ? "Yes" : text;
  if (field.type === "RATING") return `${text} / 5`;
  return text;
}

/**
 * The custom answers, written out for whoever picks the lead up.
 *
 * Only the questions that are not already a column somewhere: repeating the name and email into the
 * description just makes it longer without making it say more. `except` is the same for the answers
 * saved to the lead's own fields, which its page shows already.
 */
export function summariseAnswers(fields: FormField[], answers: Answers, opts: { except?: Iterable<string> } = {}): string {
  const except = new Set(opts.except ?? []);
  return questionsOf(fields)
    .filter((f) => !isReserved(f.key) && !except.has(f.key))
    .map((f) => ({ label: f.label, value: formatAnswer(f, answers[f.key]) }))
    .filter((r) => r.value)
    .map((r) => `${r.label}: ${r.value}`)
    .join("\n");
}

/**
 * A key for a new question, from its label: "How many seats?" becomes `howManySeats`.
 *
 * Generated once, when the question is added, and never regenerated from a later label: the key is
 * what every earlier answer is stored under, so renaming a question must not orphan its answers.
 */
export function keyFromLabel(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const words = label
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  let base = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase())).join("");
  if (!base || !/^[A-Za-z]/.test(base)) base = `q${base}`;
  base = base.slice(0, 40);
  let key = base;
  for (let n = 2; used.has(key) || isReserved(key); n += 1) key = `${base}${n}`;
  return key;
}

/**
 * The builder's save, which refuses rather than repairs.
 *
 * The parser forgives a bad column so a stranger never meets a broken page. A person building the
 * form is in the opposite position — they can fix it, and should be told what to fix. The two agree
 * on the result: anything this accepts, `parseFields` reads back unchanged.
 */
export function checkFieldsForSave(value: unknown): { ok: true; fields: FormField[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "The questions didn't arrive." };
  if (value.length > MAX_FIELDS) return { ok: false, error: `A form can have at most ${MAX_FIELDS} questions and headings.` };

  const out: FormField[] = [];
  const keys = new Set<string>();
  const targets = new Map<string, string>();
  for (const [index, raw] of value.entries()) {
    const at = `Question ${index + 1}`;
    if (!raw || typeof raw !== "object") return { ok: false, error: `${at} is empty.` };
    const row = raw as Record<string, unknown>;
    const key = str(row.key);
    if (!key || !KEY_SHAPE.test(key)) return { ok: false, error: `${at} has no usable key.` };
    if (keys.has(key)) return { ok: false, error: `Two questions share the key "${key}".` };
    keys.add(key);

    const type = str(row.type)?.toUpperCase() as FieldType | undefined;
    if (!type || !TYPES.includes(type)) return { ok: false, error: `${at} has no type.` };
    const label = str(row.label);
    if (!label && type !== "HEADING") return { ok: false, error: `${at} has no wording.` };
    if (!label && !str(row.help)) return { ok: false, error: `${at} is an empty heading.` };
    if ((label ?? "").length > 300) return { ok: false, error: `${at} is too long — keep the wording under 300 characters.` };

    // Whether the field is still there, and still one a form may fill, is the server's to check
    // (src/actions/forms.ts `saveForm`); here, only what the questions themselves allow.
    const saveTo = readSaveTo(row.saveTo);
    if (row.saveTo !== undefined && row.saveTo !== null && !saveTo) return { ok: false, error: `${at} saves its answer to something that isn't a field.` };
    if (saveTo) {
      if (type === "HEADING") return { ok: false, error: `${at} is a heading — it has no answer to save.` };
      if (isReserved(key)) {
        return { ok: false, error: `"${label}" already fills in the ${key === "companyName" ? "company" : "contact"}, so it can't save to another field as well.` };
      }
      const clash = targets.get(targetId(saveTo));
      if (clash !== undefined) return { ok: false, error: `"${clash}" and "${label}" both save to the same field — one question per field.` };
      targets.set(targetId(saveTo), label ?? "");
    }

    const options = cleanOptions(row.options, saveTo ? CUSTOM_FIELD_LIMITS.options : MAX_OPTIONS);
    // A field's options are the field's: one it offers is enough. Typed in here, a choice of one is no choice.
    if (isChoice(type) && options.length < (saveTo ? 1 : 2)) {
      return { ok: false, error: saveTo ? `"${label}" has no options to choose from.` : `"${label}" needs at least two options to choose from.` };
    }
    if (key === "email" && type !== "EMAIL") return { ok: false, error: "The email question has to be an email address." };

    out.push({
      key,
      label: label ?? "",
      type,
      required: type === "HEADING" ? false : row.required === true || (MANDATORY_KEYS as string[]).includes(key),
      options: isChoice(type) ? options : [],
      placeholder: type === "HEADING" ? null : str(row.placeholder),
      help: str(row.help)?.slice(0, 1000) ?? null,
      ...(saveTo ? { saveTo } : {}),
    });
  }

  for (const key of MANDATORY_KEYS) {
    if (!keys.has(key)) {
      return { ok: false, error: `Every form asks for ${key === "name" ? "a name" : "an email address"} — put that question back.` };
    }
  }
  return { ok: true, fields: out };
}

// ─── Saving answers to the workspace's own fields ────────────────────────────

/** The question each kind of field is asked as. A person field has none: a stranger can't name somebody in the workspace. */
export const QUESTION_TYPE_FOR: Record<CustomFieldTypeKey, FieldType | null> = {
  TEXT: "TEXT",
  LONG_TEXT: "TEXTAREA",
  NUMBER: "NUMBER",
  MONEY: "NUMBER",
  DATE: "DATE",
  SELECT: "SELECT",
  MULTI_SELECT: "MULTISELECT",
  CHECKBOX: "CHECKBOX",
  EMAIL: "EMAIL",
  PHONE: "PHONE",
  URL: "TEXT",
  USER: null,
};

/** A field a question can save its answer to, as the builder offers it and a question is asked. */
export type FieldTarget = SaveTo & {
  label: string;
  /** The question it is asked as. */
  type: FieldType;
  /** A choice's options on offer today, by label — what the person filling the form in reads. */
  options: string[];
  required: boolean;
  help: string | null;
};

/**
 * The question a field is asked as — or null for one a form can't fill, or a choice with nothing left
 * to choose. Required as the field is, except a yes-or-no: a tick box that has to be ticked can only
 * be answered yes, which is not what "required" means for one.
 */
export function targetFor(entity: SaveTo["entity"], def: CustomFieldDef): FieldTarget | null {
  const type = QUESTION_TYPE_FOR[def.type];
  if (!type || !fillableFromOutside(def)) return null;
  const options = hasOptions(def.type) ? cleanOptions(def.options.filter((o) => !o.archived).map((o) => o.label), CUSTOM_FIELD_LIMITS.options) : [];
  if (isChoice(type) && options.length === 0) return null;
  return { entity, key: def.key, label: def.label, type, options, required: def.required && type !== "CHECKBOX", help: def.helpText };
}

export type FieldsByRecord = Record<SaveTo["entity"], CustomFieldDef[]>;

/**
 * The questions as the workspace's fields stand now — read whenever a form is shown or answered.
 *
 * A question saved to a field that is still there, and still one a form may fill, is asked as the
 * field is: its type, and its options as they are today, so an option renamed or retired since the
 * form was built is offered as it now is. One whose field has been retired, restricted or deleted is
 * a plain question again — its answer kept on the submission like any other. Whether it is required
 * stays the form's own choice.
 */
export function linkQuestions(fields: FormField[], defs: FieldsByRecord): FormField[] {
  return fields.map((field) => {
    const saveTo = field.saveTo;
    if (!saveTo) return field;
    const def = defs[saveTo.entity].find((d) => d.key === saveTo.key);
    const target = def ? targetFor(saveTo.entity, def) : null;
    if (!target) {
      const plain = { ...field };
      delete plain.saveTo;
      return plain;
    }
    return { ...field, type: target.type, options: target.options };
  });
}

/** No values for any record — where an answer saves nothing, as somebody declining an event's doesn't. */
export const noLinkedValues = (): Record<SaveTo["entity"], CustomFieldValues> => ({ LEAD: {}, COMPANY: {}, CONTACT: {} });

/**
 * The answers to the questions saved to fields, as those fields store them: a multiple choice's picks
 * as a list, a tick as yes. Checked as the field checks a value (src/lib/custom-fields/outside.ts), in
 * the question's own words when one can't be used — the person filling the form in is there to put it
 * right. Unanswered questions set nothing.
 *
 * Expects the questions `linkQuestions` returned, so every `saveTo` left is a field that can be filled.
 */
export function linkedAnswers(
  fields: FormField[],
  answers: Answers,
  defs: FieldsByRecord,
): { values: Record<SaveTo["entity"], CustomFieldValues>; errors: Record<string, string> } {
  const values = noLinkedValues();
  const errors: Record<string, string> = {};
  for (const field of questionsOf(fields)) {
    const answer = (answers[field.key] ?? "").trim();
    const saveTo = field.saveTo;
    if (!saveTo || !answer) continue;
    const def = defs[saveTo.entity].find((d) => d.key === saveTo.key);
    if (!def) continue;
    const input = field.type === "MULTISELECT" ? splitPicks(answer) : answer;
    const applied = applyOutsideInput([{ ...def, label: field.label }], { [def.key]: input });
    const refused = applied.skipped[0];
    if (refused) errors[field.key] = refused.reason;
    else Object.assign(values[saveTo.entity], applied.values);
  }
  return { values, errors };
}

/** The questions whose answers went into the lead's own fields — left out of its description. */
export function savedToLead(fields: FormField[], leadValues: CustomFieldValues): string[] {
  return fields
    .filter((f) => {
      const to = f.saveTo;
      return to?.entity === "LEAD" && leadValues[to.key] !== undefined;
    })
    .map((f) => f.key);
}
