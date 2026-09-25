import { z } from "zod";
import { Prisma, type ContactDesignation, type LeadCaptureKey, type LeadSource } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/company-name";
import { isResellerManaged } from "@/lib/reseller";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { formatLeadId } from "@/lib/order-id";
import { chooseOwner } from "@/lib/leads/assign";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { postalCodeIssue } from "@/lib/geo/postal";
import { isIndia } from "@/lib/geo/countries";

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
 */

const text = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));

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
  })
  .superRefine((v, ctx) => {
    if (!v.email && !v.phone) ctx.addIssue({ code: "custom", path: ["email"], message: "email or phone is required" });
    const postal = postalCodeIssue(v.country, v.pincode);
    if (postal) ctx.addIssue({ code: "custom", path: ["pincode"], message: postal });
  });

export type LeadPayload = z.infer<typeof leadPayloadSchema>;

/** Every field the validator accepts — `check:leads` compares this with the documentation. */
export const ACCEPTED_FIELDS = Object.keys(leadPayloadSchema.shape);

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

export type IntakeResult =
  | { status: "created"; leadId: string; reference: string; assigned: boolean }
  | { status: "duplicate"; leadId: string; reference: string }
  | { status: "reseller" };

export async function intakeLead(key: Pick<LeadCaptureKey, "id" | "name" | "sourceLabel" | "createdById">, p: LeadPayload): Promise<IntakeResult> {
  // A retry of something already received.
  if (p.external_id) {
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
    select: { id: true, name: true, ownerUserId: true, managedByResellerId: true, managedByReseller: { select: { name: true, ownerUserId: true } } },
  });

  if (existingCompany && isResellerManaged(existingCompany)) {
    const routeTo = existingCompany.managedByReseller?.ownerUserId ?? actorId;
    await notifyUser({
      userId: routeTo,
      type: "LEAD_ASSIGNED",
      title: `A website enquiry for ${existingCompany.name} — a customer of ${existingCompany.managedByReseller?.name ?? "a reseller"}`,
      message: [p.name, p.email, p.phone, p.message].filter(Boolean).join(" · ").slice(0, 500),
      link: `/companies/${existingCompany.id}`,
    });
    return { status: "reseller" };
  }

  // What the assignment rules look at.
  const items = p.products?.length
    ? await db.item.findMany({ where: { sku: { in: p.products, mode: "insensitive" } }, select: { id: true, sku: true, brandId: true, type: true } })
    : [];
  const unknownSkus = (p.products ?? []).filter((sku) => !items.some((i) => i.sku.toLowerCase() === sku.toLowerCase()));
  const designation = designationFromTitle(p.designation);
  const source: LeadSource = p.source ?? "WEBSITE";
  const owner = await chooseOwner({
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

  const description = [
    p.message,
    p.designation ? `Designation given: ${p.designation}` : null,
    unknownSkus.length ? `Products asked for that are not in the catalogue: ${unknownSkus.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  let created: { id: string; leadSeq: number };
  try {
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
          },
          select: { id: true },
        }));

      const contact =
        (p.email ? await tx.contact.findFirst({ where: { companyId: company.id, email: p.email }, select: { id: true } }) : null) ??
        (p.phone ? await tx.contact.findFirst({ where: { companyId: company.id, phone: p.phone }, select: { id: true } }) : null) ??
        (await tx.contact.create({
          data: {
            companyId: company.id,
            name: p.name,
            email: p.email || null,
            phone: p.phone || null,
            designation,
            createdByUserId: actorId,
          },
          select: { id: true },
        }));

      return tx.lead.create({
        data: {
          companyId: company.id,
          contactId: contact.id,
          title: `${p.product_interest || "Website enquiry"} — ${companyName}`.slice(0, 200),
          description: description || null,
          status: "NEW",
          estimatedValue: p.budget ?? null,
          source,
          sourceDetail: sourceDetail || null,
          ownerUserId: owner?.userId ?? null,
          assignmentNote: owner?.note ?? null,
          sourcedByUserId: actorId,
          createdByUserId: actorId,
          captureKeyId: key.id,
          externalId: p.external_id || null,
          requirements: { create: items.map((i) => ({ itemId: i.id, quantity: p.quantity ?? 1 })) },
        },
        select: { id: true, leadSeq: true },
      });
    });
  } catch (error) {
    // Two copies of one request racing: the unique index let exactly one through. Answer the other
    // with the lead that won, as a duplicate — which is what it is.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && p.external_id) {
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
      title: "A website lead was assigned to you",
      message: `${p.product_interest || "Website enquiry"} — ${companyName}`,
      link: `/leads/${created.id}`,
    });
  }
  await recordAudit({
    userId: actorId,
    action: "CREATE",
    entityType: "Lead",
    entityId: created.id,
    entityLabel: `Website lead via “${key.name}”`,
  });

  return { status: "created", leadId: created.id, reference: formatLeadId(created.leadSeq), assigned: Boolean(owner) };
}
