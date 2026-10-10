import { z } from "zod";
import { newLeadStage } from "@/lib/pipeline/server";
import { Prisma, type ContactDesignation, type LeadSource } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/company-name";
import { isResellerManaged } from "@/lib/reseller";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { formatLeadId } from "@/lib/order-id";
import { companyPath, leadPath } from "@/lib/record-links";
import { chooseOwner } from "@/lib/leads/assign";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { postalCodeIssue } from "@/lib/geo/postal";
import { isIndia } from "@/lib/geo/countries";
import { describeValues, stillToFillLines, type SkippedValue } from "@/lib/custom-fields/outside";
import { customFieldsFromOutside, type OutsideFields } from "@/lib/custom-fields/outside-server";
import { MAX_OWN_FIELDS, type OwnFieldGroupName } from "@/lib/lead-capture/spec";

/**
 * A website enquiry, turned into a company, a contact and a lead.
 *
 * The API route authenticates and rate-limits; everything about *what the request means* is here,
 * so it can be exercised without HTTP.
 *
 * ## The rules it keeps
 *
 *   · **No duplicate companies.** Matched by `normalizedName`, the same global rule every other path
 *     follows. A website cannot be the one thing that gets round it.
 *   · **No duplicate people.** An existing contact at that company is matched by email, then phone.
 *   · **No duplicate leads on retry.** `external_id` plus the key is unique; a second request with the
 *     same pair returns the first lead.
 *   · **Resellers' customers are not ours to approach.** A company managed by a reseller gets no
 *     contact and no lead — the enquiry is passed to whoever manages the reseller, to route.
 *   · **No marketing consent.** An API call proves nothing about who owns the address it carries, so
 *     unlike a signed-up form it records no consent at all.
 *   · **The workspace's own fields, only into what it creates.** `custom_fields` go on the new lead;
 *     `company_fields` and `contact_fields` only on a company or contact this enquiry creates — a
 *     website never changes a customer already on file (src/lib/custom-fields/outside.ts). A value
 *     that can't be used is set aside, listed in the answer and noted on the lead; it never costs the
 *     lead itself. Required fields are not required here: the lead says what is still to fill in.
 */

const text = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

/**
 * The workspace's own fields, by key. Only the shape is checked here: each value is checked on its
 * own in `intakeLead`, where one that can't be used is set aside instead of refusing the whole lead.
 */
const ownFields = (name: OwnFieldGroupName) =>
  z
    .record(z.string(), z.unknown(), { error: `${name} should be an object of field keys and values` })
    .refine((v) => Object.keys(v).length <= MAX_OWN_FIELDS, `${name} can name at most ${MAX_OWN_FIELDS} fields`)
    .optional();

export const leadPayloadSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(120),
    email: z.string().trim().toLowerCase().email("email is not a valid address").max(200).optional().or(z.literal("")),
    phone: text(20),
    company: text(160),
    designation: text(80),
    city: text(80),
    state: text(80),
    pincode: text(12),
    country: text(60),
    message: text(5000),
    product_interest: text(200),
    products: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    quantity: z.coerce.number().int().positive().max(100_000).optional(),
    budget: z.coerce.number().nonnegative().max(1_000_000_000).optional(),
    source: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .pipe(z.enum(LEAD_SOURCE_VALUES))
      .optional(),
    page_url: z.string().trim().url("page_url is not a URL").max(500).optional().or(z.literal("")),
    utm_source: text(100),
    utm_medium: text(100),
    utm_campaign: text(100),
    external_id: text(100),
    custom_fields: ownFields("custom_fields"),
    company_fields: ownFields("company_fields"),
    contact_fields: ownFields("contact_fields"),
  })
  .superRefine((v, ctx) => {
    if (!v.email && !v.phone) ctx.addIssue({ code: "custom", path: ["email"], message: "email or phone is required" });
    const postal = postalCodeIssue(v.country, v.pincode);
    if (postal) ctx.addIssue({ code: "custom", path: ["pincode"], message: postal });
  });

export type LeadPayload = z.infer<typeof leadPayloadSchema>;

/** Every field the validator accepts — `check:leads` compares this with the documentation. */
export const ACCEPTED_FIELDS = Object.keys(leadPayloadSchema.shape);

const OWN_FIELD_NAME = /^(custom_fields|company_fields|contact_fields)\[([^[\]]+)\](\[\])?$/;

/**
 * A plain HTML form's body, read into the shape a JSON body has. A form cannot send an array or an
 * object, so `products` comes as "SKU1,SKU2" and the workspace's own fields as `custom_fields[tower]`;
 * a field named twice, or as `custom_fields[regions][]`, is a list. Later values of any other name
 * replace earlier ones, as they always did.
 */
export function readFormBody(raw: string): Record<string, unknown> {
  const plain: [string, string][] = [];
  const own = new Map<string, Map<string, { values: string[]; list: boolean }>>();
  for (const [name, value] of new URLSearchParams(raw)) {
    const match = OWN_FIELD_NAME.exec(name);
    if (!match) {
      plain.push([name, value]);
      continue;
    }
    const [, group = "", key = "", brackets] = match;
    const fields = own.get(group) ?? new Map<string, { values: string[]; list: boolean }>();
    own.set(group, fields);
    const field = fields.get(key) ?? { values: [], list: false };
    fields.set(key, { values: [...field.values, value], list: field.list || brackets === "[]" || field.values.length > 0 });
  }
  // Built with fromEntries, so a key like `__proto__` is just a key — reported as one no field has.
  const body: Record<string, unknown> = Object.fromEntries(plain);
  for (const [group, fields] of own) {
    body[group] = Object.fromEntries([...fields].map(([key, f]) => [key, f.list ? f.values : f.values[0]]));
  }
  if (typeof body.products === "string") body.products = body.products.split(",").map((s) => s.trim()).filter(Boolean);
  return body;
}

/**
 * A job title, as people type it, read into the CRM's designations.
 *
 * Order matters: "IT head" is checked before "head", and "chief information officer" before
 * "chief", so the more specific reading wins.
 */
export function designationFromTitle(title: string | undefined): ContactDesignation {
  const t = ` ${(title ?? "").toLowerCase()} `;
  if (/\b(cio|cto|chief (information|technology|digital))/.test(t)) return "CIO";
  if (/\b(ceo|chief executive|managing director|founder|co-founder|proprietor|owner)\b|\bmd\b/.test(t)) return "CEO";
  if (/\b(it|technology|infra\w*|systems?)\s*head\b|\bhead\b.*\b(it|technology|infra\w*|systems?)\b/.test(t)) return "IT_HEAD";
  if (/\b(director|vp|vice president|head)\b/.test(t)) return "DIRECTOR";
  if (/\b(it|system|systems|network)\s*(manager|admin\w*|executive|engineer|officer)\b|\bsysadmin\b/.test(t)) return "IT_MANAGER";
  if (/\b(purchase|procurement|buyer|buying|sourcing)\b/.test(t)) return "PURCHASE_MANAGER";
  if (/\bhr\b|human resource/.test(t)) return "HR";
  return "OTHER";
}

/** Addresses at these domains are people, not companies — never use one as a company name. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "outlook.com", "hotmail.com",
  "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "rediffmail.com", "proton.me", "protonmail.com",
  "zoho.com", "zohomail.in", "ymail.com", "mail.com", "gmx.com",
]);

export function companyNameFor(p: Pick<LeadPayload, "company" | "email" | "name">): string {
  if (p.company) return p.company;
  const domain = p.email?.split("@")[1]?.toLowerCase();
  if (domain && !FREE_MAIL.has(domain)) return domain;
  return `${p.name} (individual)`;
}

/** One of the workspace's own fields' values that was set aside: `custom_fields.floor`, and why. */
export type NotSaved = { field: string; reason: string };

export type IntakeResult =
  | { status: "created"; leadId: string; reference: string; assigned: boolean; notSaved: NotSaved[] }
  | { status: "duplicate"; leadId: string; reference: string }
  | { status: "reseller" };

type SetAside = { group: OwnFieldGroupName; skipped: SkippedValue };

const RECORD_OF: Record<OwnFieldGroupName, string> = { custom_fields: "lead", company_fields: "company", contact_fields: "contact" };

/** The values set aside, as the lead's description notes them for whoever picks it up. */
function setAsideNote(items: SetAside[]): string | null {
  if (items.length === 0) return null;
  const lines = items.map(({ group, skipped: s }) => {
    if (!s.label) return `· ${group}.${s.key} isn't one of the fields a website can fill.`;
    const whose = group === "custom_fields" ? "" : `For the ${RECORD_OF[group]}: `;
    const sent = s.value && !s.reason.includes(`“${s.value}”`) ? ` It was “${s.value}”.` : "";
    return `· ${whose}${s.reason}${sent}`;
  });
  return ["Not saved from the website:", ...lines].join("\n");
}

/** What was sent for a company or contact already on file — not written to it, but not lost either. */
function onFileNote(record: string, own: OutsideFields): string | null {
  const given = describeValues(own.defs, own.values);
  return given.length ? `Sent for the ${record}, which was already on file, so not saved to it: ${given.join(" · ")}` : null;
}

/**
 * What an enquiry came through: a website's capture key — or, with no key (`id: null`), somebody's
 * digital card (src/lib/cards), whose holder is `createdById`.
 */
export type IntakeSource = { id: string | null; name: string; sourceLabel: string | null; createdById: string | null };

export type IntakeOptions = {
  /**
   * The lead goes to this person rather than through the assignment rules: a card's holder, who met
   * them. The rules would hand a contact somebody made in person to whoever covers the region.
   */
  ownerUserId?: string;
  /** In place of "<product> — <company>". */
  leadTitle?: string;
  /** What the owner is told, in place of "A website lead was assigned to you". */
  notifyTitle?: string;
};

export async function intakeLead(key: IntakeSource, p: LeadPayload, options: IntakeOptions = {}): Promise<IntakeResult> {
  // A retry of something already received. Only a key makes a retry recognisable.
  if (p.external_id && key.id) {
    const existing = await db.lead.findUnique({
      where: { captureKeyId_externalId: { captureKeyId: key.id, externalId: p.external_id } },
      select: { id: true, leadSeq: true },
    });
    if (existing) return { status: "duplicate", leadId: existing.id, reference: formatLeadId(existing.leadSeq) };
  }

  // Somebody to credit for anything created — the person who issued the key, or failing that the
  // super admin. A company must have a creator, and "the website" is not a user.
  const actorId =
    key.createdById ?? (await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } }))?.id;
  if (!actorId) throw new Error("No user to attribute website leads to.");

  const companyName = companyNameFor(p);
  const normalizedName = normalizeCompanyName(companyName);
  const existingCompany = await db.company.findUnique({
    where: { normalizedName },
    select: { id: true, companySeq: true, name: true, ownerUserId: true, managedByResellerId: true, managedByReseller: { select: { name: true, ownerUserId: true } } },
  });

  if (existingCompany && isResellerManaged(existingCompany)) {
    const routeTo = existingCompany.managedByReseller?.ownerUserId ?? actorId;
    await notifyUser({
      userId: routeTo,
      type: "LEAD_ASSIGNED",
      title: `A website enquiry for ${existingCompany.name} — a customer of ${existingCompany.managedByReseller?.name ?? "a reseller"}`,
      message: [p.name, p.email, p.phone, p.message].filter(Boolean).join(" · ").slice(0, 500),
      link: companyPath(existingCompany.companySeq),
    });
    return { status: "reseller" };
  }

  // The workspace's own fields, each value checked on its own. Read now; written only into the
  // records the transaction below creates.
  const [leadOwn, companyOwn, contactOwn] = await Promise.all([
    customFieldsFromOutside("LEAD", p.custom_fields),
    customFieldsFromOutside("COMPANY", p.company_fields),
    customFieldsFromOutside("CONTACT", p.contact_fields),
  ]);
  const setAside: SetAside[] = [
    ...leadOwn.skipped.map((skipped) => ({ group: "custom_fields" as const, skipped })),
    ...companyOwn.skipped.map((skipped) => ({ group: "company_fields" as const, skipped })),
    ...contactOwn.skipped.map((skipped) => ({ group: "contact_fields" as const, skipped })),
  ];

  // What the assignment rules look at.
  const items = p.products?.length
    ? await db.item.findMany({ where: { sku: { in: p.products, mode: "insensitive" } }, select: { id: true, sku: true, brandId: true, type: true } })
    : [];
  const unknownSkus = (p.products ?? []).filter((sku) => !items.some((i) => i.sku.toLowerCase() === sku.toLowerCase()));
  const designation = designationFromTitle(p.designation);
  const source: LeadSource = p.source ?? "WEBSITE";
  const owner = options.ownerUserId
    ? { userId: options.ownerUserId, note: `Shared back from ${key.name}.` }
    : await chooseOwner({
        brandIds: [...new Set(items.map((i) => i.brandId).filter((b): b is string => !!b))],
        itemTypes: [...new Set(items.map((i) => i.type))],
        designation,
        source,
        state: p.state || null,
        companyOwnerId: existingCompany?.ownerUserId ?? null,
      });

  const sourceDetail = [
    key.sourceLabel || key.name,
    p.page_url,
    [p.utm_source, p.utm_medium, p.utm_campaign].some(Boolean) ? `utm ${[p.utm_source, p.utm_medium, p.utm_campaign].filter(Boolean).join(" / ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 300);

  // Which of the company and contact are new is known only inside the transaction, and the
  // description says different things for each.
  const describe = (made: { company: boolean; contact: boolean }) =>
    [
      p.message,
      p.designation ? `Designation given: ${p.designation}` : null,
      unknownSkus.length ? `Products asked for that are not in the catalogue: ${unknownSkus.join(", ")}` : null,
      setAsideNote(setAside),
      made.company ? null : onFileNote("company", companyOwn),
      made.contact ? null : onFileNote("contact", contactOwn),
      ...stillToFillLines({
        LEAD: leadOwn.missing,
        COMPANY: made.company ? companyOwn.missing : [],
        CONTACT: made.contact ? contactOwn.missing : [],
      }),
    ]
      .filter(Boolean)
      .join("\n\n");

  let created: { id: string; leadSeq: number };
  try {
    // Where the lead starts (src/lib/pipeline) — read before the transaction, which holds a connection.
    const entry = await newLeadStage();
    created = await db.$transaction(async (tx) => {
      const company =
        existingCompany ??
        (await tx.company.create({
          data: {
            name: companyName,
            normalizedName,
            source: "INBOUND",
            stage: "LEAD",
            createdById: actorId,
            ownerUserId: owner?.userId ?? null,
            locations: {
              create: {
                label: "Head Office",
                city: p.city || null,
                state: p.state || null,
                pincode: p.pincode || null,
                country: p.country || null,
                gstTreatment: isIndia(p.country) ? "UNREGISTERED" : "OVERSEAS",
                isPrimary: true,
                isBilling: true,
                isShipping: true,
              },
            },
            ...companyOwn.data,
          },
          select: { id: true },
        }));

      const matched =
        (p.email ? await tx.contact.findFirst({ where: { companyId: company.id, email: p.email }, select: { id: true } }) : null) ??
        (p.phone ? await tx.contact.findFirst({ where: { companyId: company.id, phone: p.phone }, select: { id: true } }) : null);
      const contact =
        matched ??
        (await tx.contact.create({
          data: {
            companyId: company.id,
            name: p.name,
            email: p.email || null,
            phone: p.phone || null,
            designation,
            createdByUserId: actorId,
            ...contactOwn.data,
          },
          select: { id: true },
        }));

      const description = describe({ company: !existingCompany, contact: !matched });
      return tx.lead.create({
        data: {
          companyId: company.id,
          contactId: contact.id,
          title: (options.leadTitle ?? `${p.product_interest || "Website enquiry"} — ${companyName}`).slice(0, 200),
          description: description || null,
          ...entry,
          estimatedValue: p.budget ?? null,
          source,
          sourceDetail: sourceDetail || null,
          ownerUserId: owner?.userId ?? null,
          assignmentNote: owner?.note ?? null,
          sourcedByUserId: actorId,
          createdByUserId: actorId,
          captureKeyId: key.id,
          externalId: key.id ? p.external_id || null : null,
          requirements: { create: items.map((i) => ({ itemId: i.id, quantity: p.quantity ?? 1 })) },
          ...leadOwn.data,
        },
        select: { id: true, leadSeq: true },
      });
    });
  } catch (error) {
    // Two copies of one request racing: the unique index let exactly one through. Answer the other
    // with the lead that won, as a duplicate — which is what it is.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && p.external_id && key.id) {
      const winner = await db.lead.findUnique({
        where: { captureKeyId_externalId: { captureKeyId: key.id, externalId: p.external_id } },
        select: { id: true, leadSeq: true },
      });
      if (winner) return { status: "duplicate", leadId: winner.id, reference: formatLeadId(winner.leadSeq) };
    }
    throw error;
  }

  await refreshLeadScore(created.id);
  if (owner) {
    await notifyUser({
      userId: owner.userId,
      type: "LEAD_ASSIGNED",
      title: options.notifyTitle ?? "A website lead was assigned to you",
      message: options.leadTitle ?? `${p.product_interest || "Website enquiry"} — ${companyName}`,
      link: leadPath(created.leadSeq),
    });
  }
  await recordAudit({
    userId: actorId,
    action: "CREATE",
    entityType: "Lead",
    entityId: created.id,
    entityLabel: key.id ? `Website lead via “${key.name}”` : `Lead from ${key.name}`,
  });

  return {
    status: "created",
    leadId: created.id,
    reference: formatLeadId(created.leadSeq),
    assigned: Boolean(owner),
    notSaved: setAside.map(({ group, skipped }) => ({ field: `${group}.${skipped.key}`, reason: skipped.reason })),
  };
}
