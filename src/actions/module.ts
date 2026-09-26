"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { MODULE_REGISTRY, getModuleDefinition } from "@/lib/modules";
import { isModuleEntitled, moduleAccessFor, switchedOn, type ModuleAccess } from "@/lib/modules-access";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { ActionResult } from "@/actions/company";

export type { ModuleAccess } from "@/lib/modules-access";

/**
 * Every module, with whether this workspace's plan includes it and whether the company has it
 * switched on. `enabled` is both — what the sidebar and the settings list go by. A nav link bound to
 * other countries (the e-way bill register is India's) is left out.
 */
export async function getModuleStates() {
  await requireUser();
  const { country } = await currentTenant();
  return Promise.all(
    MODULE_REGISTRY.map(async (mod) => {
      const entitled = await isModuleEntitled(mod.key);
      const on = await switchedOn(mod.key);
      return {
        ...mod,
        navItems: mod.navItems.filter((item) => !item.countries || item.countries.includes(country)),
        entitled,
        switchedOn: on,
        enabled: entitled && on,
      };
    }),
  );
}

/**
 * Whether this module is available to the person asking: in the plan, switched on for the company,
 * and — for a module with a `viewPermission` — theirs to see.
 *
 * The last half is what makes the `*.view` permissions real rather than cosmetic, and the first is
 * what makes the plan real: there are ~180 calls to this across pages, actions and the dashboard,
 * each already refusing when a module is off. Answering "off" for a module outside the plan, or to
 * somebody without its view permission, makes every one of them refuse too, with nothing new at any
 * call site and so nothing to forget at the next one.
 */
export async function isModuleEnabled(key: string): Promise<boolean> {
  return (await moduleAccess(key)) === "available";
}

/** The same answer as `isModuleEnabled`, with the reason — so a page can say which it is. */
export async function moduleAccess(key: string): Promise<ModuleAccess> {
  const user = await requireUser();
  return moduleAccessFor(user.id, key);
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
  // Switching off stays possible, so a module can be tidied away before a plan changes.
  if (enabled && !(await isModuleEntitled(key))) {
    return { ok: false, error: `${def.label} isn't part of this workspace's plan.` };
  }

  await db.systemModule.upsert({
    where: { key },
    update: { enabled },
    create: { key, enabled },
  });

  revalidatePath("/settings");
  return { ok: true, data: null };
}
