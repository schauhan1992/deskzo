import type { CustomFieldEntity, LeadStatus, OrderStatus } from "@prisma/client";
import { PIPELINE_LIMITS, kindOf } from "@/lib/pipeline/rules";
import { STEP_LIMITS } from "@/lib/pipeline/order-steps";
import { DEFAULT_TERMS, readOverrides, resolveWording, type Term, type TermKey, type WordingOverrides } from "@/lib/terms/dictionary";
import { CUSTOM_FIELD_ENTITY_LABELS, CUSTOM_FIELD_ENTITY_MODULES, CUSTOM_FIELD_LIMITS } from "@/lib/custom-fields/rules";
import type { IndustryTemplate, TemplateField, TemplateStage, TemplateStep } from "@/lib/industry-templates/catalogue";

/**
 * What applying a template to this workspace would do — worked out from what is there, without writing
 * anything. The preview shows it; apply.ts carries it out. Pure, so the rules can be checked without a
 * database (check:industry-templates).
 *
 * The pipeline is matched by meaning: the first stage that means what one of the template's means is
 * renamed to it, so a lead in "Qualified" is in "Site survey" afterwards without moving. A stage the
 * template has no use for is retired if nobody's lead is in it — Settings → Pipeline can restore it — and
 * stays if somebody's is. Steps and fields that are already there by name are left alone, and one retired
 * under that name is brought back rather than made twice.
 */

export type CurrentStage = { id: string; label: string; status: LeadStatus; archived: boolean; leads: number };
export type CurrentStep = { id: string; label: string; status: OrderStatus; archived: boolean };
export type CurrentField = { id: string; entity: CustomFieldEntity; key: string; label: string; archived: boolean };

export type CurrentState = {
  /** In their order. Empty when the workspace has no stage table rows yet. */
  stages: CurrentStage[];
  steps: CurrentStep[];
  /** The wording as stored (TerminologySettings.overrides). */
  overrides: unknown;
  fields: CurrentField[];
  /** For each module the template switches on: whether it already is, or isn't in the plan. */
  modules: Record<string, "on" | "off" | "not-in-plan">;
  /** Whether Orders and Products are part of this workspace — their fields and steps need them. */
  has: { orders: boolean; items: boolean };
};

export type StageOp =
  | { kind: "keep"; id: string; label: string; status: LeadStatus }
  | { kind: "rename"; id: string; from: string; label: string; status: LeadStatus }
  | { kind: "add"; label: string; status: LeadStatus }
  /** Not the template's, but somebody's lead is in it. */
  | { kind: "stay"; id: string; label: string; status: LeadStatus; leads: number }
  | { kind: "retire"; id: string; label: string; status: LeadStatus }
  | { kind: "skip"; label: string; status: LeadStatus; why: string };

export type StepOp =
  | { kind: "exists"; label: string; status: TemplateStep["status"] }
  | { kind: "restore"; id: string; label: string; status: TemplateStep["status"] }
  | { kind: "add"; label: string; status: TemplateStep["status"] }
  | { kind: "skip"; label: string; status: TemplateStep["status"]; why: string };

export type WordOp = { key: TermKey; from: string; to: string; kind: "set" | "same" };

export type FieldOp =
  | { kind: "exists"; field: TemplateField }
  | { kind: "restore"; id: string; field: TemplateField }
  | { kind: "add"; field: TemplateField }
  | { kind: "skip"; field: TemplateField; why: string };

export type ModuleOp = { key: string; kind: "on" | "switch-on" | "not-in-plan" };

export type TemplatePlan = {
  template: { key: string; name: string };
  stages: StageOp[];
  /** The active pipeline afterwards, in order: what keep, rename, add and stay become. */
  pipeline: Exclude<StageOp, { kind: "retire" } | { kind: "skip" }>[];
  steps: StepOp[];
  words: WordOp[];
  /** The wording to store afterwards: what is there, with the template's words set. */
  overrides: WordingOverrides;
  fields: FieldOp[];
  modules: ModuleOp[];
  /** Nothing would change: the template is already applied, or everything in it is already there. */
  nothingToDo: boolean;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const sameTerm = (a: Term, b: Term) => a.one === b.one && a.many === b.many && a.a === b.a;

export function planPipeline(template: TemplateStage[], current: CurrentStage[]): { stages: StageOp[]; pipeline: TemplatePlan["pipeline"] } {
  const active = current.filter((s) => !s.archived);
  const claimed = new Set<string>();
  const wanted: (StageOp & { kind: "keep" | "rename" | "add" | "skip" })[] = template.map((t) => {
    const match = active.find((s) => s.status === t.status && !claimed.has(s.id));
    if (!match) return { kind: "add", label: t.label, status: t.status };
    claimed.add(match.id);
    return match.label === t.label ? { kind: "keep", id: match.id, label: t.label, status: t.status } : { kind: "rename", id: match.id, from: match.label, label: t.label, status: t.status };
  });
  const leftovers: StageOp[] = active
    .filter((s) => !claimed.has(s.id))
    .map((s) => (s.leads > 0 ? { kind: "stay", id: s.id, label: s.label, status: s.status, leads: s.leads } : { kind: "retire", id: s.id, label: s.label, status: s.status }));

  // A stage that stays keeps its name, and two stages can't share one: the template's gives way.
  const staying = leftovers.filter((s): s is Extract<StageOp, { kind: "stay" }> => s.kind === "stay");
  const resolved = wanted.map((w): StageOp => {
    if (w.kind === "keep" || w.kind === "skip") return w;
    const clash = staying.find((s) => same(s.label, w.label));
    if (!clash) return w;
    const why = `"${clash.label}" stays — somebody's lead is in it — and two stages can't share a name. Rename or retire it first.`;
    return w.kind === "rename" ? { kind: "keep", id: w.id, label: w.from, status: w.status } : { kind: "skip", label: w.label, status: w.status, why };
  });

  const inPipeline = resolved.filter((s): s is TemplatePlan["pipeline"][number] => s.kind === "keep" || s.kind === "rename" || s.kind === "add");
  const open = (s: { status: LeadStatus }) => kindOf(s.status) === "OPEN";
  // The template's open stages, then any that stay; the template's closed ones, then any that stay.
  const pipeline = [...inPipeline.filter(open), ...staying.filter(open), ...inPipeline.filter((s) => !open(s)), ...staying.filter((s) => !open(s))];
  const tooMany = pipeline.length > PIPELINE_LIMITS.stages;
  const stages = [...resolved, ...leftovers].map((s): StageOp => (tooMany && s.kind === "add" ? { kind: "skip", label: s.label, status: s.status, why: `A pipeline has at most ${PIPELINE_LIMITS.stages} stages.` } : s));
  return { stages, pipeline: tooMany ? pipeline.filter((s) => s.kind !== "add") : pipeline };
}

export function planSteps(template: TemplateStep[], current: CurrentStep[], hasOrders: boolean): StepOp[] {
  if (!hasOrders) return template.map((t) => ({ kind: "skip", label: t.label, status: t.status, why: "Orders isn't part of this workspace." }));
  const counts = new Map<string, number>();
  for (const s of current) if (!s.archived) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  return template.map((t): StepOp => {
    if (current.some((s) => !s.archived && s.status === t.status && same(s.label, t.label))) return { kind: "exists", label: t.label, status: t.status };
    const n = counts.get(t.status) ?? 0;
    if (n >= STEP_LIMITS.perStatus) return { kind: "skip", label: t.label, status: t.status, why: `An order status has at most ${STEP_LIMITS.perStatus} steps.` };
    counts.set(t.status, n + 1);
    const retired = current.find((s) => s.archived && s.status === t.status && same(s.label, t.label));
    return retired ? { kind: "restore", id: retired.id, label: retired.label, status: t.status } : { kind: "add", label: t.label, status: t.status };
  });
}

export function planWords(terms: IndustryTemplate["terms"], stored: unknown): { words: WordOp[]; overrides: WordingOverrides } {
  const now = resolveWording(stored);
  const overrides = readOverrides(stored);
  const nextTerms: Partial<Record<TermKey, Term>> = { ...(overrides.terms ?? {}) };
  const words: WordOp[] = [];
  for (const [key, term] of Object.entries(terms) as [TermKey, Term][]) {
    const was = now.terms[key];
    words.push({ key, from: was.one, to: term.one, kind: sameTerm(was, term) ? "same" : "set" });
    // Only what differs from the app's own word is stored, as the wording screen stores it.
    if (sameTerm(term, DEFAULT_TERMS[key])) delete nextTerms[key];
    else nextTerms[key] = term;
  }
  return { words, overrides: { ...overrides, terms: nextTerms } };
}

export function planFields(template: TemplateField[], current: CurrentField[], has: CurrentState["has"]): FieldOp[] {
  const counts = new Map<string, number>();
  for (const f of current) if (!f.archived) counts.set(f.entity, (counts.get(f.entity) ?? 0) + 1);
  return template.map((field): FieldOp => {
    const needs = CUSTOM_FIELD_ENTITY_MODULES[field.entity];
    if ((needs === "orders" && !has.orders) || (needs === "items" && !has.items)) {
      return { kind: "skip", field, why: `${CUSTOM_FIELD_ENTITY_LABELS[field.entity]} isn't part of this workspace.` };
    }
    const onEntity = current.filter((f) => f.entity === field.entity);
    if (onEntity.some((f) => !f.archived && same(f.label, field.label))) return { kind: "exists", field };
    const n = counts.get(field.entity) ?? 0;
    if (n >= CUSTOM_FIELD_LIMITS.fieldsPerEntity) return { kind: "skip", field, why: `${CUSTOM_FIELD_ENTITY_LABELS[field.entity]} have the most fields they can.` };
    counts.set(field.entity, n + 1);
    const retired = onEntity.find((f) => f.archived && same(f.label, field.label));
    return retired ? { kind: "restore", id: retired.id, field } : { kind: "add", field };
  });
}

export function planTemplate(template: IndustryTemplate, current: CurrentState): TemplatePlan {
  const { stages, pipeline } = planPipeline(template.stages, current.stages);
  const steps = planSteps(template.steps, current.steps, current.has.orders);
  const { words, overrides } = planWords(template.terms, current.overrides);
  const fields = planFields(template.fields, current.fields, current.has);
  const modules = template.modules.map((key): ModuleOp => {
    const state = current.modules[key] ?? "not-in-plan";
    return { key, kind: state === "on" ? "on" : state === "off" ? "switch-on" : "not-in-plan" };
  });
  const nothingToDo =
    stages.every((s) => s.kind === "keep" || s.kind === "stay" || s.kind === "skip") &&
    steps.every((s) => s.kind === "exists" || s.kind === "skip") &&
    words.every((w) => w.kind === "same") &&
    fields.every((f) => f.kind === "exists" || f.kind === "skip") &&
    modules.every((m) => m.kind !== "switch-on");
  return { template: { key: template.key, name: template.name }, stages, pipeline, steps, words, overrides, fields, modules, nothingToDo };
}
