import { leadMasker, maskCustomValues, resolveFieldPolicies, type FieldMasker } from "@/lib/authz/fields";
import { revealedToday } from "@/lib/authz/unmask";
import { visibility } from "@/lib/authz/field-policy";

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
  company?: ({ name?: string | null } & object) | null;
  contact?: (ContactShape & object) | null;
};

/**
 * A lead as one person may see it: its name, description, source, company name and contact masked or
 * restricted as their field access says. Takes any shape and touches only the keys it has, so a read
 * path masks what it selected and nothing it didn't.
 */
export function maskLead<T extends object>(m: FieldMasker, lead: T): T {
  if (!m.active) return lead;
  const out = { ...lead } as T & LeadShape;
  if ("title" in out && out.title != null) out.title = m.present("title", out.title) ?? "";
  if ("description" in out) out.description = out.description == null && m.visibility("description") === "clear" ? out.description : m.present("description", out.description);
  if ("source" in out && out.source != null) out.source = m.present("source", out.source);
  // The particulars go with the source: shown with it, or not at all.
  if ("sourceDetail" in out && m.visibility("source") !== "clear") out.sourceDetail = null;
  if (out.company && "name" in out.company) out.company = { ...out.company, name: m.present("companyName", out.company.name) ?? "" };
  if (out.contact) out.contact = maskContact(m, out.contact);
  return out;
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
