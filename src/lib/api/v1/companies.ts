import { addContact, createCompany, getCompany, listCompaniesPaged, updateCompany, updateContact } from "@/actions/company";
import { listAllContactsPaged } from "@/actions/contact";
import { ApiError, notFound, pageOf, paging, refusedBy, type ApiAnswer, type ApiCall } from "@/lib/api/handler";
import { customFieldsOut } from "@/lib/api/custom";
import { companyCreateSchema, companyPatchSchema, contactCreateSchema, contactFields, contactPatchSchema } from "@/lib/api/v1/schemas";
import { needModule } from "@/lib/api/v1/shared";
import { companyRef, contactRef, idOf, iso } from "@/lib/api/refs";
import { API_DEFAULT_PAGE_SIZE, API_MAX_PAGE_SIZE } from "@/lib/api/scopes";
import { bandForCount } from "@/lib/company-size";
import { db } from "@/lib/db";
import { relationshipTypeValues } from "@/lib/validation/company";

/**
 * Companies and their contacts in the public API (src/lib/api) — through the app's own company and
 * contact actions as the key's person: the account scope, the contact-detail rules on a reseller's
 * customers, the payment-terms guard and the duplicate-name rule all apply as on the screens.
 */

type Row = Record<string, unknown> & { id: string };
const str = (v: unknown) => (typeof v === "string" ? v : null);
const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const person = (v: unknown) => {
  const p = rec(v);
  return p ? { id: p.id, name: p.name } : null;
};

/** Each company's main address — the primary, else the first. */
async function addressesOf(ids: string[]) {
  const rows = await db.companyLocation.findMany({
    where: { companyId: { in: ids } },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { companyId: true, label: true, address: true, city: true, state: true, pincode: true, country: true, gstNumber: true },
  });
  const out = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!out.has(r.companyId)) out.set(r.companyId, r);
  return out;
}

function companyOut(row: Row, address: Awaited<ReturnType<typeof addressesOf>> extends Map<string, infer V> ? V | undefined : never, custom: Record<string, unknown> | undefined) {
  const industry = rec(row.industry);
  return {
    id: row.id,
    ref: companyRef(row.companySeq as number),
    name: row.name,
    relationship_type: row.relationshipType,
    stage: row.stage ?? null,
    website: str(row.website),
    linkedin_url: str(row.linkedinUrl),
    industry: industry ? { id: industry.id, name: industry.name } : null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    source: row.source ?? null,
    payment_terms: row.paymentTerms ?? null,
    employee_count: typeof row.employeeCount === "number" ? row.employeeCount : null,
    owner: person(row.owner),
    account_manager: person(row.assignedTo),
    address: address
      ? { label: address.label, line: address.address, city: address.city, state: address.state, pincode: address.pincode, country: address.country, gstin: address.gstNumber }
      : null,
    custom_fields: custom ?? {},
    created_at: iso(row.createdAt as Date | string),
    updated_at: iso(row.updatedAt as Date | string),
  };
}

export async function companiesOut(userId: string, rows: Row[]) {
  const ids = rows.map((r) => r.id);
  const [addresses, custom] = await Promise.all([addressesOf(ids), customFieldsOut("COMPANY", userId, ids)]);
  return rows.map((r) => companyOut(r, addresses.get(r.id), custom.get(r.id)));
}

export function contactOut(row: Row, company: Record<string, unknown> | null, custom: Record<string, unknown> | undefined) {
  return {
    id: row.id,
    ref: contactRef(row.contactSeq as number),
    name: row.name,
    designation: row.designation ?? null,
    designation_name: str(row.designationName),
    email: str(row.email),
    phone: str(row.phone),
    linkedin_url: str(row.linkedinUrl),
    is_primary: row.isPrimary === true,
    receives_documents: row.receivesDocuments === true,
    left_at: iso(row.leftAt as Date | string | null),
    company: company ? { id: company.id, ref: companyRef(company.companySeq as number), name: company.name } : null,
    custom_fields: custom ?? {},
    created_at: iso(row.createdAt as Date | string),
    updated_at: iso(row.updatedAt as Date | string),
  };
}

/** One company through the screens' own read — or not found. */
export async function readCompany(userId: string, id: string) {
  const company = (await getCompany(id)) as Row | null;
  if (!company) throw notFound("company");
  const [out] = await companiesOut(userId, [company]);
  const contacts = Array.isArray(company.contacts) ? (company.contacts as Row[]) : [];
  const custom = await customFieldsOut("CONTACT", userId, contacts.map((c) => c.id));
  return { ...out!, contacts: contacts.map((c) => contactOut(c, company, custom.get(c.id))) };
}

export async function listCompaniesApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("companies", call.actor.userId, "Companies");
  const q = call.url.searchParams;
  const { page, pageSize } = paging(call.url, API_MAX_PAGE_SIZE, API_DEFAULT_PAGE_SIZE);
  const relationship = q.get("relationship_type")?.toUpperCase();
  if (relationship && !(relationshipTypeValues as readonly string[]).includes(relationship)) throw new ApiError(400, "invalid_request", `relationship_type is one of ${relationshipTypeValues.join(", ")}.`);
  const { rows, total } = await listCompaniesPaged({ page, pageSize, search: q.get("search")?.slice(0, 100) || undefined, relationshipType: relationship as (typeof relationshipTypeValues)[number] | undefined });
  return { data: await companiesOut(call.actor.userId, rows as unknown as Row[]), page: pageOf(page, pageSize, total) };
}

export async function getCompanyApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("companies", call.actor.userId, "Companies");
  const id = await idOf("company", call.params.ref);
  if (!id) throw notFound("company");
  return { data: await readCompany(call.actor.userId, id) };
}

const contactInput = (c: Partial<Record<keyof typeof contactFields, unknown>>) => ({
  name: c.name,
  designation: c.designation ?? "OTHER",
  ...(c.designation_name !== undefined ? { designationName: c.designation_name } : {}),
  email: c.email ?? "",
  phone: c.phone ?? "",
  linkedinUrl: c.linkedin_url ?? "",
  isPrimary: c.is_primary ?? false,
  receivesDocuments: c.receives_documents ?? false,
});

export async function createCompanyApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("companies", call.actor.userId, "Companies");
  const input = companyCreateSchema.parse(await call.body());
  const a = input.address;
  const made = await createCompany({
    name: input.name,
    relationshipType: input.relationship_type ?? "CLIENT",
    website: input.website ?? "",
    linkedinUrl: input.linkedin_url ?? "",
    industryId: input.industry ?? "",
    tags: input.tags ?? [],
    source: input.source ?? "OTHER",
    paymentTerms: input.payment_terms ?? "ADVANCE",
    ...(a
      ? { location: { label: a.label || "Head Office", address: a.line ?? "", city: a.city ?? "", state: a.state ?? "", pincode: a.pincode ?? "", country: a.country ?? "", gstNumber: a.gstin ?? "", isBilling: true, isShipping: true } }
      : {}),
    contacts: (input.contacts ?? []).map(contactInput),
    customFields: input.custom_fields,
  });
  if (!made.ok) throw refusedBy(made);
  return { status: 201, data: await readCompany(call.actor.userId, made.data.id) };
}

export async function patchCompanyApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("companies", call.actor.userId, "Companies");
  const id = await idOf("company", call.params.ref);
  if (!id) throw notFound("company");
  const input = companyPatchSchema.parse(await call.body());
  // The screens' edit takes the whole set: what wasn't sent stays as it is. The action checks the account reaches the key's person.
  const now = await db.company.findUnique({
    where: { id },
    select: { name: true, industryId: true, customerCategoryId: true, companyType: true, relationshipType: true, website: true, linkedinUrl: true, employeeCount: true, paymentTerms: true, dunsNumber: true, tags: true, source: true },
  });
  if (!now) throw notFound("company");
  const done = await updateCompany({
    id,
    name: input.name ?? now.name,
    industryId: input.industry ?? now.industryId ?? "",
    customerCategoryId: now.customerCategoryId ?? "",
    companyType: now.companyType ?? "",
    relationshipType: input.relationship_type ?? now.relationshipType,
    website: input.website ?? now.website ?? "",
    linkedinUrl: input.linkedin_url ?? now.linkedinUrl ?? "",
    employeeBand: bandForCount(now.employeeCount)?.key ?? "",
    paymentTerms: input.payment_terms ?? now.paymentTerms,
    dunsNumber: now.dunsNumber ?? "",
    tags: input.tags ?? now.tags,
    source: input.source ?? now.source,
  });
  if (!done.ok) throw done.error === "Company not found." ? notFound("company") : refusedBy(done);
  return { data: await readCompany(call.actor.userId, id) };
}

// ─── Contacts ───────────────────────────────────────────────────────────────────────────────────

/** A contact through its company's read on the screens — every contact-detail rule applied — or not found. */
async function readContact(userId: string, id: string) {
  const at = await db.contact.findUnique({ where: { id }, select: { companyId: true } });
  if (!at) throw notFound("contact");
  const company = (await getCompany(at.companyId)) as Row | null;
  const contact = company && Array.isArray(company.contacts) ? (company.contacts as Row[]).find((c) => c.id === id) : undefined;
  if (!company || !contact) throw notFound("contact");
  const custom = await customFieldsOut("CONTACT", userId, [id]);
  return contactOut(contact, company, custom.get(id));
}

export async function listContactsApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("contacts_library", call.actor.userId, "Contacts");
  const { page, pageSize } = paging(call.url, API_MAX_PAGE_SIZE, API_DEFAULT_PAGE_SIZE);
  const { rows, total } = await listAllContactsPaged({ page, pageSize, search: call.url.searchParams.get("search")?.slice(0, 100) || undefined });
  const typed = rows as unknown as Row[];
  const custom = await customFieldsOut("CONTACT", call.actor.userId, typed.map((r) => r.id));
  return { data: typed.map((r) => contactOut(r, rec(r.company), custom.get(r.id))), page: pageOf(page, pageSize, total) };
}

export async function getContactApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("contacts_library", call.actor.userId, "Contacts");
  const id = await idOf("contact", call.params.ref);
  if (!id) throw notFound("contact");
  return { data: await readContact(call.actor.userId, id) };
}

export async function createContactApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("contacts_library", call.actor.userId, "Contacts");
  const input = contactCreateSchema.parse(await call.body());
  const companyId = await idOf("company", input.company);
  if (!companyId) throw new ApiError(422, "refused", "No company by that reference reaches this key.", { company: "Not found." });
  const made = await addContact(companyId, contactInput(input));
  if (!made.ok) throw refusedBy(made);
  return { status: 201, data: await readContact(call.actor.userId, made.data.id) };
}

export async function patchContactApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("contacts_library", call.actor.userId, "Contacts");
  const id = await idOf("contact", call.params.ref);
  if (!id) throw notFound("contact");
  const input = contactPatchSchema.parse(await call.body());
  // What the key's person sees of it now — a detail hidden from them is kept by the action, never cleared.
  const now = await readContact(call.actor.userId, id);
  const done = await updateContact({
    id,
    ...contactInput({
      name: input.name ?? now.name,
      designation: input.designation ?? now.designation ?? "OTHER",
      designation_name: input.designation_name ?? now.designation_name ?? undefined,
      email: input.email ?? now.email ?? "",
      phone: input.phone ?? now.phone ?? "",
      linkedin_url: input.linkedin_url ?? now.linkedin_url ?? "",
      is_primary: input.is_primary ?? now.is_primary,
      receives_documents: input.receives_documents ?? now.receives_documents,
    }),
  });
  if (!done.ok) throw refusedBy(done);
  return { data: await readContact(call.actor.userId, id) };
}
