"use server";

import { revalidatePath } from "next/cache";
import { db, getTenantDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { currentTenant } from "@/lib/tenancy/resolve";
import { moduleEntitled } from "@/lib/entitlements";
import { notMigratedYet } from "@/lib/not-migrated";
import { INDUSTRY_TEMPLATES, templateOf } from "@/lib/industry-templates/catalogue";
import { applyTemplate, previewTemplate, type Entitled } from "@/lib/industry-templates/apply";
import type { TemplatePlan } from "@/lib/industry-templates/plan";
import type { ActionResult } from "@/actions/company";

/**
 * Settings → Industry templates (owner, 2 Oct 2026): the pipeline, order steps, words and fields for a
 * kind of business, applied in one go — src/lib/industry-templates. Opened with `settings.manage`, the
 * catalogue's gate; applying also changes the pipeline and the fields, so it asks for `pipeline.manage`
 * and `fields.manage` too.
 */

const NEEDED = ["settings.manage", "pipeline.manage", "fields.manage"] as const;

async function manager() {
  const user = await requireUser();
  return (await can(user.id, "settings.manage")) ? user : null;
}

async function entitlement(): Promise<Entitled> {
  const tenant = await currentTenant();
  return (key) => moduleEntitled(tenant.entitlements, tenant.country, key);
}

export type TemplatesPage = {
  templates: { key: string; name: string; summary: string; stages: string[]; steps: string[]; words: string[]; fields: number }[];
  /** The permissions applying needs that this person doesn't hold. */
  missing: string[];
  applied: { name: string; at: string; by: string | null; changes: string }[];
};

export async function industryTemplatesForManage(): Promise<TemplatesPage | null> {
  const user = await manager();
  if (!user) return null;
  const missing: string[] = [];
  for (const key of NEEDED) if (!(await can(user.id, key))) missing.push(key);
  const history = await db.auditLog.findMany({
    where: { entityType: "IndustryTemplate" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { entityId: true, entityLabel: true, createdAt: true, user: { select: { name: true } } },
  });
  return {
    templates: INDUSTRY_TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      summary: t.summary,
      stages: t.stages.map((s) => s.label),
      steps: t.steps.map((s) => s.label),
      words: Object.entries(t.terms).map(([key, term]) => `${key} → ${term!.one}`),
      fields: t.fields.length,
    })),
    missing,
    applied: history.map((h) => ({
      name: templateOf(h.entityId)?.name ?? h.entityId,
      at: h.createdAt.toISOString(),
      by: h.user?.name ?? null,
      changes: h.entityLabel.replace(/^[^:]*: [^—]*— ?/, ""),
    })),
  };
}

/** What applying it would do here, without doing it. */
export async function previewIndustryTemplate(key: string): Promise<ActionResult<TemplatePlan>> {
  const user = await manager();
  if (!user) return { ok: false, error: "You can't change organisation settings." };
  const template = templateOf(key);
  if (!template) return { ok: false, error: "Choose a template from the list." };
  try {
    return { ok: true, data: await previewTemplate(await getTenantDb(), template, await entitlement()) };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace is being updated. Try again in a few minutes." };
    throw err;
  }
}

export async function applyIndustryTemplate(key: string): Promise<ActionResult<{ changes: string[] }>> {
  const user = await manager();
  if (!user) return { ok: false, error: "You can't change organisation settings." };
  for (const permission of NEEDED.slice(1)) {
    if (!(await can(user.id, permission))) {
      return { ok: false, error: permission === "pipeline.manage" ? "Applying a template changes the pipeline, which you can't." : "Applying a template adds custom fields, which you can't." };
    }
  }
  const template = templateOf(key);
  if (!template) return { ok: false, error: "Choose a template from the list." };
  let changes: string[];
  try {
    ({ changes } = await applyTemplate(await getTenantDb(), template, await entitlement(), user.id));
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace is being updated. Try again in a few minutes." };
    throw err;
  }
  if (changes.length === 0) return { ok: true, data: { changes } };
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "IndustryTemplate", entityId: template.key, entityLabel: `Industry template: ${template.name} — ${changes.join("; ")}` });
  // The menu, titles and lists everywhere carry the new words, stages and columns.
  revalidatePath("/", "layout");
  return { ok: true, data: { changes } };
}
