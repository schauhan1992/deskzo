"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import type { ActionResult } from "@/actions/company";
import { renderSignatureHtml, renderSignatureText, SOCIALS, safeUrl, type SocialKey } from "@/lib/signatures/render";
import { ALL_LAYOUTS, layoutByKey } from "@/lib/signatures/premium";
import { readSocials, signatureDataFor, signatureSettings, type SignatureSettingsView } from "@/lib/signatures/server";

/**
 * Deskzo Signatures in a workspace (docs/digital-cards-and-signatures.md §5): everybody's own
 * signature, built from their record, in any template — the premium ones included, which is what the
 * module is bought for — and the company's settings for whoever holds `signatures.manage`.
 *
 * Copying into the mail client is the person's step for now; syncing into mailboxes is phases 4–5.
 */

export type SignatureChoice = { key: string; name: string; tier: "free" | "premium"; blurb: string; html: string };

export type MySignature = {
  html: string;
  text: string;
  selectedKey: string;
  locked: boolean;
  mobile: string;
  /** Every template with the person's own details, to choose from — just the company's when locked. */
  choices: SignatureChoice[];
  /** Null unless they may change the company's settings. */
  settings: SignatureSettingsView | null;
  /** Every template, for the company's choice — empty unless they may make it. */
  allTemplates: { key: string; name: string; tier: "free" | "premium" }[];
  /** What the signature fills in by itself, so the page can say where each part comes from. */
  hasPhoto: boolean;
  hasCard: boolean;
  hasLogo: boolean;
};

export async function getMySignature(): Promise<ActionResult<MySignature>> {
  const user = await requireModuleUser("signatures");
  const [settings, origin, mine, mayManage] = await Promise.all([
    signatureSettings(),
    tenantOrigin(),
    db.userSignature.findUnique({ where: { userId: user.id }, select: { templateKey: true, mobile: true } }),
    hasEffectivePermission(user.id, "signatures.manage"),
  ]);
  const data = await signatureDataFor(user.id, settings, origin);
  if (!data) return { ok: false, error: "Your account couldn't be read." };

  const chosen = !settings.lockTemplate && mine?.templateKey && layoutByKey(mine.templateKey) ? mine.templateKey : settings.templateKey;
  const layout = layoutByKey(chosen) ?? ALL_LAYOUTS[0]!;
  const offered = settings.lockTemplate ? [layout] : ALL_LAYOUTS;
  return {
    ok: true,
    data: {
      html: renderSignatureHtml(layout, data),
      text: renderSignatureText(data),
      selectedKey: layout.key,
      locked: settings.lockTemplate,
      mobile: mine?.mobile ?? "",
      choices: offered.map((l) => ({ key: l.key, name: l.name, tier: l.tier, blurb: l.blurb, html: renderSignatureHtml(l, data) })),
      settings: mayManage ? settings : null,
      allTemplates: mayManage ? ALL_LAYOUTS.map((l) => ({ key: l.key, name: l.name, tier: l.tier })) : [],
      hasPhoto: !!data.photoUrl,
      hasCard: !!data.cardUrl,
      hasLogo: !!data.logoUrl,
    },
  };
}

const mineSchema = z.object({
  templateKey: z.string().max(40).nullable(),
  mobile: z.string().trim().max(32, "That is too long for a phone number"),
});

/** Their template (where the company lets them choose) and a mobile of their own for the signature. */
export async function updateMySignature(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("signatures");
  const parsed = mineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const settings = await signatureSettings();
  const { templateKey, mobile } = parsed.data;
  if (templateKey && !layoutByKey(templateKey)) return { ok: false, error: "That template doesn't exist." };
  if (templateKey && settings.lockTemplate && templateKey !== settings.templateKey) {
    return { ok: false, error: "Your company has set one signature for everybody." };
  }
  await db.userSignature.upsert({
    where: { userId: user.id },
    create: { userId: user.id, templateKey: settings.lockTemplate ? null : templateKey, mobile: mobile || null },
    update: { ...(settings.lockTemplate ? {} : { templateKey }), mobile: mobile || null },
  });
  revalidatePath("/signatures");
  return { ok: true, data: null };
}

const optionalUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => v === "" || safeUrl(v) !== null, "Links must be web addresses (https://…)");

const settingsSchema = z.object({
  templateKey: z.string().max(40),
  lockTemplate: z.boolean(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Colours are #rrggbb"),
  website: z.string().trim().max(200),
  socials: z.record(z.string(), z.string().trim().max(200)),
  disclaimer: z.string().trim().max(600, "Keep the disclaimer under 600 characters"),
  bannerImageUrl: optionalUrl,
  bannerLink: optionalUrl,
  showPhoto: z.boolean(),
  showCard: z.boolean(),
});

/** The company's signature: template and lock, colour, the same-for-everyone parts. */
export async function saveSignatureSettings(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("signatures");
  if (!(await hasEffectivePermission(user.id, "signatures.manage"))) return { ok: false, error: "You can't change the company's email signature." };
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  if (!layoutByKey(v.templateKey)) return { ok: false, error: "That template doesn't exist." };
  const socials: Partial<Record<SocialKey, string>> = {};
  for (const s of SOCIALS) {
    const value = v.socials[s.key]?.trim();
    if (!value) continue;
    if (!safeUrl(value)) return { ok: false, error: `The ${s.label} link must be a web address.` };
    socials[s.key] = value;
  }
  const data = {
    templateKey: v.templateKey,
    lockTemplate: v.lockTemplate,
    accentColor: v.accentColor,
    website: v.website || null,
    socials: readSocials(socials) as Prisma.InputJsonValue,
    disclaimer: v.disclaimer || null,
    bannerImageUrl: v.bannerImageUrl || null,
    bannerLink: v.bannerLink || null,
    showPhoto: v.showPhoto,
    showCard: v.showCard,
    updatedById: user.id,
  };
  await db.signatureSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "SignatureSettings", entityId: "global", entityLabel: `Company email signature — ${v.templateKey}${v.lockTemplate ? ", locked" : ""}` });
  revalidatePath("/signatures");
  return { ok: true, data: null };
}
