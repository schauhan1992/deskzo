import { createHash, timingSafeEqual } from "node:crypto";
import { Prisma, type SignatureTemplate } from "@prisma/client";
import { db } from "@/lib/db";
import { digestSecret } from "@/lib/crypto";
import { getOrganisation } from "@/lib/organisation";
import { getBranding } from "@/actions/branding";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import {
  EMPTY_DETAILS,
  SIGNATURE_FONTS,
  SOCIAL_NETWORKS,
  renderSignature,
  safeColor,
  type SignatureDetails,
  type SignatureFont,
  type SignatureStyle,
  type SignatureTemplate as Layout,
  type SocialNetwork,
} from "@/lib/signatures/render";

/**
 * Deskzo Signatures on the server: which template somebody gets, and their signature drawn from it and
 * from their record — the same HTML the free generator makes, without its credit.
 */

export const RECORD_FIELDS = [
  { key: "photo", label: "Photo" },
  { key: "title", label: "Job title" },
  { key: "department", label: "Department" },
  { key: "phone", label: "Work phone" },
  { key: "email", label: "Email" },
  { key: "address", label: "Office address" },
] as const;
export type SignatureRecordField = (typeof RECORD_FIELDS)[number]["key"];

/** A new template shows everything but the department. */
export const DEFAULT_SHOWN: SignatureRecordField[] = ["photo", "title", "phone", "email", "address"];

const LAYOUTS = { CLASSIC: "classic", MODERN: "modern", STACKED: "stacked", COMPACT: "compact" } as const satisfies Record<string, Layout>;

export type TemplateSpec = {
  id: string;
  name: string;
  isDefault: boolean;
  layout: keyof typeof LAYOUTS;
  color: string;
  font: SignatureFont;
  shown: SignatureRecordField[];
  website: string;
  logoUrl: string;
  social: Record<SocialNetwork, string>;
  ctaLabel: string;
  ctaUrl: string;
  signOff: string;
  disclaimer: string;
};

export function readTemplate(row: SignatureTemplate): TemplateSpec {
  const keys = new Set<string>(RECORD_FIELDS.map((f) => f.key));
  const shown = Array.isArray(row.recordFields)
    ? (row.recordFields as unknown[]).flatMap((f) => {
        const x = f as { key?: unknown; show?: unknown };
        return typeof x?.key === "string" && keys.has(x.key) && x.show ? [x.key as SignatureRecordField] : [];
      })
    : [];
  const socialRaw = (row.social && typeof row.social === "object" && !Array.isArray(row.social) ? row.social : {}) as Record<string, unknown>;
  const social = Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n.key, typeof socialRaw[n.key] === "string" ? (socialRaw[n.key] as string) : ""])) as Record<SocialNetwork, string>;
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    layout: (row.layout in LAYOUTS ? row.layout : "CLASSIC") as keyof typeof LAYOUTS,
    color: safeColor(row.color),
    font: (row.font in SIGNATURE_FONTS ? row.font : "arial") as SignatureFont,
    shown,
    website: row.website ?? "",
    logoUrl: row.logoUrl ?? "",
    social,
    ctaLabel: row.ctaLabel ?? "",
    ctaUrl: row.ctaUrl ?? "",
    signOff: row.signOff ?? "",
    disclaimer: row.disclaimer ?? "",
  };
}

/** The default template, made the first time anybody needs one, in the workspace's brand colour. */
export async function defaultSignatureTemplate(actorId: string | null): Promise<SignatureTemplate> {
  const existing = await db.signatureTemplate.findFirst({ where: { isDefault: true } });
  if (existing) return existing;
  const branding = await getBranding();
  try {
    return await db.signatureTemplate.create({
      data: {
        name: "Company signature",
        isDefault: true,
        color: safeColor(branding.primaryColor ?? ""),
        recordFields: RECORD_FIELDS.map((f) => ({ key: f.key, show: DEFAULT_SHOWN.includes(f.key) })) as unknown as Prisma.InputJsonValue,
        createdById: actorId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return db.signatureTemplate.findFirstOrThrow({ where: { isDefault: true } });
    throw err;
  }
}

// ── Who gets which ──────────────────────────────────────────────────────────────────────────────────

export type Person = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  active: boolean;
  departmentId: string | null;
  branchId: string | null;
  photoUpdatedAt: Date | null;
  department: { name: string } | null;
  branch: { addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; pincode: string | null } | null;
  employeeProfile: { designation: string | null } | null;
};

export const PERSON_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  active: true,
  departmentId: true,
  branchId: true,
  photoUpdatedAt: true,
  department: { select: { name: true } },
  branch: { select: { addressLine1: true, addressLine2: true, city: true, state: true, pincode: true } },
  employeeProfile: { select: { designation: true } },
} as const;

type Rule = { templateId: string; target: string; targetId: string };

/** The template a person gets: their own rule, then their department's, branch's, role's — else the default. */
export function templateIdFor(person: Pick<Person, "id" | "departmentId" | "branchId" | "role">, rules: Rule[], defaultId: string): string {
  const find = (target: string, id: string | null) => (id ? rules.find((r) => r.target === target && r.targetId === id)?.templateId : undefined);
  return find("PERSON", person.id) ?? find("DEPARTMENT", person.departmentId) ?? find("BRANCH", person.branchId) ?? find("ROLE", person.role) ?? defaultId;
}

// ── The photo's public address ──────────────────────────────────────────────────────────────────────

/**
 * A signature's picture has to be an address a mail program can fetch: `<id>.<mac>` names one person's
 * photo, and the MAC — under the workspace's own key — means an address can't be made up for somebody
 * else, or for anybody whose signature doesn't show one.
 */
async function photoMac(userId: string): Promise<string> {
  return (await digestSecret(`signature-photo:${userId}`)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

export async function photoToken(userId: string): Promise<string> {
  return `${userId}.${await photoMac(userId)}`;
}

/** The person a photo address names, when its MAC is right. */
export async function userOfPhotoToken(token: string): Promise<string | null> {
  const [userId, mac] = token.split(".");
  if (!userId || !mac || !/^[a-z0-9]{10,40}$/.test(userId)) return null;
  const expected = Buffer.from(await photoMac(userId));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given) ? userId : null;
}

// ── A person's signature ────────────────────────────────────────────────────────────────────────────

function joinAddress(parts: (string | null | undefined)[]): string {
  return parts.map((p) => p?.trim()).filter(Boolean).join(", ");
}

export type PersonSignature = {
  templateId: string;
  details: SignatureDetails;
  style: SignatureStyle;
  html: string;
  /** What changes when the signature does — compared with what was last put into the mailbox. */
  hash: string;
};

/** Built once per batch: what every signature shares. */
export type SignatureContext = {
  origin: string;
  company: string;
  orgAddress: string;
  brandLogo: string | null;
  templates: Map<string, TemplateSpec>;
  rules: Rule[];
  defaultId: string;
};

export async function signatureContext(actorId: string | null = null): Promise<SignatureContext> {
  const [origin, org, branding, defaultRow, rows, rules] = await Promise.all([
    tenantOrigin(),
    getOrganisation(),
    getBranding(),
    defaultSignatureTemplate(actorId),
    db.signatureTemplate.findMany(),
    db.signatureRule.findMany({ select: { templateId: true, target: true, targetId: true } }),
  ]);
  const templates = new Map(rows.map((r) => [r.id, readTemplate(r)]));
  if (!templates.has(defaultRow.id)) templates.set(defaultRow.id, readTemplate(defaultRow));
  return {
    origin,
    company: org.tradeName?.trim() || org.legalName?.trim() || "",
    orgAddress: joinAddress([org.addressLine1, org.addressLine2, org.city, org.state, org.pincode]),
    brandLogo: branding.logoDataUrl ? `${origin}/api/brand/mark` : null,
    templates,
    rules,
    defaultId: defaultRow.id,
  };
}

export async function personSignature(person: Person, ctx: SignatureContext): Promise<PersonSignature> {
  const templateId = templateIdFor(person, ctx.rules, ctx.defaultId);
  const t = ctx.templates.get(templateId) ?? ctx.templates.get(ctx.defaultId)!;
  const show = new Set(t.shown);
  const branch = person.branch;
  const address = branch ? joinAddress([branch.addressLine1, branch.addressLine2, branch.city, branch.state, branch.pincode]) : ctx.orgAddress;
  const details: SignatureDetails = {
    ...EMPTY_DETAILS,
    name: person.name,
    jobTitle: show.has("title") ? (person.employeeProfile?.designation ?? "") : "",
    department: show.has("department") ? (person.department?.name ?? "") : "",
    company: ctx.company,
    phone: show.has("phone") ? (person.phone ?? "") : "",
    email: show.has("email") ? person.email : "",
    website: t.website,
    address: show.has("address") ? address : "",
    photo: show.has("photo") && person.photoUpdatedAt ? `${ctx.origin}/api/signatures/photo/${await photoToken(person.id)}?v=${person.photoUpdatedAt.getTime()}` : "",
    logo: t.logoUrl || ctx.brandLogo || "",
    social: t.social,
    signOff: t.signOff,
    ctaLabel: t.ctaLabel,
    ctaUrl: t.ctaUrl,
    disclaimer: t.disclaimer,
  };
  const style: SignatureStyle = { template: LAYOUTS[t.layout] ?? "classic", color: t.color, font: t.font };
  // The paid product carries no credit.
  const html = renderSignature(details, style, null);
  return { templateId: t.id, details, style, html, hash: createHash("sha256").update(html).digest("hex") };
}

export async function loadPerson(userId: string): Promise<Person | null> {
  return (await db.user.findUnique({ where: { id: userId }, select: PERSON_SELECT })) as Person | null;
}
