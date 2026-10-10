/**
 * Deskzo Cards: what a card template says and what a card shows (docs/digital-cards-and-signatures.md
 * §3.2–3.3). Pure and client-safe — the template editor, "My card", the public page and the checks all
 * read it, so the rules about which value wins live in one place.
 *
 * A field is one of three kinds:
 *   · **record** — from the person's record (title, work phone, email, photo, branch address), kept in
 *     step automatically. The person can hide it unless it is locked; nobody types it on the card.
 *   · **shared** — one value for everyone on the template (the company website, the head office phone).
 *     The person can put their own in its place unless it is locked.
 *   · **own** — the person's own (LinkedIn, WhatsApp, a calendar link). Shown only when they fill it in.
 *     Locked means the template doesn't offer it.
 *
 * Privacy by default (§3.3): a personal phone or personal email never appears unless the person types
 * it themselves, as one of their own fields. Nothing here reads the HR record's personal contacts.
 */

export type CardFieldKind = "record" | "shared" | "own";

export type CardFieldKey =
  | "title"
  | "workPhone"
  | "email"
  | "photo"
  | "branchAddress"
  | "website"
  | "companyPhone"
  | "address"
  | "linkedin"
  | "whatsapp"
  | "calendar"
  | "mobile";

export type CardFieldDef = {
  key: CardFieldKey;
  kind: CardFieldKind;
  label: string;
  /** How the public page offers it — a link it opens, or nothing. */
  link: "tel" | "mailto" | "url" | "whatsapp" | null;
  /** On a new template. */
  onByDefault: boolean;
};

export const CARD_FIELDS: readonly CardFieldDef[] = [
  { key: "photo", kind: "record", label: "Photo", link: null, onByDefault: true },
  { key: "title", kind: "record", label: "Job title", link: null, onByDefault: true },
  { key: "workPhone", kind: "record", label: "Work phone", link: "tel", onByDefault: true },
  { key: "email", kind: "record", label: "Work email", link: "mailto", onByDefault: true },
  { key: "branchAddress", kind: "record", label: "Office address (their branch)", link: null, onByDefault: false },
  { key: "website", kind: "shared", label: "Website", link: "url", onByDefault: true },
  { key: "companyPhone", kind: "shared", label: "Company phone", link: "tel", onByDefault: false },
  { key: "address", kind: "shared", label: "Address", link: null, onByDefault: false },
  { key: "linkedin", kind: "own", label: "LinkedIn", link: "url", onByDefault: true },
  { key: "whatsapp", kind: "own", label: "WhatsApp", link: "whatsapp", onByDefault: true },
  { key: "calendar", kind: "own", label: "Book a meeting", link: "url", onByDefault: true },
  { key: "mobile", kind: "own", label: "Mobile", link: "tel", onByDefault: false },
];

export function cardFieldDef(key: string): CardFieldDef | undefined {
  return CARD_FIELDS.find((f) => f.key === key);
}

/** One field as a template holds it. `value` is the shared value, and only shared fields have one. */
export type TemplateField = { key: CardFieldKey; on: boolean; locked: boolean; value?: string };

export const MAX_QUESTIONS = 5;
export const MAX_FIELD_LENGTH = 200;

/** The fields a new template starts with: every field, in the catalogue's order, the usual ones on. */
export function defaultTemplateFields(): TemplateField[] {
  return CARD_FIELDS.map((f) => ({
    key: f.key,
    on: f.onByDefault,
    // A shared value is the company's: locked until somebody decides otherwise.
    locked: f.kind === "shared",
    ...(f.kind === "shared" ? { value: "" } : {}),
  }));
}

/**
 * A template's stored field list, read defensively: unknown keys dropped, missing ones added switched
 * off, the stored order kept. Whatever is in the column, the result is a complete, valid list.
 */
export function readTemplateFields(raw: unknown): TemplateField[] {
  const seen = new Set<string>();
  const out: TemplateField[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const def = typeof r.key === "string" ? cardFieldDef(r.key) : undefined;
      if (!def || seen.has(def.key)) continue;
      seen.add(def.key);
      out.push({
        key: def.key,
        on: r.on === true,
        locked: r.locked === true,
        ...(def.kind === "shared" ? { value: clean(r.value) } : {}),
      });
    }
  }
  for (const def of CARD_FIELDS) {
    if (!seen.has(def.key)) out.push({ key: def.key, on: false, locked: def.kind === "shared", ...(def.kind === "shared" ? { value: "" } : {}) });
  }
  return out;
}

export function readQuestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(clean).filter((q) => q.length > 0).slice(0, MAX_QUESTIONS);
}

/** What a card holds of its own: values for own fields, overrides of open shared fields, record fields hidden. */
export type CardValues = { own: Partial<Record<CardFieldKey, string>>; hidden: CardFieldKey[]; about: string };

export function readCardValues(raw: unknown): CardValues {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ownRaw = r.own && typeof r.own === "object" ? (r.own as Record<string, unknown>) : {};
  const own: Partial<Record<CardFieldKey, string>> = {};
  for (const [k, v] of Object.entries(ownRaw)) {
    const def = cardFieldDef(k);
    if (!def || def.kind === "record") continue;
    const value = clean(v);
    if (value) own[def.key] = value;
  }
  const hidden = Array.isArray(r.hidden)
    ? (r.hidden.filter((k) => typeof k === "string" && cardFieldDef(k)?.kind === "record") as CardFieldKey[])
    : [];
  return { own, hidden: [...new Set(hidden)], about: clean(r.about).slice(0, 280) };
}

/**
 * What a person may change on their card under this template — the rule the "My card" form and the
 * action that saves it both use, so the form never offers what the action would refuse.
 */
export function editableFields(fields: TemplateField[]): { hideable: CardFieldKey[]; typeable: CardFieldKey[] } {
  const hideable: CardFieldKey[] = [];
  const typeable: CardFieldKey[] = [];
  for (const f of fields) {
    const def = cardFieldDef(f.key);
    if (!def || !f.on) continue;
    if (def.kind === "record" && !f.locked) hideable.push(f.key);
    if (def.kind === "shared" && !f.locked) typeable.push(f.key);
    if (def.kind === "own" && !f.locked) typeable.push(f.key);
  }
  return { hideable, typeable };
}

/**
 * The person's values, cut down to what the template lets them set. Anything else — a locked field,
 * a field switched off, a record field typed in — is dropped, not refused: the template may have
 * changed since the form was opened.
 */
export function permittedValues(fields: TemplateField[], input: CardValues): CardValues {
  const { hideable, typeable } = editableFields(fields);
  const own: Partial<Record<CardFieldKey, string>> = {};
  for (const key of typeable) {
    const v = input.own[key];
    if (v) own[key] = v.slice(0, MAX_FIELD_LENGTH);
  }
  return { own, hidden: input.hidden.filter((k) => hideable.includes(k)), about: input.about };
}

/** The person and company a card is about, as the server reads them. */
export type CardPerson = {
  name: string;
  title: string | null;
  workPhone: string | null;
  email: string;
  hasPhoto: boolean;
  branchAddress: string | null;
};

export type CardLine = { key: CardFieldKey; label: string; value: string; href: string | null };

export type ResolvedCard = {
  name: string;
  title: string | null;
  about: string;
  showPhoto: boolean;
  lines: CardLine[];
};

/** Resolves what a card shows: template order, the template's switches, then the person's choices. */
export function resolveCard(fields: TemplateField[], values: CardValues, person: CardPerson): ResolvedCard {
  const lines: CardLine[] = [];
  let title: string | null = null;
  let showPhoto = false;
  for (const f of fields) {
    const def = cardFieldDef(f.key);
    if (!def || !f.on) continue;
    if (def.kind === "record") {
      if (!f.locked && values.hidden.includes(f.key)) continue;
      if (f.key === "photo") {
        showPhoto = person.hasPhoto;
        continue;
      }
      if (f.key === "title") {
        title = person.title?.trim() || null;
        continue;
      }
      const value = f.key === "workPhone" ? person.workPhone : f.key === "email" ? person.email : person.branchAddress;
      if (value?.trim()) lines.push(line(def, value.trim()));
      continue;
    }
    const value = def.kind === "shared" ? (!f.locked && values.own[f.key]) || f.value || "" : f.locked ? "" : values.own[f.key] || "";
    if (value.trim()) lines.push(line(def, value.trim()));
  }
  return { name: person.name, title, about: values.about, showPhoto, lines };
}

function line(def: CardFieldDef, value: string): CardLine {
  return { key: def.key, label: def.label, value, href: hrefFor(def.link, value) };
}

/** A link only when the value really is one: a stray "javascript:" typed as a website is shown as text, never linked. */
export function hrefFor(kind: CardFieldDef["link"], value: string): string | null {
  const digits = value.replace(/[^\d+]/g, "");
  switch (kind) {
    case "tel":
      return digits.replace(/\D/g, "").length >= 6 ? `tel:${digits}` : null;
    case "whatsapp": {
      const n = digits.replace(/\D/g, "");
      return n.length >= 8 ? `https://wa.me/${n}` : null;
    }
    case "mailto":
      return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(value) ? `mailto:${value}` : null;
    case "url": {
      const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
      try {
        const u = new URL(withScheme);
        return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") ? u.toString() : null;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

/** A card's address: lower-case letters, digits and single hyphens, 3–60 characters. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** "Priya Sharma" → "priya-sharma"; a name with no Latin letters falls back to "card". */
export function slugBase(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : `${base ? `${base}-` : ""}card`;
}

/** The first free address for a name, given the ones taken: priya-sharma, priya-sharma-2, … */
export function freeSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugBase(name);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** vCard 3.0 — what iPhone and Android both open as "add contact". */
export function buildVCard(card: ResolvedCard, company: string | null, url: string, photo: { mime: string; base64: string } | null): string {
  // Any line break — CRLF, CR or LF — is one escaped \n, so a typed value can never start a vCard line of its own.
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/([,;])/g, "\\$1");
  const parts = card.name.trim().split(/\s+/);
  const family = parts.length > 1 ? parts[parts.length - 1]! : "";
  const given = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] ?? "";
  const out = ["BEGIN:VCARD", "VERSION:3.0", `N:${esc(family)};${esc(given)};;;`, `FN:${esc(card.name)}`];
  if (company) out.push(`ORG:${esc(company)}`);
  if (card.title) out.push(`TITLE:${esc(card.title)}`);
  for (const l of card.lines) {
    switch (l.key) {
      case "workPhone":
        out.push(`TEL;TYPE=WORK,VOICE:${esc(l.value)}`);
        break;
      case "companyPhone":
        out.push(`TEL;TYPE=MAIN:${esc(l.value)}`);
        break;
      case "mobile":
      case "whatsapp":
        out.push(`TEL;TYPE=CELL:${esc(l.value)}`);
        break;
      case "email":
        out.push(`EMAIL;TYPE=WORK,INTERNET:${esc(l.value)}`);
        break;
      case "branchAddress":
      case "address":
        out.push(`ADR;TYPE=WORK:;;${esc(l.value)};;;;`);
        break;
      case "website":
      case "linkedin":
      case "calendar":
        if (l.href) out.push(`URL:${esc(l.href)}`);
        break;
    }
  }
  if (card.about) out.push(`NOTE:${esc(card.about)}`);
  out.push(`URL:${esc(url)}`);
  if (photo) out.push(`PHOTO;ENCODING=b;TYPE=${photo.mime.replace("image/", "").toUpperCase()}:${photo.base64}`);
  out.push("END:VCARD");
  // RFC 6350/2426 lines end CRLF; long lines are folded at 75 octets.
  return out.map(fold).join("\r\n") + "\r\n";
}

/** Folds at 75 octets, between characters — never inside one, so a name in Devanagari or an emoji survives. */
function fold(lineText: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(lineText).length <= 75) return lineText;
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of lineText) {
    const size = encoder.encode(ch).length;
    // The first line holds 75 octets; continuation lines start with a space, so 74 more.
    const limit = chunks.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  chunks.push(current);
  return chunks.map((c, i) => (i === 0 ? c : ` ${c}`)).join("\r\n");
}

/** A file name for the vCard: "Priya Sharma.vcf", nothing a header could choke on. */
export function vcardFileName(name: string): string {
  const safe = name.replace(/[^\p{L}\p{N} .-]/gu, "").trim().slice(0, 60);
  return `${safe || "contact"}.vcf`;
}

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_FIELD_LENGTH) : "";
}
