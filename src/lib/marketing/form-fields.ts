/**
 * What an inbound form asks, and what counts as a usable answer.
 *
 * `InboundForm.fields` is a JSON column an admin edits, so this module exists to stand between that
 * column and everything that trusts it. It is deliberately pure: the public page renders from it,
 * and `submitForm` validates against it, and those two agreeing is the whole point. A form that
 * renders one set of questions and accepts a different one is worse than a hardcoded form.
 *
 * ## Tolerant on the way in, strict on the way out
 *
 * The parser never throws and never returns something unusable. A spec that is missing, empty,
 * malformed, or full of entries with no key falls back to the default questions, because a public
 * page that renders zero fields is a dead end for a stranger who has no idea anything is wrong —
 * and `prisma/seed-marketing.ts` genuinely writes `fields: []`.
 */

export type FieldType = "TEXT" | "EMAIL" | "PHONE" | "TEXTAREA" | "SELECT" | "CHECKBOX";

export type FormField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** `SELECT` only. A select with none is demoted to a text box. */
  options: string[];
  placeholder: string | null;
};

const TYPES: FieldType[] = ["TEXT", "EMAIL", "PHONE", "TEXTAREA", "SELECT", "CHECKBOX"];

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

export const DEFAULT_FIELDS: FormField[] = [
  { key: "name", label: "Your name", type: "TEXT", required: true, options: [], placeholder: null },
  { key: "email", label: "Work email", type: "EMAIL", required: true, options: [], placeholder: null },
  { key: "companyName", label: "Company", type: "TEXT", required: false, options: [], placeholder: null },
  { key: "phone", label: "Phone", type: "PHONE", required: false, options: [], placeholder: null },
  { key: "message", label: "What do you need?", type: "TEXTAREA", required: false, options: [], placeholder: null },
];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

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

  const options = Array.isArray(row.options)
    ? row.options.map((o) => str(o)).filter((o): o is string => o !== null)
    : [];

  return {
    key,
    label: str(row.label) ?? key,
    // A select with nothing to select cannot be answered, so it becomes a text box rather than a
    // question nobody can get past.
    type: type === "SELECT" && options.length === 0 ? "TEXT" : type,
    required: row.required === true || row.required === "true",
    options,
    placeholder: str(row.placeholder),
  };
}

/** Reads the stored spec. Never throws, never returns an empty list. */
export function parseFields(value: unknown): FormField[] {
  const rows = Array.isArray(value) ? value : [];

  const out: FormField[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const field = readOne(raw);
    // First definition of a key wins. Two fields sharing one key would write over each other's
    // answer, and which of them won would depend on render order.
    if (!field || seen.has(field.key)) continue;
    seen.add(field.key);
    out.push(field);
  }

  if (out.length === 0) return DEFAULT_FIELDS;

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

export type Answers = Record<string, string>;

/**
 * Whether the answers satisfy the questions.
 *
 * Returned per field rather than as one message so the page can mark the box that is wrong, and
 * used unchanged on the server, where it is the authority — a client can be made to send anything.
 */
export function validateAnswers(fields: FormField[], answers: Answers): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const field of fields) {
    const value = (answers[field.key] ?? "").trim();

    if (!value) {
      if (field.required) errors[field.key] = `${field.label} is needed.`;
      // An unanswered optional question is not checked any further. Validating the shape of an
      // empty string is how a blank phone number becomes "that doesn't look like a phone number".
      continue;
    }

    if (field.type === "EMAIL" && !EMAIL_SHAPE.test(value)) {
      errors[field.key] = "That doesn't look like an email address.";
    }
    // An answer that is not one of the offered options did not come from the dropdown.
    if (field.type === "SELECT" && field.options.length > 0 && !field.options.includes(value)) {
      errors[field.key] = `Choose one of the options for ${field.label}.`;
    }
    if (value.length > 4000) {
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
 * The custom answers, written out for whoever picks the lead up.
 *
 * Only the questions that are not already a column somewhere: repeating the name and email into the
 * description just makes it longer without making it say more.
 */
export function summariseAnswers(fields: FormField[], answers: Answers): string {
  return fields
    .filter((f) => !isReserved(f.key))
    .map((f) => ({ label: f.label, value: (answers[f.key] ?? "").trim() }))
    .filter((r) => r.value)
    .map((r) => `${r.label}: ${r.value}`)
    .join("\n");
}
