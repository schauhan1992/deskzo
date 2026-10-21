"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { notMigratedYet } from "@/lib/not-migrated";
import { unknownLetterFields } from "@/lib/hr/letter-templates";
import { BUILT_IN_LETTER_CODES } from "@/lib/hr/letters";
import { letterSignatureSettings } from "@/lib/organisation";
import type { ActionResult } from "@/actions/company";

/**
 * HR's own letter templates and the signature letters carry (owner, 21 Oct 2026: "HR can add more templates
 * for official docs", "a digital signature option on HR's letters"). Both are HR's — `hr.manage` — like
 * drafting and issuing the letters themselves (src/actions/employee-docs.ts).
 */

async function requireHrManager() {
  const user = await requireModuleUser("hr");
  const allowed = await hasEffectivePermission(user.id, "hr.manage");
  return { user, allowed };
}

/** Same bound as the invoice stamp (src/actions/organisation.ts): a signature is a small image. */
const MAX_SIGNATURE_BYTES = 256 * 1024;

export type LetterTemplateRow = { id: string; name: string; code: string; subject: string; body: string; active: boolean; letters: number; updatedAt: string };

/** Every template, switched off too — or only the ones offered when drafting. Empty where not migrated. */
export async function listLetterTemplates(options: { activeOnly?: boolean } = {}): Promise<LetterTemplateRow[]> {
  const { allowed } = await requireHrManager();
  if (!allowed) return [];
  try {
    const rows = await db.letterTemplate.findMany({
      where: options.activeOnly ? { active: true } : {},
      orderBy: [{ active: "desc" }, { name: "asc" }],
      include: { _count: { select: { letters: true } } },
    });
    return toPlain(
      rows.map((r) => ({ id: r.id, name: r.name, code: r.code, subject: r.subject, body: r.body, active: r.active, letters: r._count.letters, updatedAt: r.updatedAt.toISOString() })),
    );
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

export type LetterTemplateInput = { id?: string; name: string; code: string; subject: string; body: string; active?: boolean };

export async function saveLetterTemplate(input: LetterTemplateInput): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requireHrManager();
  if (!allowed) return { ok: false, error: "Only HR can change the letter templates." };

  const name = (input.name ?? "").trim().replace(/\s+/g, " ");
  const code = (input.code ?? "").trim().toUpperCase();
  const subject = (input.subject ?? "").trim();
  const body = (input.body ?? "").replace(/\r\n/g, "\n").trim();
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Name it in 2 to 60 characters — “Bonafide certificate”, say." };
  if (!/^[A-Z]{2,5}$/.test(code)) return { ok: false, error: "The code is 2 to 5 letters — it goes in the letter number, like WRF/BON/2026/001." };
  if (BUILT_IN_LETTER_CODES.includes(code)) return { ok: false, error: `${code} is a built-in letter's code — pick another.` };
  if (!subject || subject.length > 200) return { ok: false, error: "Give it a subject line, under 200 characters." };
  if (body.length < 10) return { ok: false, error: "Write the letter's text." };
  if (body.length > 20000) return { ok: false, error: "That's longer than a letter — keep it under 20,000 characters." };
  const unknown = unknownLetterFields(`${subject}\n${body}`);
  if (unknown.length) return { ok: false, error: `There's no field called ${unknown.map((k) => `{{${k}}}`).join(", ")} — pick one from the list.` };

  try {
    const clash = await db.letterTemplate.findFirst({
      where: { OR: [{ code }, { name: { equals: name, mode: "insensitive" } }], ...(input.id ? { id: { not: input.id } } : {}) },
      select: { name: true, code: true },
    });
    if (clash) return { ok: false, error: clash.code === code ? `${clash.name} already uses the code ${code}.` : `There's already a template called ${clash.name}.` };

    const data = { name, code, subject, body, ...(input.active !== undefined ? { active: input.active } : {}) };
    const row = input.id
      ? await db.letterTemplate.update({ where: { id: input.id }, data, select: { id: true } })
      : await db.letterTemplate.create({ data: { ...data, createdById: user.id }, select: { id: true } });
    await recordAudit({ userId: user.id, action: input.id ? "UPDATE" : "CREATE", entityType: "LetterTemplate", entityId: row.id, entityLabel: `Letter template ${name}` });
    revalidatePath("/people/letters");
    return { ok: true, data: row };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace's database hasn't been brought up to date yet." };
    throw err;
  }
}

/**
 * Deletes a template nothing was drafted from; one with letters is switched off instead, since those letters
 * name it. Either way the letters themselves are untouched — they hold their own text.
 */
export async function deleteLetterTemplate(id: string): Promise<ActionResult<{ deleted: boolean }>> {
  const { user, allowed } = await requireHrManager();
  if (!allowed) return { ok: false, error: "Only HR can change the letter templates." };
  const row = await db.letterTemplate.findUnique({ where: { id }, select: { name: true, _count: { select: { letters: true } } } });
  if (!row) return { ok: false, error: "That template isn't there any more." };
  if (row._count.letters > 0) {
    await db.letterTemplate.update({ where: { id }, data: { active: false } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "LetterTemplate", entityId: id, entityLabel: `Letter template ${row.name} switched off` });
    revalidatePath("/people/letters");
    return { ok: true, data: { deleted: false } };
  }
  await db.letterTemplate.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "LetterTemplate", entityId: id, entityLabel: `Letter template ${row.name}` });
  revalidatePath("/people/letters");
  return { ok: true, data: { deleted: true } };
}

// ─── The signature ────────────────────────────────────────────────────────────

/** What People › Letters shows of the signature. Null for anybody but HR. */
export async function letterSignatureForHr() {
  const { allowed } = await requireHrManager();
  if (!allowed) return null;
  return letterSignatureSettings();
}

/**
 * The signatory's signature for letters — uploaded, or drawn on the screen — kept apart from the invoice
 * stamp. Letters already issued keep the image they were issued with.
 */
export async function saveLetterSignature(dataUrl: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHrManager();
  if (!allowed) return { ok: false, error: "Only HR can change the letter signature." };
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? "");
  if (!match) return { ok: false, error: "Use a PNG, JPEG or WebP image." };
  if ((match[2]!.length * 3) / 4 > MAX_SIGNATURE_BYTES) return { ok: false, error: "That image is over 256KB — use a smaller one." };
  try {
    await db.organisationSettings.upsert({
      where: { id: "global" },
      create: { id: "global", legalName: "", letterSignatureDataUrl: dataUrl },
      update: { letterSignatureDataUrl: dataUrl },
    });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace's database hasn't been brought up to date yet." };
    throw err;
  }
  // The image itself never goes in the audit log — only that it changed.
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "OrganisationSettings", entityId: "global", entityLabel: "Letter signature changed" });
  revalidatePath("/people/letters");
  return { ok: true, data: null };
}

export async function removeLetterSignature(): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHrManager();
  if (!allowed) return { ok: false, error: "Only HR can change the letter signature." };
  try {
    await db.organisationSettings.update({ where: { id: "global" }, data: { letterSignatureDataUrl: null } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace's database hasn't been brought up to date yet." };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "OrganisationSettings", entityId: "global", entityLabel: "Letter signature removed" });
  revalidatePath("/people/letters");
  return { ok: true, data: null };
}

/** Whether a new letter starts out signed. Each draft can still be switched. */
export async function setLetterSignByDefault(signByDefault: boolean): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHrManager();
  if (!allowed) return { ok: false, error: "Only HR can change this." };
  try {
    await db.organisationSettings.upsert({
      where: { id: "global" },
      create: { id: "global", legalName: "", letterSignByDefault: !!signByDefault },
      update: { letterSignByDefault: !!signByDefault },
    });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace's database hasn't been brought up to date yet." };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "OrganisationSettings", entityId: "global", entityLabel: `New letters ${signByDefault ? "signed" : "unsigned"} by default` });
  revalidatePath("/people/letters");
  return { ok: true, data: null };
}
