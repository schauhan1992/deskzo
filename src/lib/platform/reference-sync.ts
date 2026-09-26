import { spawn } from "node:child_process";
import path from "node:path";
import { PIN_DIRECTORY_KEY } from "@/lib/geo/pincode";
import { sealForPlatform } from "@/lib/platform/kek";
import { refDb } from "@/lib/platform/reference-db";

/**
 * Keeping the shared reference data current: India Post's PIN directory (from data.gov.in, with a
 * key) and GeoNames' world places (public files). Started from the platform console, or from the
 * first workspace's settings until everybody uses the console (src/actions/reference-data.ts). The
 * callers decide who may; this does it.
 *
 * ## Syncing is a claim, then a worker
 *
 * A sync flips its row to RUNNING in one conditional update — so two people pressing the button at
 * once start one sync, not two — and then starts its worker detached (prisma/reference/sync-worker.ts,
 * geonames-worker.ts). The worker does the minutes of work and writes its progress back to the row,
 * which the pages read while they poll. A RUNNING row older than `STALE_AFTER_MS` is a worker that
 * died, and may be claimed again. The workers belong to no workspace: they write the shared database.
 *
 * ## The key never comes back
 *
 * Sealed under the platform key and never returned to a browser — a page gets `hasApiKey` and nothing
 * else. Replacing it means typing a new one; there is no "show".
 */

const STALE_AFTER_MS = 30 * 60 * 1000;
const TSX_CLI = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const PIN_WORKER = path.join(process.cwd(), "prisma", "reference", "sync-worker.ts");
const WORLD_WORKER = path.join(process.cwd(), "prisma", "reference", "geonames-worker.ts");
const WORLD_SYNC_KEY = "geonames";
const WORLD_DATASETS = ["geonames-states", "geonames-cities", "geonames-postal"] as const;

export type SyncStatus = "IDLE" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type SyncResult = { ok: true } | { ok: false; error: string };

export type PinDirectory = {
  loaded: { postOffices: number; pincodes: number; source: string; loadedAt: string; unresolvedStates: Record<string, number> } | null;
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

export type WorldPlaces = {
  loaded: { key: string; rows: number; source: string; loadedAt: string }[];
  sync: { status: SyncStatus; stale: boolean; startedAt: string | null; finishedAt: string | null; done: number; total: number | null; message: string | null };
};

const staleness = (status: SyncStatus, startedAt: Date | null | undefined) => status === "RUNNING" && !!startedAt && Date.now() - startedAt.getTime() > STALE_AFTER_MS;

export async function readPinDirectory(): Promise<PinDirectory> {
  const [dataset, postOffices, pinRows, sync] = await Promise.all([
    refDb().referenceDataset.findUnique({ where: { key: PIN_DIRECTORY_KEY } }),
    refDb().postOffice.count(),
    refDb().$queryRaw<{ n: bigint }[]>`SELECT COUNT(DISTINCT pincode) AS n FROM post_offices`,
    refDb().referenceSync.findUnique({ where: { key: PIN_DIRECTORY_KEY } }),
  ]);
  const status = (sync?.status ?? "IDLE") as SyncStatus;
  return {
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
      stale: staleness(status, sync?.startedAt),
      startedAt: sync?.startedAt?.toISOString() ?? null,
      finishedAt: sync?.finishedAt?.toISOString() ?? null,
      fetched: sync?.fetched ?? 0,
      total: sync?.total ?? null,
      message: sync?.message ?? null,
    },
  };
}

export async function readWorldPlaces(): Promise<WorldPlaces> {
  const [datasets, sync] = await Promise.all([
    refDb().referenceDataset.findMany({ where: { key: { in: [...WORLD_DATASETS] } } }),
    refDb().referenceSync.findUnique({ where: { key: WORLD_SYNC_KEY } }),
  ]);
  const status = (sync?.status ?? "IDLE") as SyncStatus;
  return {
    loaded: WORLD_DATASETS.map((key) => datasets.find((d) => d.key === key))
      .filter((d): d is NonNullable<typeof d> => !!d)
      .map((d) => ({ key: d.key, rows: d.rowCount, source: d.source, loadedAt: d.loadedAt.toISOString() })),
    sync: {
      status,
      stale: staleness(status, sync?.startedAt),
      startedAt: sync?.startedAt?.toISOString() ?? null,
      finishedAt: sync?.finishedAt?.toISOString() ?? null,
      done: sync?.fetched ?? 0,
      total: sync?.total ?? null,
      message: sync?.message ?? null,
    },
  };
}

export async function savePinApiKey(input: string): Promise<SyncResult> {
  const key = String(input ?? "").trim();
  // data.gov.in keys are long hex strings. Refusing whitespace and obvious junk here is cheaper than
  // a sync that fails on its first request with a message about the key.
  if (key.length < 16 || key.length > 200 || /\s/.test(key)) {
    return { ok: false, error: "That doesn't look like a data.gov.in API key — paste the key exactly as it is shown there." };
  }
  const apiKeyCipher = sealForPlatform("reference-sync-key", key);
  await refDb().referenceSync.upsert({ where: { key: PIN_DIRECTORY_KEY }, create: { key: PIN_DIRECTORY_KEY, apiKeyCipher }, update: { apiKeyCipher } });
  return { ok: true };
}

export async function removePinApiKey(): Promise<void> {
  await refDb().referenceSync.updateMany({ where: { key: PIN_DIRECTORY_KEY }, data: { apiKeyCipher: null } });
}

function startWorker(script: string, key: string): Promise<SyncResult> {
  try {
    /**
     * Detached, unreferenced, no shell, output nowhere — the restore worker's arrangement and for its
     * reasons (see src/app/api/backups/restore/route.ts). No arguments: the worker reads what it needs,
     * key included, from the row it was claimed on.
     */
    spawn(process.execPath, [TSX_CLI, script], { cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env }).unref();
    return Promise.resolve({ ok: true });
  } catch (error) {
    return refDb()
      .referenceSync.update({ where: { key }, data: { status: "FAILED", finishedAt: new Date(), message: `Could not start the sync: ${(error as Error).message}` } })
      .then(() => ({ ok: false as const, error: "The sync could not be started." }));
  }
}

/** `startedById`: who asked — a workspace user's id or a staff member's, for the log. */
export async function startPinSync(startedById: string): Promise<SyncResult> {
  // The claim. Conditional, so it succeeds for exactly one caller: a key must be saved, and no other
  // run may be in progress unless it has gone stale.
  const claimed = await refDb().referenceSync.updateMany({
    where: { key: PIN_DIRECTORY_KEY, apiKeyCipher: { not: null }, OR: [{ status: { not: "RUNNING" } }, { startedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } }] },
    data: { status: "RUNNING", startedAt: new Date(), finishedAt: null, fetched: 0, total: null, message: "Starting…", startedById },
  });
  if (claimed.count === 0) {
    const sync = await refDb().referenceSync.findUnique({ where: { key: PIN_DIRECTORY_KEY }, select: { apiKeyCipher: true } });
    return { ok: false, error: sync?.apiKeyCipher ? "A sync is already running — it will finish on its own." : "Save a data.gov.in API key first." };
  }
  return startWorker(PIN_WORKER, PIN_DIRECTORY_KEY);
}

export async function startWorldSync(startedById: string): Promise<SyncResult> {
  // The row may not exist yet; the claim needs one to update.
  await refDb().referenceSync.upsert({ where: { key: WORLD_SYNC_KEY }, create: { key: WORLD_SYNC_KEY }, update: {} });
  const claimed = await refDb().referenceSync.updateMany({
    where: { key: WORLD_SYNC_KEY, OR: [{ status: { not: "RUNNING" } }, { startedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } }] },
    data: { status: "RUNNING", startedAt: new Date(), finishedAt: null, fetched: 0, total: null, message: "Starting…", startedById },
  });
  if (claimed.count === 0) return { ok: false, error: "A sync is already running — it will finish on its own." };
  return startWorker(WORLD_WORKER, WORLD_SYNC_KEY);
}
