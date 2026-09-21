"use server";

import { revalidatePath } from "next/cache";
import { cache } from "react";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { MODULE_REGISTRY, getModuleDefinition } from "@/lib/modules";
import type { ActionResult } from "@/actions/company";

export async function getModuleStates() {
  await requireUser();
  const rows = await db.systemModule.findMany();
  const overrides = new Map(rows.map((r) => [r.key, r.enabled]));

  return MODULE_REGISTRY.map((mod) => ({
    ...mod,
    enabled: mod.core ? true : (overrides.get(mod.key) ?? true),
  }));
}

/**
 * The module rows, read once per request.
 *
 * `isModuleEnabled` is called from almost every page, several of them more than once, and each call
 * was its own round trip — while the permission resolver sitting beside it has been memoised since
 * it was written. One query per request instead of one per question.
 *
 * Deliberately not exported: a "use server" module publishes every export as an endpoint, and this
 * returns the whole module table rather than an answer to a question.
 */
const moduleStates = cache(async (): Promise<Map<string, boolean>> => {
  const rows = await db.systemModule.findMany({ select: { key: true, enabled: true } });
  return new Map(rows.map((r) => [r.key, r.enabled]));
});

export async function isModuleEnabled(key: string): Promise<boolean> {
  await requireUser();
  const def = getModuleDefinition(key);
  if (!def || def.core) return true;
  const states = await moduleStates();
  // Absent means on: a module nobody has switched off has no row.
  return states.get(key) ?? true;
}

export async function setModuleEnabled(key: string, enabled: boolean): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) {
    return { ok: false, error: "You can't change which modules are switched on." };
  }

  const def = getModuleDefinition(key);
  if (!def) {
    return { ok: false, error: "Unknown module." };
  }
  if (def.core) {
    return { ok: false, error: "This module is core to the app and cannot be disabled." };
  }

  await db.systemModule.upsert({
    where: { key },
    update: { enabled },
    create: { key, enabled },
  });

  revalidatePath("/settings");
  return { ok: true, data: null };
}
