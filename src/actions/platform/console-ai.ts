"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { OWNERS, SELLERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { addSuggestedModels, removeAccount, removeModel, saveAccount, saveModel, saveRoutes, testAccount } from "@/lib/ai/accounts";
import { PackRefused, grantPack } from "@/lib/ai/packs";
import { saveAiPacks, saveTrialAiCredits, setAiPaused } from "@/lib/ai/settings";
import { controlDb } from "@/lib/platform/control-db";
import { refreshTrialWorkspaces } from "@/lib/platform/entitlements";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * Console › Settings › AI (src/lib/ai): where Deskzo AI runs and what it costs. Owners only, like every
 * platform setting — an account's key spends Deskzo's money and carries workspaces' data. Adding credits
 * to one workspace (a goodwill grant, a bank transfer received) is a seller's act, like recording an
 * offline payment. Every change is in the platform audit log, by field name; a secret never is.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    if (err instanceof PackRefused) return { ok: false, error: err.message };
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

/** The kill switch: paused, no AI runs in any workspace until it is lifted. */
export async function consoleSetAiPaused(paused: boolean): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    if (paused !== true && paused !== false) return null;
    await setAiPaused(paused, staff.id);
    await consoleAudit(staff, "ai.paused", { paused });
    revalidateConsole();
    return null;
  });
}

export async function consoleSaveAiAccount(input: unknown): Promise<ConsoleResult<{ id: string; created: boolean }>> {
  return asStaff(OWNERS, async (staff) => {
    const saved = await saveAccount(input, staff.id);
    if (saved.created) await consoleAudit(staff, "ai.account.add", { name: saved.name, kind: saved.kind });
    else if (saved.changed.length) await consoleAudit(staff, "ai.account.change", { name: saved.name, kind: saved.kind, changed: saved.changed });
    revalidateConsole();
    return { id: saved.id, created: saved.created };
  });
}

export async function consoleRemoveAiAccount(id: unknown): Promise<ConsoleResult> {
  return asStaff(OWNERS, async (staff) => {
    const removed = await removeAccount(id);
    await consoleAudit(staff, "ai.account.remove", { name: removed.name, kind: removed.kind });
    revalidateConsole();
    return null;
  });
}

/** A real call through the account — a few tokens, charged to no workspace. A refusal from the provider is the answer, not an error. */
export async function consoleTestAiAccount(input: { accountId: unknown; modelId?: unknown }): Promise<ConsoleResult<{ ok: boolean; model: string | null; error: string | null }>> {
  return asStaff(OWNERS, async (staff) => {
    const result = await testAccount(input?.accountId, input?.modelId);
    await consoleAudit(staff, "ai.account.test", { model: result.model, ok: result.ok });
    revalidateConsole();
    return result;
  });
}

export async function consoleSaveAiModel(input: unknown): Promise<ConsoleResult<{ id: string; created: boolean }>> {
  return asStaff(OWNERS, async (staff) => {
    const saved = await saveModel(input, staff.id);
    if (saved.created) await consoleAudit(staff, "ai.model.add", { key: saved.key });
    else if (saved.changed.length) await consoleAudit(staff, "ai.model.change", { key: saved.key, changed: saved.changed });
    revalidateConsole();
    return { id: saved.id, created: saved.created };
  });
}

export async function consoleRemoveAiModel(id: unknown): Promise<ConsoleResult> {
  return asStaff(OWNERS, async (staff) => {
    const removed = await removeModel(id);
    await consoleAudit(staff, "ai.model.remove", { key: removed.key });
    revalidateConsole();
    return null;
  });
}

export async function consoleAddSuggestedAiModels(accountId: unknown): Promise<ConsoleResult<{ added: string[] }>> {
  return asStaff(OWNERS, async (staff) => {
    const added = await addSuggestedModels(accountId, staff.id);
    if (added.length) await consoleAudit(staff, "ai.model.add", { key: added.join(", ") });
    revalidateConsole();
    return { added };
  });
}

/** Every feature's model at once. */
export async function consoleSaveAiRoutes(routes: unknown): Promise<ConsoleResult<{ changed: string[] }>> {
  return asStaff(OWNERS, async (staff) => {
    const changed = await saveRoutes(routes, staff.id);
    if (changed.length) await consoleAudit(staff, "ai.routes", { changed });
    revalidateConsole();
    return { changed };
  });
}

export async function consoleSaveAiPacks(packs: unknown): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    const saved = await saveAiPacks(packs, staff.id);
    await consoleAudit(staff, "ai.packs", { packs: saved.map((p) => `${p.credits}:${p.inr}`) });
    revalidateConsole();
    return null;
  });
}

/** A free trial's credits; every workspace on its trial is worked out again, so it has the new number at once. */
export async function consoleSaveTrialAiCredits(credits: unknown): Promise<ConsoleResult<{ workspaces: number }>> {
  return asStaff(OWNERS, async (staff) => {
    const saved = await saveTrialAiCredits(credits, staff.id);
    const workspaces = await refreshTrialWorkspaces();
    await consoleAudit(staff, "ai.trial", { credits: saved, workspaces });
    revalidateConsole();
    return { workspaces };
  });
}

/**
 * Credits added to one workspace (Workspace 360 › Usage): given as goodwill, or a bank transfer staff
 * received for a pack. Used after the month's allowance like any pack, for twelve months. Always with a reason.
 */
export async function consoleGrantAiCredits(input: { tenantId: unknown; credits: unknown; reason: unknown; paid?: unknown }): Promise<ConsoleResult<null>> {
  return asStaff(SELLERS, async (staff) => {
    const tenantId = typeof input?.tenantId === "string" ? input.tenantId : "";
    if (!(await controlDb().tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) throw new ConsoleRefused("That workspace no longer exists.");
    const credits = Number(input?.credits);
    const reason = typeof input?.reason === "string" ? input.reason.trim().slice(0, 300) : "";
    if (reason.length < 3) throw new ConsoleRefused("Say why the credits are added — it is kept with them.");
    const paid = input?.paid === true;
    await grantPack({ tenantId, source: paid ? "OFFLINE" : "STAFF", packKey: null, credits, reason, grantedBy: staff.id });
    await consoleAudit(staff, "ai.credits.grant", { credits, paid, reason }, tenantId);
    revalidateConsole();
    return null;
  });
}
