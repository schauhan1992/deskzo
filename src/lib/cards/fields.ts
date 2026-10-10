/**
 * Deskzo Cards: what a card shows, and the rules for each kind of field. Pure — the card page, the
 * editors and the vCard all read it, on the server and in the browser.
 *
 * A card's fields come from three places, drawn in this order:
 *
 *   · the holder's **record** — photo, job title, department, the company, work phone, work email, the
 *     address they work at. Kept in step with the record; the holder never types them. The template
 *     says which show, and which are locked (the holder can't hide them);
 *   · the template's **shared** fields — one value for every card: the website, the head-office number;
 *   · the holder's **own** fields — LinkedIn, WhatsApp, a booking link — where the template allows them.
 *
 * Privacy by default: nothing personal is on a card unless the holder adds it. `User.phone` is the work
 * number for exactly this reason; the HR record's personal phone and address are never read.
 */

export const RECORD_FIELDS = [
  { key: "photo", label: "Photo" },
  { key: "title", label: "Job title" },
  { key: "department", label: "Department" },
  { key: "company", label: "Company" },
  { key: "phone", label: "Work phone" },
  { key: "email", label: "Work email" },
  { key: "address", label: "Work address" },
] as const;

export type RecordFieldKey = (typeof RECORD_FIELDS)[number]["key"];
export type RecordFieldSetting = { key: RecordFieldKey; show: boolean; locked: boolean };

const RECORD_KEYS = new Set<string>(RECORD_FIELDS.map((f) => f.key));

/** A new template: everything shown, and the company and photo locked — a brand decision, not the holder's. */
export const DEFAULT_RECORD_FIELDS: RecordFieldSetting[] = RECORD_FIELDS.map((f) => ({
  key: f.key,
  show: f.key !== "department",
  locked: f.key === "company" || f.key === "photo",
}));

export const FIELD_KINDS = [
  { kind: "phone", label: "Phone", placeholder: "+91 98765 43210" },
  { kind: "email", label: "Email", placeholder: "name@company.com" },
  { kind: "website", label: "Website", placeholder: "https://company.com" },
  { kind: "linkedin", label: "LinkedIn", placeholder: "https://linkedin.com/in/…" },
  { kind: "whatsapp", label: "WhatsApp", placeholder: "+91 98765 43210" },
  { kind: "calendar", label: "Book a meeting", placeholder: "https://…" },
  { kind: "address", label: "Address", placeholder: "Street, city" },
  { kind: "x", label: "X", placeholder: "https://x.com/…" },
  { kind: "instagram", label: "Instagram", placeholder: "https://instagram.com/…" },
  { kind: "facebook", label: "Facebook", placeholder: "https://facebook.com/…" },
  { kind: "youtube", label: "YouTube", placeholder: "https://youtube.com/…" },
  { kind: "link", label: "Link", placeholder: "https://…" },
] as const;

export type FieldKind = (typeof FIELD_KINDS)[number]["kind"];
export type CardField = { kind: FieldKind; label: string; value: string };

const KINDS = new Map<string, (typeof FIELD_KINDS)[number]>(FIELD_KINDS.map((k) => [k.kind, k]));
const URL_KINDS = new Set<string>(["website", "linkedin", "calendar", "x", "instagram", "facebook", "youtube", "link"]);
const NUMBER_KINDS = new Set<string>(["phone", "whatsapp"]);

export const MAX_OWN_FIELDS = 12;
export const MAX_SHARED_FIELDS = 8;
export const MAX_QUESTIONS = 5;

export function kindLabel(kind: string): string {
  return KINDS.get(kind)?.label ?? "Link";
}

export function kindPlaceholder(kind: string): string {
  return KINDS.get(kind)?.placeholder ?? "";
}

/** A web address as typed — "company.com" — made one a browser opens. Null when it can't be. */
export function normaliseUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER = /^\+?[0-9][0-9 ()-]{5,30}$/;

/** One field as somebody typed it, checked and tidied — or why it can't be used. */
export function checkField(input: { kind?: unknown; label?: unknown; value?: unknown }): { field: CardField } | { error: string } {
  const kind = String(input.kind ?? "");
  const def = KINDS.get(kind);
  if (!def) return { error: "Pick what kind of field it is." };
  const label = String(input.label ?? "").trim().slice(0, 40) || def.label;
  const raw = String(input.value ?? "").trim();
  if (!raw) return { error: `${label} is empty.` };
  if (raw.length > 300) return { error: `${label} is too long.` };
  if (URL_KINDS.has(kind)) {
    const url = normaliseUrl(raw);
    if (!url) return { error: `${label} isn't a web address.` };
    return { field: { kind: def.kind, label, value: url } };
  }
  if (NUMBER_KINDS.has(kind)) {
    if (!NUMBER.test(raw)) return { error: `${label} isn't a phone number.` };
    return { field: { kind: def.kind, label, value: raw } };
  }
  if (kind === "email") {
    if (!EMAIL.test(raw)) return { error: `${label} isn't an email address.` };
    return { field: { kind: def.kind, label, value: raw.toLowerCase() } };
  }
  return { field: { kind: def.kind, label, value: raw } };
}

/** A list of fields as stored (JSON), read back defensively: anything unusable is dropped, never thrown. */
export function readFields(json: unknown, max: number): CardField[] {
  if (!Array.isArray(json)) return [];
  const out: CardField[] = [];
  for (const item of json) {
    if (!item || typeof item !== "object") continue;
    const checked = checkField(item as Record<string, unknown>);
    if ("field" in checked) out.push(checked.field);
    if (out.length >= max) break;
  }
  return out;
}

/** The template's record settings, in its order, with any key it doesn't mention added at the end, hidden. */
export function readRecordFields(json: unknown): RecordFieldSetting[] {
  const seen = new Set<string>();
  const out: RecordFieldSetting[] = [];
  if (Array.isArray(json)) {
    for (const item of json) {
      const key = (item as { key?: unknown })?.key;
      if (typeof key !== "string" || !RECORD_KEYS.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push({ key: key as RecordFieldKey, show: !!(item as { show?: unknown }).show, locked: !!(item as { locked?: unknown }).locked });
    }
  }
  for (const f of RECORD_FIELDS) if (!seen.has(f.key)) out.push({ key: f.key, show: false, locked: false });
  return out;
}

export type CardQuestion = { id: string; label: string; required: boolean };

export function readQuestions(json: unknown): CardQuestion[] {
  if (!Array.isArray(json)) return [];
  const out: CardQuestion[] = [];
  for (const item of json) {
    const q = item as { id?: unknown; label?: unknown; required?: unknown };
    const label = typeof q?.label === "string" ? q.label.trim().slice(0, 120) : "";
    const id = typeof q?.id === "string" && /^[a-z0-9]{1,12}$/.test(q.id) ? q.id : null;
    if (!label || !id) continue;
    out.push({ id, label, required: !!q.required });
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

/** Where tapping a field goes. Null for plain text. */
export function hrefFor(field: Pick<CardField, "kind" | "value">): string | null {
  switch (field.kind) {
    case "phone":
      return `tel:${field.value.replace(/[^0-9+]/g, "")}`;
    case "whatsapp":
      return `https://wa.me/${field.value.replace(/[^0-9]/g, "")}`;
    case "email":
      return `mailto:${field.value}`;
    case "address":
      return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(field.value)}`;
    default:
      return URL_KINDS.has(field.kind) ? field.value : null;
  }
}

/** What the record holds for a card — everything already read, nothing personal. */
export type CardRecord = {
  name: string;
  title: string | null;
  department: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  hasPhoto: boolean;
};

/** A card as drawn: the record's fields the template shows and the holder didn't hide, then shared, then own. */
export type DrawnCard = {
  name: string;
  title: string | null;
  department: string | null;
  company: string | null;
  showPhoto: boolean;
  fields: CardField[];
};

export function drawCard(input: {
  record: CardRecord;
  recordFields: RecordFieldSetting[];
  hidden: readonly string[];
  shared: CardField[];
  own: CardField[];
  allowOwnFields: boolean;
}): DrawnCard {
  const { record } = input;
  const hidden = new Set(input.hidden);
  const shows = (key: RecordFieldKey) => {
    const setting = input.recordFields.find((f) => f.key === key);
    if (!setting?.show) return false;
    return setting.locked || !hidden.has(key);
  };
  const fields: CardField[] = [];
  for (const setting of input.recordFields) {
    if (!shows(setting.key)) continue;
    if (setting.key === "phone" && record.phone) fields.push({ kind: "phone", label: "Work", value: record.phone });
    if (setting.key === "email" && record.email) fields.push({ kind: "email", label: "Work", value: record.email });
    if (setting.key === "address" && record.address) fields.push({ kind: "address", label: "Office", value: record.address });
  }
  fields.push(...input.shared);
  if (input.allowOwnFields) fields.push(...input.own);
  return {
    name: record.name,
    title: shows("title") ? record.title : null,
    department: shows("department") ? record.department : null,
    company: shows("company") ? record.company : null,
    showPhoto: shows("photo") && record.hasPhoto,
    fields,
  };
}

/**
 * A card's address from a name: "Anaya D'Souza" → "anaya-dsouza". Lower-case letters and digits with
 * single hyphens, 3 to 40 long — what the database's CHECK allows.
 */
export function handleFrom(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 34)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : `card-${base || "x"}`.slice(0, 34);
}

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isHandle(value: string): boolean {
  return value.length >= 3 && value.length <= 40 && HANDLE.test(value);
}

/** Text that reads on the card's colour: near-black on a light colour, white on a dark one. */
export function inkOn(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "#ffffff";
  const channel = (h: string) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(m[1]!) + 0.7152 * channel(m[2]!) + 0.0722 * channel(m[3]!);
  // The crossover where black and white text have equal contrast against the colour.
  return luminance > 0.179 ? "#111827" : "#ffffff";
}
