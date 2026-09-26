"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { PIN_DIRECTORY_KEY } from "@/lib/geo/pincode";
import {
  readPinDirectory,
  readWorldPlaces,
  removePinApiKey,
  savePinApiKey,
  startPinSync,
  startWorldSync,
  type PinDirectory,
  type WorldPlaces,
} from "@/lib/platform/reference-sync";
import { SHARED_DATA_REFUSAL, mayManageSharedData } from "@/lib/platform/shared-data";
import type { ActionResult } from "@/actions/company";

export type { SyncStatus } from "@/lib/platform/reference-sync";

/**
 * The PIN directory's and world places' settings pages, inside a workspace.
 *
 * The data is the shared reference database's (src/lib/platform/reference-sync.ts does the work):
 * one copy for every workspace on the server. Any admin can see what is loaded; only the platform may
 * change it (src/lib/platform/shared-data.ts) — from the console, or from the first workspace, which is
 * the installation's own. A sync started from one customer's workspace would change every other's
 * address lookups.
 */

async function requireAdmin() {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "settings.manage"))) return null;
  return user;
}

/** An admin, in the workspace that may change shared data — for anything that writes it. */
async function requireSharedDataAdmin(): Promise<{ ok: true; user: Awaited<ReturnType<typeof requireUser>> } | { ok: false; error: string }> {
  const user = await requireAdmin();
  if (!user) return { ok: false, error: "You can't manage reference data." };
  if (!(await mayManageSharedData())) return { ok: false, error: SHARED_DATA_REFUSAL };
  return { ok: true, user };
}

/** Whether this workspace may change it, rather than only see it. */
export type PinDirectoryState = PinDirectory & { canManage: boolean };
export type WorldPlacesState = WorldPlaces & { canManage: boolean };

export async function getPinDirectory(): Promise<ActionResult<PinDirectoryState>> {
  if (!(await requireAdmin())) return { ok: false, error: "You can't manage the PIN directory." };
  return { ok: true, data: { ...(await readPinDirectory()), canManage: await mayManageSharedData() } };
}

export async function savePinDirectoryApiKey(input: string): Promise<ActionResult<null>> {
  const allowed = await requireSharedDataAdmin();
  if (!allowed.ok) return allowed;
  const saved = await savePinApiKey(input);
  if (!saved.ok) return saved;
  // The fact of the change, never the value.
  await recordAudit({ userId: allowed.user.id, action: "UPDATE", entityType: "ReferenceSync", entityId: PIN_DIRECTORY_KEY, entityLabel: "PIN directory API key saved" });
  revalidatePath("/settings/pin-directory");
  return { ok: true, data: null };
}

export async function removePinDirectoryApiKey(): Promise<ActionResult<null>> {
  const allowed = await requireSharedDataAdmin();
  if (!allowed.ok) return allowed;
  await removePinApiKey();
  await recordAudit({ userId: allowed.user.id, action: "UPDATE", entityType: "ReferenceSync", entityId: PIN_DIRECTORY_KEY, entityLabel: "PIN directory API key removed" });
  revalidatePath("/settings/pin-directory");
  return { ok: true, data: null };
}

export async function startPinDirectorySync(): Promise<ActionResult<null>> {
  const allowed = await requireSharedDataAdmin();
  if (!allowed.ok) return allowed;
  const started = await startPinSync(allowed.user.id);
  if (!started.ok) return started;
  await recordAudit({ userId: allowed.user.id, action: "UPDATE", entityType: "ReferenceSync", entityId: PIN_DIRECTORY_KEY, entityLabel: "PIN directory sync started" });
  return { ok: true, data: null };
}

export async function getWorldPlaces(): Promise<ActionResult<WorldPlacesState>> {
  if (!(await requireAdmin())) return { ok: false, error: "You can't manage world places." };
  return { ok: true, data: { ...(await readWorldPlaces()), canManage: await mayManageSharedData() } };
}

export async function startWorldPlacesSync(): Promise<ActionResult<null>> {
  const allowed = await requireSharedDataAdmin();
  if (!allowed.ok) return allowed;
  const started = await startWorldSync(allowed.user.id);
  if (!started.ok) return started;
  await recordAudit({ userId: allowed.user.id, action: "UPDATE", entityType: "ReferenceSync", entityId: "geonames", entityLabel: "World places sync started" });
  return { ok: true, data: null };
}
