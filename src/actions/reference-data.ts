"use server";

import { spawn } from "node:child_process";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { refDb } from "@/lib/platform/reference-db";
import { sealForPlatform } from "@/lib/platform/kek";
import { SHARED_DATA_REFUSAL, mayManageSharedData } from "@/lib/platform/shared-data";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { PIN_DIRECTORY_KEY } from "@/lib/geo/pincode";
import type { ActionResult } from "@/actions/company";

/**
 * The PIN directory's settings page: its API key, and a button that syncs it.
 *
 * ## Shared by every workspace
 *
 * The directory lives in the shared reference database (src/lib/platform/reference-refDb().ts): one copy
 * for every workspace on the server. Any admin can see what is loaded; only the platform may change
 * it (src/lib/platform/shared-data.ts) — a sync started from one workspace would change every other
 * workspace's address lookups.
 *
 * ## The key never comes back
 *
 * Sealed under the platform key (`sealForPlatform` — it belongs to no workspace, so no workspace's
 * keys) and never returned to a browser: the page gets `hasApiKey` and nothing else. Replacing it
 * means typing a new one; there is no "show".
 *
 * ## Syncing is a claim, then a worker
 *
 * `startPinDirectorySync` flips the row to RUNNING in one conditional update — so two admins pressing
 * the button at once start one sync, not two — and then starts `prisma/reference/sync-worker.ts`
 * detached. The worker does the minutes of work and writes its progress back to the row, which is
 * what `getPinDirectory` reads while the page polls. A RUNNING row older than `STALE_AFTER_MS` is a
 * worker that died, and may be claimed again.
 */

const STALE_AFTER_MS = 30 * 60 * 1000;
const TSX_CLI = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const WORKER = path.join(process.cwd(), "prisma", "reference", "sync-worker.ts");

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

export type SyncStatus = "IDLE" | "RUNNING" | "SUCCEEDED" | "FAILED";

export type PinDirectoryState = {
  /** Whether this workspace may change it, rather than only see it. */
  canManage: boolean;
  loaded: {
    postOffices: number;
    pincodes: number;
    source: string;
    loadedAt: string;
    unresolvedStates: Record<string, number>;
  } | null;
  sync: {
    hasApiKey: boolean;
    status: SyncStatus;
    /** RUNNING, but for so long that the worker has evidently died. */
    stale: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    fetched: number;
    total: number | null;
    message: string | null;
  };
};

export async function getPinDirectory(): Promise<ActionResult<PinDirectoryState>> {
  if (!(await requireAdmin())) return { ok: false, error: "You can't manage the PIN directory." };

  const [dataset, postOffices, pinRows, sync] = await Promise.all([
    refDb().referenceDataset.findUnique({ where: { key: PIN_DIRECTORY_KEY } }),
    refDb().postOffice.count(),
    refDb().$queryRaw<{ n: bigint }[]>`SELECT COUNT(DISTINCT pincode) AS n FROM post_offices`,
    refDb().referenceSync.findUnique({ where: { key: PIN_DIRECTORY_KEY } }),
  ]);

  const status = (sync?.status ?? "IDLE") as SyncStatus;
  return {
    ok: true,
    data: {
      canManage: await mayManageSharedData(),
      loaded:
        dataset && postOffices > 0
          ? {
              postOffices,
              pincodes: Number(pinRows[0]?.n ?? 0),
              source: dataset.source,
              loadedAt: dataset.loadedAt.toISOString(),
              unresolvedStates: (dataset.unresolvedStates ?? {}) as Record<string, number>,
            }
          : null,
      sync: {
        hasApiKey: Boolean(sync?.apiKeyCipher),
        status,
        stale: status === "RUNNING" && !!sync?.startedAt && Date.now() - sync.startedAt.getTime() > STALE_AFTER_MS,
        startedAt: sync?.startedAt?.toISOString() ?? null,
        finishedAt: sync?.finishedAt?.toISOString() ?? null,
        fetched: sync?.fetched ?? 0,
        total: sync?.total ?? null,
        message: sync?.message ?? null,
      },
    },
  };
}

export async function savePinDirectoryApiKey(input: string): Promise<ActionResult<null>> {
  const allowed = await requireSharedDataAdmin();
  if (!allowed.ok) return allowed;
  const { user } = allowed;

  const key = String(input ?? "").trim();
  // data.gov.in keys are long hex strings. Refusing whitespace and obvious junk here is cheaper than
  // a sync that fails on its first request with a message about the key.
  if (key.length < 16 || key.length > 200 || /\s/.test(key)) {
    return { ok: false, error: "That doesn't look like a data.gov.in API key — paste the key exactly as it is shown there." };
  }

  const apiKeyCipher = sealForPlatform("reference-sync-key", key);
  await refDb().referenceSync.upsert({
    where: { key: PIN_DIRECTORY_KEY },
    create: { key: PIN_DIRECTORY_KEY, apiKeyCipher },
    update: { apiKeyCipher },
  });
  // The fact of the change, never the value.
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ReferenceSync", entityId: PIN_DIRECTORY_KEY, entityLabel: "PIN directory API key saved" });
  revalidatePath("/settings/pin-directory");
  return { ok: true, data: null };
}

export async function removePinDirectoryApiKey(): Promise<ActionResult<null>> {
  const allowed = await requireSharedDataAdmin();
  if (!allowed.ok) return allowed;
  const { user } = allowed;

  await refDb().referenceSync.updateMany({ where: { key: PIN_DIRECTORY_KEY }, data: { apiKeyCipher: null } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ReferenceSync", entityId: PIN_DIRECTORY_KEY, entityLabel: "PIN directory API key removed" });
  revalidatePath("/settings/pin-directory");
  return { ok: true, data: null };
}

export async function startPinDirectorySync(): Promise<ActionResult<null>> {
  const allowed = await requireSharedDataAdmin();
  if (!allowed.ok) return allowed;
  const { user } = allowed;

  // The claim. Conditional, so it succeeds for exactly one caller: a key must be saved, and no other
  // run may be in progress unless it has gone stale.
  const claimed = await refDb().referenceSync.updateMany({
    where: {
      key: PIN_DIRECTORY_KEY,
      apiKeyCipher: { not: null },
      OR: [{ status: { not: "RUNNING" } }, { startedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } }],
    },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      finishedAt: null,
      fetched: 0,
      total: null,
      message: "Starting…",
      startedById: user.id,
    },
  });

  if (claimed.count === 0) {
    const sync = await refDb().referenceSync.findUnique({ where: { key: PIN_DIRECTORY_KEY }, select: { apiKeyCipher: true } });
    return {
      ok: false,
      error: sync?.apiKeyCipher ? "A sync is already running — it will finish on its own." : "Save a data.gov.in API key first.",
    };
  }

  try {
    /**
     * Detached, unreferenced, no shell, output nowhere — the restore worker's arrangement and for its
     * reasons (see src/app/api/backups/restore/route.ts). No arguments at all: the worker reads what
     * it needs, key included, from the row it was claimed on. No workspace either: it writes the
     * shared reference database, which belongs to none.
     */
    const child = spawn(process.execPath, [TSX_CLI, WORKER], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch (error) {
    await refDb().referenceSync.update({
      where: { key: PIN_DIRECTORY_KEY },
      data: { status: "FAILED", finishedAt: new Date(), message: `Could not start the sync: ${(error as Error).message}` },
    });
    return { ok: false, error: "The sync could not be started." };
  }

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ReferenceSync", entityId: PIN_DIRECTORY_KEY, entityLabel: "PIN directory sync started" });
  return { ok: true, data: null };
}

// ─── World places: GeoNames ───────────────────────────────────────────────────────────────────────
//
// The same arrangement as the PIN directory above — a claim, then a detached worker that writes its
// progress to `reference_syncs` — for GeoNames' states, cities and postal codes outside India
// (prisma/reference/geonames.ts). No key: GeoNames' files are public.

const WORLD_SYNC_KEY = "geonames";
const WORLD_WORKER = path.join(process.cwd(), "prisma", "reference", "geonames-worker.ts");
const WORLD_DATASETS = ["geonames-states", "geonames-cities", "geonames-postal"] as const;

export type WorldPlacesState = {
  /** Whether this workspace may change it, rather than only see it. */
  canManage: boolean;
  loaded: { key: string; rows: number; source: string; loadedAt: string }[];
  sync: { status: SyncStatus; stale: boolean; startedAt: string | null; finishedAt: string | null; done: number; total: number | null; message: string | null };
};

export async function getWorldPlaces(): Promise<ActionResult<WorldPlacesState>> {
  if (!(await requireAdmin())) return { ok: false, error: "You can't manage world places." };
  const [datasets, sync] = await Promise.all([
    refDb().referenceDataset.findMany({ where: { key: { in: [...WORLD_DATASETS] } } }),
    refDb().referenceSync.findUnique({ where: { key: WORLD_SYNC_KEY } }),
  ]);
  const status = (sync?.status ?? "IDLE") as SyncStatus;
  return {
    ok: true,
    data: {
      canManage: await mayManageSharedData(),
      loaded: WORLD_DATASETS.map((key) => datasets.find((d) => d.key === key))
        .filter((d): d is NonNullable<typeof d> => !!d)
        .map((d) => ({ key: d.key, rows: d.rowCount, source: d.source, loadedAt: d.loadedAt.toISOString() })),
      sync: {
        status,
        stale: status === "RUNNING" && !!sync?.startedAt && Date.now() - sync.startedAt.getTime() > STALE_AFTER_MS,
        startedAt: sync?.startedAt?.toISOString() ?? null,
        finishedAt: sync?.finishedAt?.toISOString() ?? null,
        done: sync?.fetched ?? 0,
        total: sync?.total ?? null,
        message: sync?.message ?? null,
      },
    },
  };
}

export async function startWorldPlacesSync(): Promise<ActionResult<null>> {
  const allowed = await requireSharedDataAdmin();
  if (!allowed.ok) return allowed;
  const { user } = allowed;

  // The row may not exist yet; the claim needs one to update.
  await refDb().referenceSync.upsert({ where: { key: WORLD_SYNC_KEY }, create: { key: WORLD_SYNC_KEY }, update: {} });
  const claimed = await refDb().referenceSync.updateMany({
    where: { key: WORLD_SYNC_KEY, OR: [{ status: { not: "RUNNING" } }, { startedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } }] },
    data: { status: "RUNNING", startedAt: new Date(), finishedAt: null, fetched: 0, total: null, message: "Starting…", startedById: user.id },
  });
  if (claimed.count === 0) return { ok: false, error: "A sync is already running — it will finish on its own." };

  try {
    const child = spawn(process.execPath, [TSX_CLI, WORLD_WORKER], { cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env });
    child.unref();
  } catch (error) {
    await refDb().referenceSync.update({
      where: { key: WORLD_SYNC_KEY },
      data: { status: "FAILED", finishedAt: new Date(), message: `Could not start the sync: ${(error as Error).message}` },
    });
    return { ok: false, error: "The sync could not be started." };
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ReferenceSync", entityId: WORLD_SYNC_KEY, entityLabel: "World places sync started" });
  return { ok: true, data: null };
}
