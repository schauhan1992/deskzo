import type { CustomFieldEntity, OrderStatus, Prisma, PrismaClient } from "@prisma/client";
import { defaultStages, stageKeyFromLabel } from "@/lib/pipeline/rules";
import { stepKeyFromLabel } from "@/lib/pipeline/order-steps";
import { keyFromLabel, type CustomFieldOption } from "@/lib/custom-fields/rules";
import { CUSTOM_FIELD_ENTITY_MODULES } from "@/lib/custom-fields/rules";
import { planTemplate, type CurrentState, type TemplatePlan } from "@/lib/industry-templates/plan";
import type { IndustryTemplate } from "@/lib/industry-templates/catalogue";

/**
 * Reading a workspace for a template, and carrying a plan out — through whichever client is given: the
 * workspace's own (`getTenantDb()`) from Settings, or the new database's (`directClient`) while a signup
 * is provisioned (src/lib/platform/provisioning.ts). Everything is written in one transaction, and
 * planning again afterwards finds nothing to do, so a provisioning step retried after a failure is safe.
 */

/** What a module key needs: in the plan, for the template's own modules and for Orders and Products. */
export type Entitled = (moduleKey: string) => boolean;

const STAGE_COLOR = new Map(defaultStages().map((s) => [s.status, s.color]));

export async function readCurrent(client: PrismaClient, template: IndustryTemplate, entitled: Entitled): Promise<CurrentState> {
  const [stages, unstaged, staged, steps, wording, fields, switches] = await Promise.all([
    client.leadStage.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, label: true, status: true, archivedAt: true } }),
    // A lead with no stage of its own sits in the first stage that means what it does (stageOfLead).
    client.lead.groupBy({ by: ["status"], where: { stageId: null }, _count: { _all: true } }),
    client.lead.groupBy({ by: ["stageId"], where: { stageId: { not: null } }, _count: { _all: true } }),
    client.orderStep.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, label: true, status: true, archivedAt: true } }),
    client.terminologySettings.findUnique({ where: { id: "global" }, select: { overrides: true } }),
    client.customFieldDefinition.findMany({ select: { id: true, entity: true, key: true, label: true, archivedAt: true } }),
    client.systemModule.findMany({ select: { key: true, enabled: true } }),
  ]);
  const byStage = new Map(staged.map((g) => [g.stageId, g._count._all]));
  const byStatus = new Map(unstaged.map((g) => [g.status, g._count._all]));
  const firstOfStatus = new Set<string>();
  const seen = new Set<string>();
  for (const s of stages) {
    if (s.archivedAt || seen.has(s.status)) continue;
    seen.add(s.status);
    firstOfStatus.add(s.id);
  }
  const on = (key: string) => switches.find((m) => m.key === key)?.enabled ?? true;
  const available = (key: string) => entitled(key) && on(key);
  return {
    stages: stages.map((s) => ({
      id: s.id,
      label: s.label,
      status: s.status,
      archived: !!s.archivedAt,
      leads: (byStage.get(s.id) ?? 0) + (firstOfStatus.has(s.id) ? (byStatus.get(s.status) ?? 0) : 0),
    })),
    steps: steps.map((s) => ({ id: s.id, label: s.label, status: s.status, archived: !!s.archivedAt })),
    overrides: wording?.overrides ?? {},
    fields: fields.map((f) => ({ id: f.id, entity: f.entity, key: f.key, label: f.label, archived: !!f.archivedAt })),
    modules: Object.fromEntries(template.modules.map((key) => [key, !entitled(key) ? "not-in-plan" : on(key) ? "on" : "off"])),
    has: { orders: available(CUSTOM_FIELD_ENTITY_MODULES.ORDER!), items: available(CUSTOM_FIELD_ENTITY_MODULES.ITEM!) },
  };
}

export async function previewTemplate(client: PrismaClient, template: IndustryTemplate, entitled: Entitled): Promise<TemplatePlan> {
  return planTemplate(template, await readCurrent(client, template, entitled));
}

export type AppliedTemplate = {
  plan: TemplatePlan;
  /** One line per area that changed, for the audit and the confirmation. */
  changes: string[];
};

/** Plans afresh and carries it out; `actorUserId` is who the new fields are created by. */
export async function applyTemplate(client: PrismaClient, template: IndustryTemplate, entitled: Entitled, actorUserId: string | null): Promise<AppliedTemplate> {
  const plan = await previewTemplate(client, template, entitled);
  if (plan.nothingToDo) return { plan, changes: [] };
  const now = new Date();

  await client.$transaction(async (tx) => {
    // ── The pipeline ──
    const stageKeys = new Set((await tx.leadStage.findMany({ select: { key: true } })).map((s) => s.key));
    const ids = new Map<number, string>();
    for (const [i, s] of plan.pipeline.entries()) {
      if (s.kind === "add") {
        const key = stageKeyFromLabel(s.label, stageKeys);
        stageKeys.add(key);
        const made = await tx.leadStage.create({ data: { key, label: s.label, status: s.status, color: STAGE_COLOR.get(s.status) ?? "default" }, select: { id: true } });
        ids.set(i, made.id);
      } else {
        if (s.kind === "rename") await tx.leadStage.update({ where: { id: s.id }, data: { label: s.label } });
        ids.set(i, s.id);
      }
    }
    for (const s of plan.stages) if (s.kind === "retire") await tx.leadStage.update({ where: { id: s.id }, data: { archivedAt: now } });
    for (const [i] of plan.pipeline.entries()) await tx.leadStage.update({ where: { id: ids.get(i)! }, data: { sortOrder: i + 1 } });

    // ── Order steps: added at the end of their status ──
    const steps = await tx.orderStep.findMany({ select: { key: true, status: true, archivedAt: true } });
    const stepKeys = new Set(steps.map((s) => s.key));
    const counts = new Map<OrderStatus, number>();
    for (const s of steps) if (!s.archivedAt) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
    for (const s of plan.steps) {
      if (s.kind !== "add" && s.kind !== "restore") continue;
      const sortOrder = (counts.get(s.status) ?? 0) + 1;
      counts.set(s.status, sortOrder);
      if (s.kind === "restore") {
        await tx.orderStep.update({ where: { id: s.id }, data: { archivedAt: null, sortOrder } });
        continue;
      }
      const key = stepKeyFromLabel(s.label, stepKeys);
      stepKeys.add(key);
      await tx.orderStep.create({ data: { key, label: s.label, status: s.status, color: "default", sortOrder } });
    }

    // ── Words: what is there, with the template's set ──
    if (plan.words.some((w) => w.kind === "set")) {
      const overrides = plan.overrides as unknown as Prisma.InputJsonValue;
      await tx.terminologySettings.upsert({ where: { id: "global" }, create: { id: "global", overrides, updatedById: actorUserId }, update: { overrides, updatedById: actorUserId } });
    }

    // ── Fields: added after each record's own ──
    const defs = await tx.customFieldDefinition.findMany({ select: { entity: true, key: true, sortOrder: true } });
    const keys = new Map<CustomFieldEntity, Set<string>>();
    const last = new Map<CustomFieldEntity, number>();
    for (const d of defs) {
      keys.set(d.entity, (keys.get(d.entity) ?? new Set()).add(d.key));
      last.set(d.entity, Math.max(last.get(d.entity) ?? -1, d.sortOrder));
    }
    for (const f of plan.fields) {
      if (f.kind !== "add" && f.kind !== "restore") continue;
      const sortOrder = (last.get(f.field.entity) ?? -1) + 1;
      last.set(f.field.entity, sortOrder);
      if (f.kind === "restore") {
        await tx.customFieldDefinition.update({ where: { id: f.id }, data: { archivedAt: null, sortOrder, updatedById: actorUserId } });
        continue;
      }
      const taken = keys.get(f.field.entity) ?? new Set<string>();
      const key = keyFromLabel(f.field.label, taken);
      taken.add(key);
      keys.set(f.field.entity, taken);
      const values = new Set<string>();
      const options: CustomFieldOption[] = (f.field.options ?? []).map((label) => {
        const value = keyFromLabel(label, values);
        values.add(value);
        return { value, label };
      });
      await tx.customFieldDefinition.create({
        data: {
          entity: f.field.entity,
          key,
          label: f.field.label,
          type: f.field.type,
          options: options as unknown as Prisma.InputJsonValue,
          helpText: f.field.helpText ?? null,
          showInList: !!f.field.showInList,
          sortOrder,
          createdById: actorUserId,
          updatedById: actorUserId,
        },
      });
    }

    // ── Modules the plan includes, switched on ──
    for (const m of plan.modules) {
      if (m.kind === "switch-on") await tx.systemModule.upsert({ where: { key: m.key }, create: { key: m.key, enabled: true }, update: { enabled: true } });
    }
  });

  return { plan, changes: describe(plan) };
}

/** What changed, area by area, in words. */
export function describe(plan: TemplatePlan): string[] {
  const out: string[] = [];
  const renamed = plan.stages.filter((s) => s.kind === "rename").length;
  const added = plan.stages.filter((s) => s.kind === "add").length;
  const retired = plan.stages.filter((s) => s.kind === "retire").length;
  if (renamed || added || retired) out.push(`Pipeline: ${[renamed && `${renamed} renamed`, added && `${added} added`, retired && `${retired} retired`].filter(Boolean).join(", ")}`);
  const steps = plan.steps.filter((s) => s.kind === "add" || s.kind === "restore").length;
  if (steps) out.push(`Order steps: ${steps} added`);
  const words = plan.words.filter((w) => w.kind === "set");
  if (words.length) out.push(`Wording: ${words.map((w) => `${w.from} → ${w.to}`).join(", ")}`);
  const fields = plan.fields.filter((f) => f.kind === "add" || f.kind === "restore").length;
  if (fields) out.push(`Custom fields: ${fields} added`);
  const modules = plan.modules.filter((m) => m.kind === "switch-on");
  if (modules.length) out.push(`Switched on: ${modules.map((m) => m.key).join(", ")}`);
  return out;
}
