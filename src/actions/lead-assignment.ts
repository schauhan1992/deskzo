"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ContactDesignation, ItemType, LeadSource } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { chooseOwner } from "@/lib/leads/assign";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { GST_STATE_CODES, stateCodeFromName } from "@/lib/gst-engine";
import { contactDesignationValues } from "@/lib/validation/company";
import type { ActionResult } from "@/actions/company";

/**
 * The lead assignment rules — see src/lib/leads/assign.ts for how they are applied.
 *
 * Priorities are kept as 10, 20, 30… and rewritten whole on every reorder, so "move up" is always a
 * swap of two neighbours and two rules can never tie on the number that orders them.
 */

const ITEM_TYPES = ["SUBSCRIPTION", "GOOD", "SERVICE"] as const satisfies readonly ItemType[];
const STRATEGIES = ["ROUND_ROBIN", "LEAST_LOADED", "SPECIFIC_USER", "ACCOUNT_MANAGER"] as const;

async function requireAdmin() {
  const user = await requireUser();
  return (await hasEffectivePermission(user.id, "settings.manage")) ? user : null;
}

export async function listAssignmentRules() {
  if (!(await requireAdmin())) return null;
  const [rules, brands, people] = await Promise.all([
    db.leadAssignmentRule.findMany({ orderBy: [{ priority: "asc" }, { createdAt: "asc" }] }),
    db.brand.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true, role: true } }),
  ]);
  return { rules, brands, people };
}

const ruleSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().trim().min(2, "Give the rule a name").max(80),
    active: z.boolean().default(true),
    brandIds: z.array(z.string()).default([]),
    itemTypes: z.array(z.enum(ITEM_TYPES)).default([]),
    designations: z.array(z.enum(contactDesignationValues)).default([]),
    sources: z.array(z.enum(LEAD_SOURCE_VALUES)).default([]),
    states: z.array(z.string()).default([]),
    strategy: z.enum(STRATEGIES),
    userIds: z.array(z.string()).default([]),
    skipOnLeave: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    if (r.strategy !== "ACCOUNT_MANAGER" && r.userIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["userIds"], message: "Choose at least one person for this rule to assign to." });
    }
    const unknown = r.states.filter((s) => !stateCodeFromName(s));
    if (unknown.length) ctx.addIssue({ code: "custom", path: ["states"], message: `Not a state: ${unknown.join(", ")}` });
  });

export async function saveAssignmentRule(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage lead assignment." };
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid rule" };
  const r = parsed.data;

  // Only people and brands that exist — a rule pointing at nobody would silently skip every lead.
  const [people, brands] = await Promise.all([
    db.user.count({ where: { id: { in: r.userIds }, active: true } }),
    db.brand.count({ where: { id: { in: r.brandIds } } }),
  ]);
  if (people !== new Set(r.userIds).size) return { ok: false, error: "One of the people chosen is no longer active." };
  if (brands !== new Set(r.brandIds).size) return { ok: false, error: "One of the brands chosen no longer exists." };

  const data = {
    name: r.name,
    active: r.active,
    brandIds: [...new Set(r.brandIds)],
    itemTypes: [...new Set(r.itemTypes)],
    designations: [...new Set(r.designations)] as ContactDesignation[],
    sources: [...new Set(r.sources)] as LeadSource[],
    // Stored as the picker spells them, so the form shows them back exactly.
    states: [...new Set(r.states.map((s) => GST_STATE_CODES[stateCodeFromName(s)!]!))],
    strategy: r.strategy,
    userIds: r.strategy === "ACCOUNT_MANAGER" ? [] : [...new Set(r.userIds)],
    skipOnLeave: r.skipOnLeave,
  };

  let id: string;
  if (r.id) {
    const updated = await db.leadAssignmentRule.update({ where: { id: r.id }, data, select: { id: true } }).catch(() => null);
    if (!updated) return { ok: false, error: "That rule no longer exists." };
    id = updated.id;
  } else {
    // New rules go last: a catch-all added later must not jump ahead of the specific rules.
    const last = await db.leadAssignmentRule.aggregate({ _max: { priority: true } });
    const created = await db.leadAssignmentRule.create({ data: { ...data, priority: (last._max.priority ?? 0) + 10, createdById: user.id }, select: { id: true } });
    id = created.id;
  }

  await recordAudit({ userId: user.id, action: r.id ? "UPDATE" : "CREATE", entityType: "LeadAssignmentRule", entityId: id, entityLabel: r.name });
  revalidatePath("/settings/lead-assignment");
  return { ok: true, data: { id } };
}

export async function deleteAssignmentRule(id: string): Promise<ActionResult<null>> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage lead assignment." };
  const rule = await db.leadAssignmentRule.findUnique({ where: { id }, select: { name: true } });
  if (!rule) return { ok: true, data: null };
  await db.leadAssignmentRule.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "LeadAssignmentRule", entityId: id, entityLabel: rule.name });
  revalidatePath("/settings/lead-assignment");
  return { ok: true, data: null };
}

export async function moveAssignmentRule(id: string, direction: "up" | "down"): Promise<ActionResult<null>> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage lead assignment." };
  const rules = await db.leadAssignmentRule.findMany({ orderBy: [{ priority: "asc" }, { createdAt: "asc" }], select: { id: true } });
  const at = rules.findIndex((r) => r.id === id);
  const to = direction === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= rules.length) return { ok: true, data: null };
  [rules[at], rules[to]] = [rules[to]!, rules[at]!];
  await db.$transaction(async (tx) => {
    for (const op of rules.map((r, i) => tx.leadAssignmentRule.update({ where: { id: r.id }, data: { priority: (i + 1) * 10 } }))) await op;
  });
  revalidatePath("/settings/lead-assignment");
  return { ok: true, data: null };
}

const previewSchema = z.object({
  brandIds: z.array(z.string()).default([]),
  itemTypes: z.array(z.enum(ITEM_TYPES)).default([]),
  designation: z.enum(contactDesignationValues).optional().or(z.literal("")),
  source: z.enum(LEAD_SOURCE_VALUES).default("WEBSITE"),
  state: z.string().optional().or(z.literal("")),
});

/**
 * Who a lead like this would go to — without assigning anything.
 *
 * A dry run: round-robin positions are read, not advanced, so testing the rules does not skip
 * anybody's turn. Account-manager rules are passed over, since a test lead belongs to no account.
 */
export async function previewAssignment(input: unknown): Promise<ActionResult<{ person: string | null; rule: string | null }>> {
  if (!(await requireAdmin())) return { ok: false, error: "You can't manage lead assignment." };
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const p = parsed.data;
  const chosen = await chooseOwner(
    {
      brandIds: p.brandIds,
      itemTypes: p.itemTypes,
      designation: p.designation || null,
      source: p.source,
      state: p.state || null,
      companyOwnerId: null,
    },
    { dryRun: true },
  );
  if (!chosen) return { ok: true, data: { person: null, rule: null } };
  const person = await db.user.findUnique({ where: { id: chosen.userId }, select: { name: true } });
  return { ok: true, data: { person: person?.name ?? null, rule: chosen.note } };
}
