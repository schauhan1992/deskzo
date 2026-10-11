"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { SIGNATURE_FONTS, SOCIAL_NETWORKS, safeImage, safeUrl } from "@/lib/signatures/render";
import { RECORD_FIELDS } from "@/lib/signatures/person";
import { checkGoogle, readServiceAccount } from "@/lib/signatures/google";
import { recordRun, syncSignatures, type SyncReport } from "@/lib/signatures/sync";
import type { ActionResult } from "@/actions/company";

/**
 * Deskzo Signatures, for whoever holds `signatures.manage`: the templates, who gets which, the
 * connected mail suite, and putting the signatures into everybody's mailbox now.
 */

const REFUSED = "Only somebody who manages email signatures can do that.";

async function manager() {
  const user = await requireModuleUser("signatures");
  return (await hasEffectivePermission(user.id, "signatures.manage")) ? user : null;
}

function refresh() {
  revalidatePath("/signatures");
  revalidatePath("/signatures/manage");
}

/** Everybody's signature is drawn afresh and goes out on the next run. */
async function everybodyPending() {
  await db.signatureSync.updateMany({ where: { status: { in: ["SYNCED", "FAILED"] } }, data: { status: "PENDING" } });
}

// ── Templates ───────────────────────────────────────────────────────────────────────────────────────

const optionalUrl = (label: string) =>
  z
    .string()
    .trim()
    .max(500)
    .refine((v) => !v || safeUrl(v) !== null, `${label} isn't a web address`);

const templateSchema = z.object({
  id: z.string().min(1).nullable(),
  name: z.string().trim().min(1, "Give the template a name").max(60),
  layout: z.enum(["CLASSIC", "MODERN", "STACKED", "COMPACT"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour"),
  font: z.enum(Object.keys(SIGNATURE_FONTS) as [string, ...string[]]),
  shown: z.array(z.enum(RECORD_FIELDS.map((f) => f.key) as [string, ...string[]])).max(RECORD_FIELDS.length),
  website: optionalUrl("The website"),
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => !v || (safeImage(v) !== null && !v.startsWith("data:")), "The logo needs an address starting https:// — mail programs fetch it from there"),
  social: z.record(z.string(), z.string().trim().max(300)),
  ctaLabel: z.string().trim().max(60),
  ctaUrl: optionalUrl("The button's link"),
  signOff: z.string().trim().max(60),
  disclaimer: z.string().trim().max(600),
});

/** A template, made or changed — and everybody it reaches goes out again on the next run. */
export async function saveSignatureTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const t = parsed.data;
  const social: Record<string, string> = {};
  for (const n of SOCIAL_NETWORKS) {
    const value = t.social[n.key]?.trim() ?? "";
    if (value && !safeUrl(value)) return { ok: false, error: `${n.label} isn't a web address.` };
    if (value) social[n.key] = value;
  }
  const data = {
    name: t.name,
    layout: t.layout,
    color: t.color.toLowerCase(),
    font: t.font,
    recordFields: RECORD_FIELDS.map((f) => ({ key: f.key, show: t.shown.includes(f.key) })) as unknown as Prisma.InputJsonValue,
    website: t.website || null,
    logoUrl: t.logoUrl || null,
    social: social as Prisma.InputJsonValue,
    ctaLabel: t.ctaLabel || null,
    ctaUrl: t.ctaUrl || null,
    signOff: t.signOff || null,
    disclaimer: t.disclaimer || null,
  };
  let id: string;
  if (t.id) {
    const updated = await db.signatureTemplate.updateMany({ where: { id: t.id }, data });
    if (updated.count === 0) return { ok: false, error: "That template no longer exists." };
    id = t.id;
  } else {
    const hasDefault = (await db.signatureTemplate.count({ where: { isDefault: true } })) > 0;
    id = (await db.signatureTemplate.create({ data: { ...data, isDefault: !hasDefault, createdById: user.id }, select: { id: true } })).id;
  }
  await everybodyPending();
  await recordAudit({ userId: user.id, action: t.id ? "UPDATE" : "CREATE", entityType: "SignatureTemplate", entityId: id, entityLabel: t.name });
  refresh();
  return { ok: true, data: { id } };
}

export async function makeDefaultSignatureTemplate(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  if (!(await db.signatureTemplate.findUnique({ where: { id }, select: { id: true } }))) return { ok: false, error: "That template no longer exists." };
  await db.$transaction(async (tx) => {
    await tx.signatureTemplate.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
    await tx.signatureTemplate.update({ where: { id }, data: { isDefault: true } });
  });
  await everybodyPending();
  refresh();
  return { ok: true, data: null };
}

/** Any template but the default can go; whoever it reached gets the default instead. */
export async function deleteSignatureTemplate(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const t = await db.signatureTemplate.findUnique({ where: { id }, select: { isDefault: true, name: true } });
  if (!t) return { ok: false, error: "That template no longer exists." };
  if (t.isDefault) return { ok: false, error: "This is the default. Make another the default first." };
  await db.signatureTemplate.delete({ where: { id } });
  await everybodyPending();
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "SignatureTemplate", entityId: id, entityLabel: t.name });
  refresh();
  return { ok: true, data: null };
}

// ── Who gets which ──────────────────────────────────────────────────────────────────────────────────

const ruleSchema = z.object({
  target: z.enum(["DEPARTMENT", "BRANCH", "ROLE", "PERSON"]),
  targetId: z.string().min(1).max(100),
  /** Null takes the rule away: they get the default, or whatever a broader rule gives them. */
  templateId: z.string().min(1).nullable(),
});

export async function setSignatureRule(input: unknown): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { target, targetId, templateId } = parsed.data;
  if (templateId === null) {
    await db.signatureRule.deleteMany({ where: { target, targetId } });
  } else {
    if (!(await db.signatureTemplate.findUnique({ where: { id: templateId }, select: { id: true } }))) return { ok: false, error: "That template no longer exists." };
    await db.signatureRule.upsert({ where: { target_targetId: { target, targetId } }, create: { target, targetId, templateId }, update: { templateId } });
  }
  await everybodyPending();
  refresh();
  return { ok: true, data: null };
}

// ── The connected suite ─────────────────────────────────────────────────────────────────────────────

const googleSchema = z.object({
  keyJson: z.string().trim().min(10, "Paste the service account's key file").max(20_000),
  adminEmail: z.string().trim().toLowerCase().email("The administrator's Google Workspace address, please"),
});

/**
 * Google Workspace, by a service account with domain-wide delegation. Tried before it is kept: a token
 * is asked for as the administrator and their own send-as addresses read, so a missing delegation is
 * said now rather than on everybody's first sync.
 */
export async function connectGoogleSignatures(input: unknown): Promise<ActionResult<{ serviceEmail: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const parsed = googleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const sa = readServiceAccount(parsed.data.keyJson);
  if ("error" in sa) return { ok: false, error: sa.error };
  const tried = await checkGoogle(sa, parsed.data.adminEmail);
  if (!tried.ok) return { ok: false, error: tried.error };
  const data = {
    provider: "GOOGLE",
    googleServiceEmail: sa.clientEmail,
    googleKeyCipher: await encryptSecret(parsed.data.keyJson),
    zohoRefreshCipher: null,
    zohoOrgId: null,
    zohoAdminEmail: null,
    connectedById: user.id,
    connectedAt: new Date(),
    lastError: null,
  };
  await db.signatureSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await everybodyPending();
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "SignatureSettings", entityId: "global", entityLabel: `Google Workspace connected for email signatures (${sa.clientEmail})` });
  refresh();
  return { ok: true, data: { serviceEmail: sa.clientEmail } };
}

/** Zoho's organisation id, typed in when Zoho didn't say it. */
export async function setZohoOrganisation(zoid: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const value = String(zoid ?? "").trim();
  if (!/^\d{4,20}$/.test(value)) return { ok: false, error: "The Organisation ID is the number in Zoho Mail Admin Console → Organization." };
  await db.signatureSettings.updateMany({ where: { id: "global", provider: "ZOHO" }, data: { zohoOrgId: value, lastError: null } });
  refresh();
  return { ok: true, data: null };
}

/** Signatures stop going out. What is already in people's mailboxes stays there. */
export async function disconnectSignatures(): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  await db.signatureSettings.updateMany({
    where: { id: "global" },
    data: { provider: null, googleServiceEmail: null, googleKeyCipher: null, zohoRefreshCipher: null, zohoOrgId: null, zohoAdminEmail: null, connectedById: null, connectedAt: null, lastError: null },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "SignatureSettings", entityId: "global", entityLabel: "Email signatures disconnected from the mail suite" });
  refresh();
  return { ok: true, data: null };
}

export async function setSignatureAutoSync(on: boolean): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  await db.signatureSettings.upsert({ where: { id: "global" }, create: { id: "global", autoSync: !!on }, update: { autoSync: !!on } });
  refresh();
  return { ok: true, data: null };
}

// ── Microsoft 365: the Outlook add-in ───────────────────────────────────────────────────────────────

/**
 * The Outlook add-in answers for this workspace, or stops (src/lib/signatures/outlook.ts). Its id is made
 * the first time and kept, so the manifest the Microsoft 365 administrator uploaded keeps working through
 * an off and on. Beside Google or Zoho, not instead of them: a company can have people on both.
 */
export async function setOutlookAddin(on: boolean): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const existing = await db.signatureSettings.findUnique({ where: { id: "global" }, select: { outlookAddinId: true } });
  const data = { outlookOn: !!on, outlookAddinId: existing?.outlookAddinId ?? randomUUID() };
  await db.signatureSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "SignatureSettings", entityId: "global", entityLabel: on ? "Outlook add-in for email signatures turned on" : "Outlook add-in for email signatures turned off" });
  refresh();
  return { ok: true, data: null };
}

/** Whether the add-in turns off a person's own Outlook signature, so a message never carries two. */
export async function setOutlookReplaceOwn(on: boolean): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  await db.signatureSettings.upsert({ where: { id: "global" }, create: { id: "global", outlookReplaceOwn: !!on }, update: { outlookReplaceOwn: !!on } });
  refresh();
  return { ok: true, data: null };
}

/** Put the signatures into the mailboxes now — everybody, or the people named — whether changed or not. */
export async function syncSignaturesNow(userIds?: string[]): Promise<ActionResult<SyncReport>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const ids = Array.isArray(userIds) ? userIds.filter((id) => typeof id === "string").slice(0, 2000) : undefined;
  const report = await recordRun(await syncSignatures({ budgetMs: 50_000, force: true, ...(ids ? { userIds: ids } : {}) }));
  refresh();
  return { ok: true, data: report };
}
