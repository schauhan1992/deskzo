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
import { BANNER_WIDTH, SIGNATURE_FONTS, SOCIAL_NETWORKS, linkNote, safeImage, safePhone, safeUrl } from "@/lib/signatures/render";
import { LAYOUTS, RECORD_FIELDS, type LayoutKey } from "@/lib/signatures/person";
import { BANNER_IMAGE_MAX_BYTES, BANNER_IMAGE_TYPES } from "@/lib/signatures/banners";
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

/** A web address that may be left empty — https only (render.ts): "isn't a web address", or "change http:// to https://". */
const optionalUrl = (label: string) =>
  z
    .string()
    .trim()
    .max(500)
    .superRefine((v, ctx) => {
      const note = linkNote(v);
      if (note) ctx.addIssue({ code: "custom", message: `${label}: ${note}` });
    });

/** A picture's address a mail program fetches — https only, never a picture inside the signature. */
const imageAddress = (label: string) =>
  z
    .string()
    .trim()
    .max(500)
    .refine((v) => !v || (safeImage(v) !== null && !v.startsWith("data:")), `${label} needs an address starting https:// — mail programs fetch it from there`);

const templateSchema = z.object({
  id: z.string().min(1).nullable(),
  name: z.string().trim().min(1, "Give the template a name").max(60),
  layout: z.enum(Object.keys(LAYOUTS) as [LayoutKey, ...LayoutKey[]]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour"),
  font: z.enum(Object.keys(SIGNATURE_FONTS) as [string, ...string[]]),
  shown: z.array(z.enum(RECORD_FIELDS.map((f) => f.key) as [string, ...string[]])).max(RECORD_FIELDS.length),
  website: optionalUrl("The website"),
  logoUrl: imageAddress("The logo"),
  logoLink: optionalUrl("The logo's link").optional(),
  social: z.record(z.string(), z.string().trim().max(300)),
  ctaLabel: z.string().trim().max(60),
  ctaUrl: optionalUrl("The button's link"),
  signOff: z.string().trim().max(60),
  disclaimer: z.string().trim().max(600),
  replyStyle: z.enum(["FULL", "SHORT", "NONE"]).optional(),
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
    if (value && !safeUrl(value)) return { ok: false, error: `${n.label}: ${linkNote(value)}` };
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
    logoLink: t.logoLink || null,
    social: social as Prisma.InputJsonValue,
    ctaLabel: t.ctaLabel || null,
    ctaUrl: t.ctaUrl || null,
    signOff: t.signOff || null,
    disclaimer: t.disclaimer || null,
    ...(t.replyStyle ? { replyStyle: t.replyStyle } : {}),
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

// ── Shared mailboxes (Outlook) ──────────────────────────────────────────────────────────────────────

const mailboxSchema = z.object({
  id: z.string().min(1).nullable(),
  address: z.string().trim().toLowerCase().max(200).email("The shared mailbox's address, please"),
  name: z.string().trim().min(1, "Give it the name its messages are signed with").max(80),
  phone: z.string().trim().max(40),
  templateId: z.string().min(1).nullable(),
});

/**
 * A shared mailbox and the signature its messages carry in Outlook, when somebody changes the From to it
 * (src/lib/signatures/person.ts, mailboxSignature). A person's own address can't be one: theirs is theirs.
 */
export async function saveSignatureMailbox(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const parsed = mailboxSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const m = parsed.data;
  if (m.phone && !safePhone(m.phone)) return { ok: false, error: "That isn't a phone number." };
  const owner = await db.user.findFirst({ where: { email: { equals: m.address, mode: "insensitive" } }, select: { name: true } });
  if (owner) return { ok: false, error: `${m.address} is ${owner.name}'s own address — messages from it carry their signature.` };
  const templateId = m.templateId && (await db.signatureTemplate.findUnique({ where: { id: m.templateId }, select: { id: true } })) ? m.templateId : null;
  const data = { address: m.address, name: m.name, phone: m.phone || null, templateId };
  let id: string;
  try {
    if (m.id) {
      const updated = await db.signatureMailbox.updateMany({ where: { id: m.id }, data });
      if (updated.count === 0) return { ok: false, error: "That mailbox is no longer listed." };
      id = m.id;
    } else {
      id = (await db.signatureMailbox.create({ data: { ...data, createdById: user.id }, select: { id: true } })).id;
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: "That mailbox is listed already." };
    throw err;
  }
  await recordAudit({ userId: user.id, action: m.id ? "UPDATE" : "CREATE", entityType: "SignatureMailbox", entityId: id, entityLabel: m.address });
  refresh();
  return { ok: true, data: { id } };
}

export async function deleteSignatureMailbox(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const mailbox = await db.signatureMailbox.findUnique({ where: { id: String(id) }, select: { address: true } });
  if (!mailbox) return { ok: false, error: "That mailbox is no longer listed." };
  await db.signatureMailbox.delete({ where: { id: String(id) } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "SignatureMailbox", entityId: String(id), entityLabel: mailbox.address });
  refresh();
  return { ok: true, data: null };
}

// ── Banners ─────────────────────────────────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const bannerSchema = z
  .object({
    id: z.string().min(1).nullable(),
    name: z.string().trim().min(1, "Give the banner a name").max(60),
    /** A new upload, an https address, or — when changing a banner — the picture it has. */
    image: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("upload"), dataUrl: z.string().max(1_500_000) }),
      z.object({ kind: z.literal("url"), url: imageAddress("The banner's picture").refine((v) => v.length > 0, "Give the picture's address, or upload one") }),
      z.object({ kind: z.literal("keep") }),
    ]),
    linkUrl: optionalUrl("The banner's link"),
    altText: z.string().trim().min(1, "Say what the banner shows — it is shown where pictures are blocked").max(150),
    width: z.number().int().min(BANNER_WIDTH.min, `At least ${BANNER_WIDTH.min} pixels wide`).max(BANNER_WIDTH.max, `At most ${BANNER_WIDTH.max} pixels wide — wider breaks on phones`),
    startsOn: z.string().regex(DAY).nullable(),
    endsOn: z.string().regex(DAY).nullable(),
    templateIds: z.array(z.string().min(1)).max(100),
    paused: z.boolean(),
  })
  .superRefine((b, ctx) => {
    if (b.startsOn && b.endsOn && b.endsOn < b.startsOn) ctx.addIssue({ code: "custom", path: ["endsOn"], message: "It can't end before it starts." });
  });

/** The signatures of an upload: what it says it is must be what it is. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 4).toString("ascii") === "GIF8",
};

function checkBannerUpload(dataUrl: string): { dataUrl: string } | { error: string } {
  const match = /^data:([a-z/]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match || !(BANNER_IMAGE_TYPES as readonly string[]).includes(match[1]!)) return { error: "A banner is a PNG, JPEG or GIF picture — mail programs don't all show other kinds." };
  const bytes = Buffer.from(match[2]!, "base64");
  if (!bytes.length || !MAGIC[match[1]!]!(bytes)) return { error: "That file isn't the picture it says it is." };
  if (bytes.length > BANNER_IMAGE_MAX_BYTES) return { error: "The picture is over 1 MB. Banners travel in every email — make it smaller (a few hundred KB at most is best)." };
  return { dataUrl: `data:${match[1]};base64,${match[2]}` };
}

const asDay = (d: string | null) => (d ? new Date(`${d}T00:00:00.000Z`) : null);

/**
 * A banner, made or changed — under everybody's signature or the named templates' — and every signature
 * drawn again: the next sync sends the ones it changed, and Outlook has it on the next message.
 */
export async function saveSignatureBanner(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const parsed = bannerSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const b = parsed.data;

  let picture: { imageData: string | null; imageUrl: string | null } | null = null;
  if (b.image.kind === "upload") {
    const upload = checkBannerUpload(b.image.dataUrl);
    if ("error" in upload) return { ok: false, error: upload.error };
    picture = { imageData: upload.dataUrl, imageUrl: null };
  } else if (b.image.kind === "url") {
    picture = { imageData: null, imageUrl: safeUrl(b.image.url) };
  } else if (!b.id) {
    return { ok: false, error: "Upload the banner's picture, or give its https:// address." };
  }

  const known = new Set((await db.signatureTemplate.findMany({ where: { id: { in: b.templateIds } }, select: { id: true } })).map((t) => t.id));
  const data = {
    name: b.name,
    linkUrl: b.linkUrl ? safeUrl(b.linkUrl) : null,
    altText: b.altText,
    width: b.width,
    startsOn: asDay(b.startsOn),
    endsOn: asDay(b.endsOn),
    paused: b.paused,
    templateIds: b.templateIds.filter((id) => known.has(id)) as Prisma.InputJsonValue,
    ...(picture ?? {}),
  };
  let id: string;
  if (b.id) {
    const updated = await db.signatureBanner.updateMany({ where: { id: b.id, removedAt: null }, data });
    if (updated.count === 0) return { ok: false, error: "That banner no longer exists." };
    id = b.id;
  } else {
    id = (await db.signatureBanner.create({ data: { ...data, imageData: picture!.imageData, imageUrl: picture!.imageUrl, createdById: user.id }, select: { id: true } })).id;
  }
  await everybodyPending();
  await recordAudit({ userId: user.id, action: b.id ? "UPDATE" : "CREATE", entityType: "SignatureBanner", entityId: id, entityLabel: b.name });
  refresh();
  return { ok: true, data: { id } };
}

/** Paused, it leaves every signature at once; started again, it comes back on its days. */
export async function setSignatureBannerPaused(id: string, paused: boolean): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const updated = await db.signatureBanner.updateMany({ where: { id: String(id), removedAt: null }, data: { paused: !!paused } });
  if (updated.count === 0) return { ok: false, error: "That banner no longer exists." };
  await everybodyPending();
  refresh();
  return { ok: true, data: null };
}

/**
 * Out of every signature and off the list. Kept underneath: emails already sent still show its picture
 * and its link still takes their readers where it went, and its clicks stay in the count.
 */
export async function removeSignatureBanner(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  const banner = await db.signatureBanner.findFirst({ where: { id: String(id), removedAt: null }, select: { name: true } });
  if (!banner) return { ok: false, error: "That banner no longer exists." };
  await db.signatureBanner.update({ where: { id: String(id) }, data: { removedAt: new Date() } });
  await everybodyPending();
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "SignatureBanner", entityId: String(id), entityLabel: banner.name });
  refresh();
  return { ok: true, data: null };
}

/**
 * Counting clicks on banners and buttons (src/lib/signatures/clicks.ts), or not: off, their links go
 * straight to where they go. Every signature changes, so every one goes out again.
 */
export async function setSignatureClickTracking(on: boolean): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: REFUSED };
  await db.signatureSettings.upsert({ where: { id: "global" }, create: { id: "global", trackClicks: !!on }, update: { trackClicks: !!on } });
  await everybodyPending();
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "SignatureSettings", entityId: "global", entityLabel: on ? "Clicks on signature banners and buttons counted" : "Clicks on signature banners and buttons no longer counted" });
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
