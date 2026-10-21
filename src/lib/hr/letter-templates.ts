import type { LetterPayload } from "@/lib/hr/letters";

/**
 * HR's own letters and official documents (owner, 21 Oct 2026): text written once with {{fields}}, filled
 * in from a person's record when a letter is drafted from it — beside the built-in letters, which stay.
 *
 * The fields are the facts a built-in letter freezes (LetterPayload), so a letter from a template is
 * frozen the same way: drafted, it is plain text HR can still adjust before issuing it. Written as the
 * email templates are (src/lib/documents/email-template.ts): {{field}}, or {{field|what to say instead}}.
 * A field with nothing to put in it and no "instead" leaves a blank line to fill in — a letter is read
 * before it is issued, and a gap is easier to see than a guess.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2 October 2026", for a `yyyy-mm-dd` day. */
function longDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const rupees = (value: number | null | undefined) => (value == null ? null : `₹${Math.round(value).toLocaleString("en-IN")}`);

type Field = { key: string; label: string; example: string; value: (p: LetterPayload, today: string) => string | null };

export const LETTER_FIELDS: readonly Field[] = [
  { key: "employee.name", label: "Their name", example: "Priya Sharma", value: (p) => p.employeeName },
  { key: "employee.code", label: "Their employee code", example: "EMP-0042", value: (p) => p.employeeCode },
  { key: "employee.designation", label: "Their designation", example: "Sales Manager", value: (p) => (p.designation === "—" ? null : p.designation) },
  { key: "employee.department", label: "Their department", example: "Sales", value: (p) => p.department },
  { key: "employee.joinedOn", label: "The day they joined", example: "1 April 2024", value: (p) => longDate(p.joinedOn) },
  { key: "employee.confirmedOn", label: "The day they were confirmed", example: "1 October 2024", value: (p) => longDate(p.confirmedOn) },
  { key: "employee.lastWorkingDay", label: "Their last working day", example: "31 March 2027", value: (p) => longDate(p.lastWorkingDay) },
  { key: "employee.reportingTo", label: "Who they report to", example: "Rahul Verma", value: (p) => p.reportingTo ?? null },
  { key: "employee.workLocation", label: "Where they work", example: "Mumbai", value: (p) => p.workLocation ?? null },
  { key: "employee.noticePeriodDays", label: "Their notice period, in days", example: "30", value: (p) => (p.noticePeriodDays == null ? null : String(p.noticePeriodDays)) },
  { key: "salary.annualCtc", label: "Their annual CTC", example: "₹9,60,000", value: (p) => rupees(p.annualCtc) },
  { key: "salary.monthlyGross", label: "Their monthly gross", example: "₹75,000", value: (p) => rupees(p.monthlyGross) },
  { key: "company.name", label: "Our company's name", example: "Acme Industries Pvt Ltd", value: (p) => p.companyName },
  { key: "company.address", label: "Our address", example: "12 MG Road, Pune", value: (p) => p.companyAddress },
  { key: "signatory.name", label: "Who signs it", example: "Anita Rao", value: (p) => p.signatoryName ?? null },
  { key: "signatory.title", label: "Their title", example: "Head of HR", value: (p) => p.signatoryTitle ?? null },
  { key: "today", label: "Today's date", example: "21 October 2026", value: (_p, today) => longDate(today) },
];

const FIELD = /\{\{\s*([a-zA-Z.]+)\s*(?:\|([^}]*))?\}\}/g;
const BLANK = "__________";

/** The fields a template names that aren't fields — said when it is saved, rather than on a letter. */
export function unknownLetterFields(text: string): string[] {
  const known = new Set(LETTER_FIELDS.map((f) => f.key));
  return [...new Set([...text.matchAll(FIELD)].map((m) => m[1]!).filter((key) => !known.has(key)))];
}

/** A template's text with a person's facts in it. `today` is the workspace's, yyyy-mm-dd. */
export function mergeLetterTemplate(text: string, payload: LetterPayload, today: string): string {
  return text.replace(FIELD, (whole, key: string, fallback: string | undefined) => {
    const field = LETTER_FIELDS.find((f) => f.key === key);
    if (!field) return whole;
    const value = field.value(payload, today)?.trim();
    if (value) return value;
    return fallback !== undefined ? fallback : BLANK;
  });
}

/** What a new template starts with — something to change, rather than an empty box. */
export const STARTER_TEMPLATE = {
  name: "",
  code: "",
  subject: "Letter to {{employee.name}}",
  body: `Date: {{today}}

To,
{{employee.name}}
{{employee.designation}}, {{employee.department|our team}}

Dear {{employee.name}},

Write the letter here. Anything in double braces is filled in from their record when the letter is drafted — pick a field from the list to put one in.

Yours sincerely,
For {{company.name}}`,
};
