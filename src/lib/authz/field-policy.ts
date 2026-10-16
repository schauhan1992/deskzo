/**
 * Field access — the third of the three questions in docs/permission-redesign.md (§4.5): which
 * fields of a record somebody may read, which of them are masked, and which they may unmask.
 *
 * Dependency-free, so the role and person editors draw the same masks the server sends. The server
 * half — reading the stored policies and resolving them for one person — is src/lib/authz/fields.ts.
 *
 * ## Four separate answers per field
 *
 *   view          may the value be read at all. Off: the raw value never leaves the server — not
 *                 masked, not in a data attribute — only the word "Restricted" does.
 *   maskInList    shown masked wherever many records are listed: tables, boards, pickers, search,
 *                 dashboards, related-record previews, exports and reports.
 *   maskInDetail  shown masked on the record's own page until it is unmasked.
 *   unmask        may a masked value be revealed on the record's own page. Each lead revealed counts
 *                 once a day against the person's daily limit (src/lib/authz/unmask.ts).
 *
 * The answers are independent on purpose. Switching masking off never grants reading: a field
 * somebody may not view stays restricted whatever its mask switches say. And unmasking needs view.
 *
 * ## Where a policy comes from — the first that answers is final
 *
 *   1. Super admin            → everything readable, nothing masked.
 *   2. Inactive / automation  → nothing readable.
 *   3. The person's own policy for the field (`UserFieldPolicy`, unexpired).
 *   4. Their role's policy (`RoleFieldPolicy`).
 *   5. Nothing stored         → readable and unmasked, which is how every field worked before field
 *                               access existed. Nothing changes for anybody until an admin sets a policy.
 *
 * Field access narrows what the existing rules allow; it never widens them. A reseller's end
 * customer's email stays hidden without "View reseller-managed contact details", and a restricted
 * custom field without "See restricted fields", whatever a field policy says.
 */

export const FIELD_ENTITIES = ["leads"] as const;
export type FieldEntity = (typeof FIELD_ENTITIES)[number];

export const MASK_FORMATS = ["first", "stars", "email", "phone_last4", "phone_code", "partial_address"] as const;
export type MaskFormat = (typeof MASK_FORMATS)[number];

export const MASK_FORMAT_LABELS: Record<MaskFormat, string> = {
  first: "First letter (A********)",
  stars: "Fully hidden (********)",
  email: "Email (s*****@g***.com)",
  phone_last4: "Country code and last four (+91 ******4321)",
  phone_code: "Country code only (+91 ******)",
  partial_address: "City only (********, Pune)",
};

/** What a field is, for choosing the masks it offers. */
export type FieldKind = "text" | "email" | "phone" | "address" | "choice";

export type SensitiveField = {
  entity: FieldEntity;
  /** Stable key; a custom field is `custom:<its key>`. */
  key: string;
  label: string;
  description: string;
  kind: FieldKind;
};

/** The built-in fields of each record that field access covers. Custom fields are added per workspace. */
export const SENSITIVE_FIELDS: readonly SensitiveField[] = [
  { entity: "leads", key: "title", label: "Lead name", description: "The lead's own name — usually the enquiry or the person.", kind: "text" },
  { entity: "leads", key: "companyName", label: "Company name", description: "The name of the company the lead is for, wherever the lead is shown.", kind: "text" },
  { entity: "leads", key: "contactName", label: "Contact name", description: "The name of the person the lead is with.", kind: "text" },
  { entity: "leads", key: "email", label: "Email", description: "The lead contact's email address.", kind: "email" },
  { entity: "leads", key: "phone", label: "Phone", description: "The lead contact's phone numbers.", kind: "phone" },
  { entity: "leads", key: "address", label: "Address", description: "The address of the lead's company.", kind: "address" },
  { entity: "leads", key: "source", label: "Lead source", description: "Where the enquiry came from, and its particulars.", kind: "choice" },
  // Not one of the six asked for by name, but the message a website or form sent lands here — often the
  // person's own words, number and address — so masking the rest and leaving this open would leave it open.
  { entity: "leads", key: "description", label: "Enquiry details", description: "The lead's description: the enquiry message and anything a website or form sent with it.", kind: "text" },
];

export const CUSTOM_FIELD_PREFIX = "custom:";

export function customFieldKey(key: string): string {
  return `${CUSTOM_FIELD_PREFIX}${key}`;
}

export function isCustomFieldKey(key: string): boolean {
  return key.startsWith(CUSTOM_FIELD_PREFIX) && key.length > CUSTOM_FIELD_PREFIX.length;
}

/** A custom field's kind, from its type (src/lib/custom-fields/rules.ts). */
export function customFieldKind(type: string): FieldKind {
  if (type === "EMAIL") return "email";
  if (type === "PHONE") return "phone";
  if (type === "SELECT" || type === "MULTI_SELECT" || type === "CHECKBOX" || type === "USER") return "choice";
  return "text";
}

/** The masks a kind of field offers, the first being its default. */
export function formatsFor(kind: FieldKind): MaskFormat[] {
  switch (kind) {
    case "email":
      return ["email", "first", "stars"];
    case "phone":
      return ["phone_last4", "phone_code", "stars"];
    case "address":
      return ["stars", "partial_address", "first"];
    case "choice":
      return ["stars", "first"];
    case "text":
      return ["first", "stars"];
  }
}

export function defaultFormat(kind: FieldKind): MaskFormat {
  return formatsFor(kind)[0]!;
}

export function isMaskFormat(value: unknown): value is MaskFormat {
  return typeof value === "string" && (MASK_FORMATS as readonly string[]).includes(value);
}

export type FieldPolicy = {
  view: boolean;
  maskInList: boolean;
  maskInDetail: boolean;
  unmask: boolean;
  format: MaskFormat;
};

/** Rule 5: nothing stored — readable, unmasked. */
export function openPolicy(kind: FieldKind): FieldPolicy {
  return { view: true, maskInList: false, maskInDetail: false, unmask: false, format: defaultFormat(kind) };
}

/** Rule 2: nothing readable. */
export function closedPolicy(kind: FieldKind): FieldPolicy {
  return { view: false, maskInList: false, maskInDetail: false, unmask: false, format: defaultFormat(kind) };
}

/**
 * A stored row made consistent. A field that can't be read can't be masked or unmasked either — the
 * switches are kept off rather than left saying something the server won't do — and a format the kind
 * doesn't offer falls back to its default.
 */
export function normalisePolicy(kind: FieldKind, row: { view: boolean; maskInList: boolean; maskInDetail: boolean; unmask: boolean; format: string | null }): FieldPolicy {
  const format = isMaskFormat(row.format) && formatsFor(kind).includes(row.format) ? row.format : defaultFormat(kind);
  if (!row.view) return { view: false, maskInList: false, maskInDetail: false, unmask: false, format };
  return { view: true, maskInList: row.maskInList, maskInDetail: row.maskInDetail, unmask: row.unmask && (row.maskInList || row.maskInDetail), format };
}

/** Where a value is being shown. */
export type FieldContext = "list" | "detail";

/** How one value goes out: as it is, masked, or not at all. */
export type FieldVisibility = "clear" | "masked" | "restricted";

export function visibility(policy: FieldPolicy, context: FieldContext): FieldVisibility {
  if (!policy.view) return "restricted";
  const masked = context === "list" ? policy.maskInList : policy.maskInDetail;
  return masked ? "masked" : "clear";
}

/** What a restricted value is replaced with: no part of it, and the same for every value. */
export const RESTRICTED_TEXT = "Restricted";

const STARS = "********";

/**
 * The masked form of a value. Deterministic, from the value itself, and never as long as the value
 * — every mask is a fixed run of stars around what the format shows, so the length of a name or an
 * address isn't given away either.
 */
export function maskValue(value: string | null | undefined, format: MaskFormat): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return text;
  switch (format) {
    case "stars":
      return STARS;
    case "first":
      return `${Array.from(text)[0]}${STARS}`;
    case "email":
      return maskEmail(text);
    case "phone_last4":
      return maskPhone(text, true);
    case "phone_code":
      return maskPhone(text, false);
    case "partial_address": {
      const parts = text.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
      const city = parts.length > 1 ? parts[parts.length - 1]! : null;
      return city && !/\d{3,}/.test(city) ? `${STARS}, ${city}` : STARS;
    }
  }
}

function maskEmail(text: string): string {
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) return `${Array.from(text)[0]}${STARS}`;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 && dot < domain.length - 1 ? domain.slice(dot + 1) : null;
  return `${Array.from(local)[0]}*****@${Array.from(domain)[0]}***${tld ? `.${tld}` : ""}`;
}

function maskPhone(text: string, lastFour: boolean): string {
  const digits = text.replace(/\D/g, "");
  // A country code is shown only where the number says it has one.
  const code = /^\s*\+(\d{1,3})(?:[\s-]|\(|$)/.exec(text)?.[1] ?? (/^\s*\+/.test(text) && digits.length > 10 ? digits.slice(0, digits.length - 10) : null);
  const prefix = code ? `+${code} ` : "";
  if (!lastFour || digits.length < 8) return `${prefix}******`;
  return `${prefix}******${digits.slice(-4)}`;
}

/** The value as somebody with this policy sees it in this context, before any unmasking. */
export function presentValue(value: string | null | undefined, policy: FieldPolicy, context: FieldContext): string | null {
  switch (visibility(policy, context)) {
    case "clear":
      return value ?? null;
    case "restricted":
      // The same word whether or not there is a value: even "this lead has no phone" is the field's.
      return RESTRICTED_TEXT;
    case "masked":
      return maskValue(value, policy.format);
  }
}
