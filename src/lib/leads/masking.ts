import { leadMasker, maskCustomValues, resolveFieldPolicies, type FieldMasker } from "@/lib/authz/fields";
import { revealedToday } from "@/lib/authz/unmask";
import { visibility } from "@/lib/authz/field-policy";
import { db } from "@/lib/db";

/**
 * Field access applied to leads — the one place a lead's values are turned into what one person may
 * see of them, so every read path masks the same way (src/lib/authz/field-policy.ts says what the
 * answers mean).
 *
 *   · Lists, boards, pickers, search, dashboards, reports, exports and related-record previews use
 *     the list answers: `listLeadMasker`.
 *   · The lead's own page uses the detail answers, and shows a field it may unmask in the clear once
 *     the lead has been unmasked today: `detailLeadMasker`. Unmasking itself — the count, the limit,
 *     the log — is src/actions/lead-unmask.ts; this only reads whether it happened.
 *
 * Everything here runs on the server, before a value is put in a response. Nothing is masked in the
 * browser: a value somebody may not see is never sent to it.
 */

export type { FieldMasker } from "@/lib/authz/fields";

/** For every place that lists leads. */
export function listLeadMasker(userId: string): Promise<FieldMasker> {
  return leadMasker(userId, "list");
}

export type DetailLeadMasker = FieldMasker & {
  /** Fields this person doesn't see in the clear on this lead right now. */
  concealed: string[];
  /** Fields masked here that this person may unmask — what opening the lead reveals. */
  revealable: string[];
  /** Whether they unmasked this lead today, so its revealable fields show in the clear. */
  revealed: boolean;
  /** Whether a field is one they can't change, because they can't see what it holds. */
  locked(field: string): boolean;
};

/** For one lead's own page: the detail answers, with today's unmasking honoured. */
export async function detailLeadMasker(userId: string, leadId: string): Promise<DetailLeadMasker> {
  const base = await leadMasker(userId, "detail");
  if (!base.active) {
    return { ...base, concealed: [], revealable: [], revealed: false, locked: () => false };
  }
  const resolved = await resolveFieldPolicies(userId, "leads");
  const concealedHere = [...resolved.fields.values()].filter((f) => visibility(f.policy, "detail") !== "clear");
  const revealable = concealedHere.filter((f) => visibility(f.policy, "detail") === "masked" && f.policy.unmask).map((f) => f.field.key);
  const revealed = revealable.length > 0 && (await revealedToday(userId, leadId));
  const clearNow = new Set(revealed ? revealable : []);
  const concealed = concealedHere.map((f) => f.field.key).filter((k) => !clearNow.has(k));
  return {
    ...base,
    concealed,
    revealable,
    revealed,
    visibility: (field) => (clearNow.has(field) ? "clear" : base.visibility(field)),
    present: (field, value) => (clearNow.has(field) ? (value ?? null) : base.present(field, value)),
    locked: (field) => concealed.includes(field),
  };
}

type ContactShape = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  emailCheckedValue?: string | null;
  emailCheckDetail?: string | null;
};

type LeadShape = {
  title?: string | null;
  description?: string | null;
  source?: string | null;
  sourceDetail?: string | null;
  lostReason?: string | null;
  assignmentNote?: string | null;
  company?: ({ name?: string | null } & object) | null;
  contact?: (ContactShape & object) | null;
};

/** The lead's own free text, which quotes its fields as often as not ("Redwood Infra LLP: intranet build"). */
const FREE_TEXT = ["description", "sourceDetail", "lostReason", "assignmentNote"] as const;

/**
 * A lead as one person may see it: its name, description, source, company name and contact masked or
 * restricted as their field access says, and those values masked in its own free text too. Takes any
 * shape and touches only the keys it has, so a read path masks what it selected and nothing it didn't.
 */
export function maskLead<T extends object>(m: FieldMasker, lead: T, secrets?: Array<[field: string, value: string | null | undefined]>): T {
  if (!m.active) return lead;
  // The values its free text is checked for: given by `maskLeads`, which reads them whole, or else what
  // the row itself carries.
  const redact = leadRedactor(m, secrets ?? leadSecrets(lead as LeadShape));
  const out = { ...lead } as T & LeadShape & { customFields?: unknown };
  for (const key of FREE_TEXT) if (key in out && typeof out[key] === "string") out[key] = redact(out[key]);
  // A row read whole carries its custom field values too, whether or not the screen shows them.
  if (out.customFields && typeof out.customFields === "object" && !Array.isArray(out.customFields)) out.customFields = maskCustomValues(m, out.customFields as Record<string, unknown>);
  if ("title" in out && out.title != null) out.title = m.present("title", out.title) ?? "";
  if ("description" in out) out.description = out.description == null && m.visibility("description") === "clear" ? out.description : m.present("description", out.description);
  if ("source" in out && out.source != null) out.source = m.present("source", out.source);
  // The particulars go with the source: shown with it, or not at all.
  if ("sourceDetail" in out && m.visibility("source") !== "clear") out.sourceDetail = null;
  if (out.company && "name" in out.company) out.company = { ...out.company, name: m.present("companyName", out.company.name) ?? "" };
  if (out.contact) out.contact = maskContact(m, out.contact);
  return out;
}

/**
 * Rows of leads as one person may see them — `maskLead` on each, with each lead's own values read whole
 * first when the rows carry free text, so a description that quotes the contact's phone is masked even
 * where the row itself was read without the phone (as a list's rows are: their contact is a name).
 */
export async function maskLeads<T extends { id: string } & object>(m: FieldMasker, rows: T[]): Promise<T[]> {
  if (!m.active || rows.length === 0) return rows;
  const quotes = rows.some((r) => FREE_TEXT.some((key) => typeof (r as Record<string, unknown>)[key] === "string"));
  if (!quotes) return rows.map((r) => maskLead(m, r));
  const found = await db.lead.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    select: {
      id: true,
      title: true,
      contact: { select: { name: true, email: true, phone: true } },
      company: { select: { name: true, locations: { select: { address: true, city: true, state: true, pincode: true, country: true, isPrimary: true } } } },
    },
  });
  const secrets = new Map(found.map((l) => [l.id, leadSecrets(l)]));
  return rows.map((r) => maskLead(m, r, secrets.get(r.id)));
}

/** A lead's contact as one person may see it — name, email and phone, and what reveals them. */
export function maskContact<C extends ContactShape & object>(m: FieldMasker, contact: C): C {
  if (!m.active) return contact;
  const c = { ...contact };
  if ("name" in c && c.name != null) c.name = m.present("contactName", c.name) ?? "";
  if ("email" in c) c.email = c.email == null && m.visibility("email") === "clear" ? c.email : m.present("email", c.email);
  if ("phone" in c) c.phone = c.phone == null && m.visibility("phone") === "clear" ? c.phone : m.present("phone", c.phone);
  // What would give the address away by another door: the last address checked, and the profile link.
  if (m.visibility("email") !== "clear") {
    if ("emailCheckedValue" in c) c.emailCheckedValue = null;
    if ("emailCheckDetail" in c) c.emailCheckDetail = null;
    if ("linkedinUrl" in c) c.linkedinUrl = null;
  }
  return c;
}

/** A lead's title alone — for the previews elsewhere that name a lead (a task, a visit, a call). */
export function maskLeadTitle(m: FieldMasker, title: string): string;
export function maskLeadTitle(m: FieldMasker, title: string | null | undefined): string | null;
export function maskLeadTitle(m: FieldMasker, title: string | null | undefined): string | null {
  if (!m.active || title == null) return title ?? null;
  return m.present("title", title);
}

/** Every `lead` relation in a list of rows, title masked: `{ lead: { title } }` from a task, visit or call. */
export function maskLeadRefs<T extends { lead?: ({ title?: string | null } & object) | null }>(m: FieldMasker, rows: T[]): T[] {
  if (!m.active) return rows;
  return rows.map((row) => (row.lead && "title" in row.lead ? { ...row, lead: { ...row.lead, title: maskLeadTitle(m, row.lead.title) } } : row));
}

/** A lead's custom field values, masked or left out as field access says. */
export function maskLeadCustomValues<V extends Record<string, unknown>>(m: FieldMasker, values: V): V {
  return maskCustomValues(m, values);
}

/** A company location as the one line a lead's page names it by. */
export function addressLine(location: { address?: string | null; city?: string | null; state?: string | null; pincode?: string | null; country?: string | null } | null | undefined): string | null {
  if (!location) return null;
  const line = [location.address, location.city, location.state, location.pincode, location.country].map((p) => p?.trim()).filter(Boolean).join(", ");
  return line || null;
}

/**
 * Replaces a lead's concealed values wherever they turn up in text people wrote about it.
 *
 * Masking a field doesn't mask what was written with it: "Meeting held — Kinetic Logistics — AutoCAD
 * renewal", an activity's note, a task's or a visit's title, a document's customer line. On the lead's
 * own page those are shown alongside the masked fields, so each concealed value is swapped, wherever it
 * appears and in any case, for what this person may see of it. Values shorter than three characters are
 * left alone (they'd match too much to mean anything), and a value they see in the clear is not a
 * secret here. Text written elsewhere and shown elsewhere (notifications, the wins wall, the calendar)
 * is not covered: see docs/field-access.md.
 *
 * `deep` does the same to every string in a row or list of rows, which is how whole rows a page sends
 * on are covered without naming each field.
 */
export type TextRedactor = {
  (text: string): string;
  (text: string | null | undefined): string | null;
  deep<T>(value: T): T;
  /** Whether anything on this lead needs redacting at all. */
  active: boolean;
};

export function leadRedactor(m: FieldMasker, values: Array<[field: string, value: string | null | undefined]>): TextRedactor {
  const swaps = new Map<string, string>();
  if (m.active) {
    for (const [field, raw] of values) {
      const value = raw?.trim();
      if (!value || value.length < 3) continue;
      const shown = m.present(field, value) ?? "";
      if (shown !== value) swaps.set(value.toLowerCase(), shown);
    }
  }
  // Longest first, so "Kinetic Logistics & Co" is replaced whole before "Kinetic Logistics" could be.
  const pattern = swaps.size ? new RegExp([...swaps.keys()].sort((a, b) => b.length - a.length).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi") : null;
  const one = (text: string | null | undefined) => (text == null || pattern === null ? (text ?? null) : text.replace(pattern, (hit) => swaps.get(hit.toLowerCase()) ?? hit));
  const deep = <T,>(value: T): T => {
    if (pattern === null || value == null) return value;
    if (typeof value === "string") return one(value) as T;
    if (Array.isArray(value)) return value.map((v) => deep(v)) as T;
    if (value instanceof Date || typeof value !== "object") return value;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)])) as T;
  };
  return Object.assign(one, { deep, active: pattern !== null }) as TextRedactor;
}

/** The redactor for one lead's own page, from its stored values — see `leadRedactor`. */
export async function redactorForLead(userId: string, leadId: string, masker?: DetailLeadMasker): Promise<TextRedactor> {
  const m = masker ?? (await detailLeadMasker(userId, leadId));
  if (!m.active || m.concealed.length === 0) return leadRedactor(m, []);
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: {
      title: true,
      contact: { select: { name: true, email: true, phone: true } },
      company: { select: { name: true, locations: { select: { address: true, city: true, state: true, pincode: true, country: true, isPrimary: true } } } },
    },
  });
  if (!lead) return leadRedactor(m, []);
  return leadRedactor(m, leadSecrets(lead));
}

/** The values of a lead that its page's text may quote, by the field that guards each. */
export function leadSecrets(lead: {
  title?: string | null;
  contact?: { name?: string | null; email?: string | null; phone?: string | null } | null;
  company?: { name?: string | null; locations?: Array<{ address?: string | null; city?: string | null; state?: string | null; pincode?: string | null; country?: string | null; isPrimary?: boolean }> } | null;
}): Array<[string, string | null | undefined]> {
  const locations = lead.company?.locations ?? [];
  const primary = locations.find((l) => l.isPrimary) ?? locations[0] ?? null;
  return [
    ["title", lead.title],
    ["companyName", lead.company?.name],
    ["contactName", lead.contact?.name],
    ["email", lead.contact?.email],
    ["phone", lead.contact?.phone],
    ["address", addressLine(primary)],
    ["address", primary?.address],
  ];
}

/**
 * Celebrations raised by a won deal quote it — "₹32.3 lakh won — Granite Technologies LLP", "Akash
 * closed “Laptop refresh — 40 units”" — and are shown to everybody: on the splash, the greeting strip
 * and the wins wall. Each is masked for the person looking, with the lead it names (`details.leadId`)
 * as it is now and their list answers, the way a list shows that lead. Wins about something else — a
 * customer's first order, a target — are left as they are: a customer is not a lead.
 */
export async function maskDealWins<T extends { title: string; message: string | null; details?: unknown }>(userId: string, rows: T[]): Promise<T[]> {
  const leadIdOf = (row: T) => {
    const d = row.details;
    return d && typeof d === "object" && "leadId" in d && typeof (d as { leadId: unknown }).leadId === "string" ? (d as { leadId: string }).leadId : null;
  };
  const ids = [...new Set(rows.map(leadIdOf).filter((id): id is string => id !== null))];
  if (ids.length === 0) return rows;
  const m = await listLeadMasker(userId);
  if (!m.active) return rows;
  const leads = await db.lead.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, contact: { select: { name: true, email: true, phone: true } }, company: { select: { name: true } } },
  });
  const redactors = new Map(leads.map((l) => [l.id, leadRedactor(m, leadSecrets(l))]));
  return rows.map((row) => {
    const id = leadIdOf(row);
    const redact = id ? redactors.get(id) : undefined;
    return redact ? { ...row, title: redact(row.title), message: redact(row.message) } : row;
  });
}
