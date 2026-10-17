import { z } from "zod";
import { db } from "@/lib/db";
import { leadStages } from "@/lib/pipeline/server";
import { ACTIONS, actorRefusal } from "@/lib/automate/registry";
import { TRIGGERS, triggerPaths } from "@/lib/automate/triggers";
import { LIVE_IN_TEST } from "@/lib/automate/engine";
import { FIELD_HINTS, humanize, type FieldKind, type RecordKind } from "@/lib/automate/field-hints";
import type { ActionRisk } from "@/lib/automate/action-types";

/**
 * Everything the builder offers (Deskzo Automate, Phase 3), as plain data for the browser: the
 * triggers with every field they carry, the actions with their fields — generated from each action's
 * own input schema, so the form and the check that runs it never disagree — whether the workflow's
 * owner may use each one now, and the people, pipelines and stages to choose from.
 */

export type FieldSpec = {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  default?: unknown;
  hint?: string;
  record?: RecordKind;
  options?: { value: string; label: string }[];
  special?: { value: string; label: string }[];
  showWhen?: Record<string, string[]>;
  provider?: string;
  min?: number;
  max?: number;
};

export type ActionSpec = { key: string; label: string; description: string; module: string; risk: ActionRisk; available: boolean; why: string | null; fields: FieldSpec[]; outputs: string[]; liveInTest: boolean };
export type TriggerSpec = { type: string; label: string; group: string; event: boolean; paths: { ref: string; label: string }[] };
export type Catalog = {
  triggers: TriggerSpec[];
  actions: ActionSpec[];
  people: { id: string; name: string }[];
  pipelines: { id: string; name: string; stages: { id: string; label: string }[] }[];
  /** Outside apps the owner may use: their own, and those shared with the workspace. */
  connections: { id: string; name: string; provider: string }[];
  /** The workspace's roles, for an approval anybody with a role may decide. */
  roles: { key: string; name: string }[];
};

const GROUPS: Record<string, string> = { schedule: "Time", manual: "Time", webhook: "Outside apps", lead: "Leads", ticket: "Tickets", document: "Money", invoice: "Money", payment: "Money", order: "Orders", renewal: "Orders", form: "Forms and bookings", booking: "Forms and bookings", task: "Tasks", person: "People" };

type JsonProp = { type?: string; enum?: string[]; default?: unknown; minimum?: number; maximum?: number; maxLength?: number; format?: string; items?: JsonProp };

/** An action's fields, from its input schema and the builder's hints. */
export function fieldsOf(key: string, input: z.ZodType): FieldSpec[] {
  const schema = z.toJSONSchema(input, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, JsonProp>; required?: string[] };
  const hints = FIELD_HINTS[key] ?? {};
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => {
    const hint = hints[name] ?? {};
    const kind: FieldKind =
      hint.kind ??
      (prop.enum
        ? "enum"
        : prop.type === "boolean"
          ? "boolean"
          : prop.type === "integer" || prop.type === "number"
            ? "number"
            : prop.type === "array"
              ? "list"
              : prop.type === "object"
                ? "json"
                : prop.format === "date-time"
                  ? "datetime"
                  : (prop.maxLength ?? 0) > 400
                    ? "longText"
                    : "text");
    return {
      name,
      label: hint.label ?? humanize(name),
      kind,
      required: (schema.required ?? []).includes(name) && prop.default === undefined,
      ...(prop.default !== undefined ? { default: prop.default } : {}),
      ...(hint.hint ? { hint: hint.hint } : {}),
      ...(hint.record ? { record: hint.record } : {}),
      ...(prop.enum ? { options: prop.enum.map((value) => ({ value, label: hint.options?.[value] ?? humanize(value) })) } : {}),
      ...(hint.special ? { special: hint.special } : {}),
      ...(hint.showWhen ? { showWhen: hint.showWhen } : {}),
      ...(hint.provider ? { provider: hint.provider } : {}),
      ...(prop.minimum !== undefined ? { min: prop.minimum } : {}),
      ...(prop.maximum !== undefined ? { max: prop.maximum } : {}),
    };
  });
}

/** The builder's catalogue, for a workflow owned by `ownerId` (whose access decides what is available). */
export async function builderCatalog(ownerId: string): Promise<Catalog> {
  const [people, pipeline, connections, roles] = await Promise.all([
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    leadStages().catch(() => null),
    db.automationConnection.findMany({ where: { OR: [{ ownerUserId: ownerId }, { sharedWithWorkspace: true }] }, orderBy: { name: "asc" }, select: { id: true, name: true, provider: true } }).catch(() => []),
    db.role.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true } }),
  ]);
  const actions: ActionSpec[] = [];
  for (const action of ACTIONS) {
    const refusal = await actorRefusal(ownerId, action as never);
    actions.push({
      key: action.key,
      label: action.label,
      description: action.description,
      module: action.module,
      risk: action.risk,
      available: !refusal,
      why: refusal,
      fields: fieldsOf(action.key, action.input as z.ZodType),
      outputs: [...(action.outputs ?? [])],
      liveInTest: action.risk === "read" || LIVE_IN_TEST.has(action.key),
    });
  }
  return {
    triggers: TRIGGERS.map((t) => ({ type: t.type, label: t.label, group: GROUPS[t.type.split(".")[0]!] ?? "Other", event: t.event, paths: triggerPaths(t.type) })),
    actions,
    people,
    connections,
    roles,
    pipelines: pipeline
      ? pipeline.pipelines.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name, stages: pipeline.stages.filter((s) => s.pipelineId === p.id && !s.archived).map((s) => ({ id: s.id, label: s.label })) }))
      : [],
  };
}
