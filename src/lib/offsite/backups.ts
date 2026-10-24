import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { isSealed, isSealedFile, sealBuffer, sealingStream } from "@/lib/backup/at-rest";
import { chunkPath, manifestDir, readManifest, type Manifest } from "@/lib/backup/chunks";
import { backupRootFor, restoreInProgressFor } from "@/lib/backup/maintenance";
import { prunable } from "@/lib/backup/policy";
import { readSidecar, sidecarPath } from "@/lib/backup/sidecar";
import { OFFSITE_KEEP_MINIMUM, type OffsiteSetup } from "@/lib/offsite/config";
import { KeptByStore, type OffsiteStore } from "@/lib/offsite/store";
import { controlDb } from "@/lib/platform/control-db";

/**
 * Copying each workspace's backups off the server, and pruning them there.
 *
 * ## What goes where
 *
 *   backups/workspaces/<id>/chunks/ab/<hash>.gz     a piece of a chunked backup, as it is on disk
 *   backups/workspaces/<id>/manifests/<backup>.json  a chunked backup's list of pieces
 *   backups/workspaces/<id>/dumps/<file>.dump        a full backup, and its sidecar beside it (.json)
 *
 * The same layout as the folder it comes from, so a store can be copied back onto a server and the
 * backups restored from it with nothing but the platform key (docs/runbook.md §5.10).
 *
 * Every piece and every dump goes encrypted (src/lib/backup/at-rest.ts) — one taken before backups
 * were encrypted on disk is encrypted as it is copied, so nothing readable ever reaches the store.
 *
 * ## In what order
 *
 * Pieces first, then the manifest that names them. A manifest in the store is a promise that every
 * piece it lists is there too, so it is written last; a sync cut short leaves pieces nobody names yet,
 * which the next one finishes.
 *
 * ## Knowing what is already there
 *
 * Without asking the store. Each workspace's folder keeps `.offsite/`: `state.json` (the manifests and
 * dumps off-site, with when each was taken, and which store that is) and `chunks.txt` (each piece
 * sent, a line each, appended as it goes). Pieces are named by their contents, so one sent once never
 * needs sending again. A different store — another bucket, another prefix — starts both afresh.
 *
 * Once a week that record is checked against a listing of the store itself: a piece somebody deleted
 * there is forgotten here and sent again with the next backup that needs it.
 *
 * ## Pruning
 *
 * Once a day per workspace: backups older than the days set (35 unless changed) go, keeping the newest
 * three whatever their age — the same rule as on the server (src/lib/backup/policy.ts `prunable`), with
 * a longer window — and a backup outside that window isn't sent in the first place, however long the
 * workspace keeps it here. Then the pieces no remaining manifest names, mark-and-sweep like the server's own
 * (src/lib/backup/chunks.ts collectGarbage): every remaining manifest is read first, and if one can't
 * be, nothing is swept.
 */

const WEEK = 7 * 86_400_000;
const PRUNE_EVERY = 20 * 3_600_000;
/** A full backup without its sidecar is still being written — unless it is this old (before sidecars). */
const UNSIDECARRED_AFTER = 6 * 3_600_000;
const SAVE_EVERY = 100;

export type WorkspaceSync = {
  tenantId: string;
  slug: string;
  skipped?: "no backups" | "restoring" | "unchanged";
  sent: { backups: number; chunks: number; bytes: number };
  pruned: { backups: number; chunks: number; kept: number };
  verified: boolean;
  error: string | null;
};

type State = {
  v: 1;
  store: string;
  /** Chunked backups off-site: their id, and when each was taken. */
  manifests: Record<string, string>;
  /** Full backups off-site: their file name, and when each was taken. */
  dumps: Record<string, string>;
  /** What the folder held at the last sync, so an unchanged one is passed over without reading more. */
  seen: string;
};

const prefixFor = (tenantId: string) => `backups/workspaces/${tenantId}/`;
const stateDir = (root: string) => path.join(root, ".offsite");

async function readState(root: string, store: OffsiteStore): Promise<{ state: State; fresh: boolean }> {
  try {
    const parsed = JSON.parse(await readFile(path.join(stateDir(root), "state.json"), "utf8")) as State;
    if (parsed.v === 1 && parsed.store === store.fingerprint) return { state: parsed, fresh: false };
  } catch {
    // None yet, or unreadable: start again — the weekly check rebuilds it from the store.
  }
  await rm(path.join(stateDir(root), "chunks.txt"), { force: true });
  return { state: { v: 1, store: store.fingerprint, manifests: {}, dumps: {}, seen: "" }, fresh: true };
}

async function saveState(root: string, state: State): Promise<void> {
  await mkdir(stateDir(root), { recursive: true });
  const file = path.join(stateDir(root), "state.json");
  await writeFile(`${file}.tmp`, JSON.stringify(state), "utf8");
  await rename(`${file}.tmp`, file);
}

async function readSent(root: string): Promise<Set<string>> {
  const text = await readFile(path.join(stateDir(root), "chunks.txt"), "utf8").catch(() => "");
  return new Set(text.split("\n").filter((l) => /^[0-9a-f]{64}$/.test(l)));
}

async function writeSent(root: string, hashes: Iterable<string>): Promise<void> {
  await mkdir(stateDir(root), { recursive: true });
  const file = path.join(stateDir(root), "chunks.txt");
  await writeFile(`${file}.tmp`, [...hashes].map((h) => `${h}\n`).join(""), "utf8");
  await rename(`${file}.tmp`, file);
}

/** What the folder holds now: its manifests and full backups by name, hashed — cheap, two directory reads. */
async function folderSignature(root: string): Promise<{ signature: string; manifests: string[]; dumps: string[] }> {
  const manifests = (await readdir(manifestDir(root)).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  const dumps = (await readdir(root).catch(() => [] as string[])).filter((f) => f.endsWith(".dump")).sort();
  const sidecars = await Promise.all(dumps.map((d) => stat(sidecarPath(path.join(root, d))).then(() => "s", () => "-")));
  const signature = createHash("sha256").update(JSON.stringify([manifests, dumps, sidecars])).digest("hex");
  return { signature, manifests, dumps };
}

/** A file sealed for the store: itself when it already is, otherwise a sealed copy beside it that the caller deletes. */
async function sealedFile(file: string, tenantId: string): Promise<{ file: string; temporary: boolean }> {
  if (await isSealedFile(file)) return { file, temporary: false };
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.offsite-${process.pid}`);
  await pipeline(createReadStream(file), sealingStream(tenantId, "dump"), createWriteStream(temp));
  return { file: temp, temporary: true };
}

/** When a dump was taken: its sidecar, else the date in its name (deskzo-YYYY-MM-DD-HHMMSS.dump), else its file's time. */
async function dumpTakenAt(file: string): Promise<string> {
  const sidecar = await readSidecar(file);
  if (sidecar?.takenAt) return sidecar.takenAt;
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(path.basename(file));
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
  return (await stat(file)).mtime.toISOString();
}

/**
 * Brings one workspace's backups off-site up to date. Never throws: what went wrong is the result's
 * `error`, and the next workspace still gets its turn.
 */
export async function syncWorkspace(
  store: OffsiteStore,
  setup: OffsiteSetup,
  tenant: { id: string; slug: string; isDefault: boolean },
  now = new Date(),
): Promise<WorkspaceSync> {
  const result: WorkspaceSync = { tenantId: tenant.id, slug: tenant.slug, sent: { backups: 0, chunks: 0, bytes: 0 }, pruned: { backups: 0, chunks: 0, kept: 0 }, verified: false, error: null };
  const root = backupRootFor(tenant);
  const control = controlDb();
  try {
    if (restoreInProgressFor(tenant)) return { ...result, skipped: "restoring" };
    const folder = await folderSignature(root);
    const { state, fresh } = await readState(root, store);
    const row = await control.offsiteWorkspace.findUnique({ where: { tenantId: tenant.id } });
    const verifyDue = fresh || !row?.lastVerifiedAt || now.getTime() - row.lastVerifiedAt.getTime() > WEEK;
    const pruneDue = !row?.lastPrunedAt || now.getTime() - row.lastPrunedAt.getTime() > PRUNE_EVERY;
    if (folder.manifests.length === 0 && folder.dumps.length === 0 && Object.keys(state.manifests).length === 0 && Object.keys(state.dumps).length === 0) {
      return { ...result, skipped: "no backups" };
    }
    if (!verifyDue && !pruneDue && state.seen === folder.signature) return { ...result, skipped: "unchanged" };

    const prefix = prefixFor(tenant.id);
    let sent = await readSent(root);

    if (verifyDue) {
      sent = await verifyAgainstStore(store, root, prefix, state);
      result.verified = true;
    }

    // What is here and when each was taken, to send only what the store would keep: a backup older than
    // the days kept off-site, and not among the newest three, would be pruned there the same day — and,
    // still being here (a workspace may keep its own longer), sent again the next hour, and the next.
    const manifests = new Map<string, Manifest>();
    const taken: { name: string; at: number }[] = [];
    for (const id of folder.manifests) {
      const manifest = await readManifest(root, id);
      if (!manifest) continue;
      manifests.set(id, manifest);
      const at = manifest.takenAt ?? (await stat(path.join(manifestDir(root), `${id}.json`))).mtime.toISOString();
      manifest.takenAt = at;
      taken.push({ name: `m:${id}`, at: Date.parse(at) });
    }
    const dumpTimes = new Map<string, string>();
    for (const name of folder.dumps) {
      const at = await dumpTakenAt(path.join(root, name)).catch(() => null);
      if (!at) continue;
      dumpTimes.set(name, at);
      taken.push({ name: `d:${name}`, at: Date.parse(at) });
    }
    const newest = new Set(taken.sort((a, b) => b.at - a.at).slice(0, OFFSITE_KEEP_MINIMUM).map((t) => t.name));
    const cutoff = now.getTime() - setup.backupKeepDays * 86_400_000;
    const worthSending = (name: string, at: string) => Date.parse(at) >= cutoff || newest.has(name);

    // Chunked backups: their pieces, then the manifest.
    let sinceSave = 0;
    for (const [id, manifest] of manifests) {
      if (state.manifests[id] || !worthSending(`m:${id}`, manifest.takenAt!)) continue;
      let complete = true;
      for (const hash of manifest.chunks) {
        if (sent.has(hash)) continue;
        const stored = await readFile(chunkPath(root, hash)).catch(() => null);
        if (!stored) {
          // Pruned on the server while this ran, or the store here is damaged — either way not a backup to send.
          complete = false;
          break;
        }
        const body = isSealed(stored) ? stored : sealBuffer(tenant.id, stored, "chunk");
        await store.put(`${prefix}chunks/${hash.slice(0, 2)}/${hash}.gz`, body);
        sent.add(hash);
        await appendFile(path.join(stateDir(root), "chunks.txt"), `${hash}\n`, "utf8").catch(async () => {
          await mkdir(stateDir(root), { recursive: true });
          await appendFile(path.join(stateDir(root), "chunks.txt"), `${hash}\n`, "utf8");
        });
        result.sent.chunks += 1;
        result.sent.bytes += body.length;
        if (++sinceSave >= SAVE_EVERY) {
          sinceSave = 0;
          await saveState(root, state);
        }
      }
      if (!complete) {
        if (await stat(path.join(manifestDir(root), `${id}.json`)).catch(() => null)) {
          throw new Error(`Backup ${id} names a piece that isn't in this server's store — it can't be restored here either.`);
        }
        continue;
      }
      const takenAt = manifest.takenAt!;
      const body = Buffer.from(JSON.stringify(manifest), "utf8");
      await store.put(`${prefix}manifests/${id}.json`, body);
      state.manifests[id] = takenAt;
      result.sent.backups += 1;
      result.sent.bytes += body.length;
    }

    // Full backups: the file, then its sidecar.
    for (const [name, takenAt] of dumpTimes) {
      if (state.dumps[name] || !worthSending(`d:${name}`, takenAt)) continue;
      const file = path.join(root, name);
      const info = await stat(file).catch(() => null);
      if (!info) continue;
      const hasSidecar = !!(await stat(sidecarPath(file)).catch(() => null));
      if (!hasSidecar && now.getTime() - info.mtime.getTime() < UNSIDECARRED_AFTER) continue;
      const sealed = await sealedFile(file, tenant.id);
      try {
        await store.putFile(`${prefix}dumps/${name}`, sealed.file);
        result.sent.bytes += (await stat(sealed.file)).size;
      } finally {
        if (sealed.temporary) await rm(sealed.file, { force: true }).catch(() => {});
      }
      if (hasSidecar) await store.put(`${prefix}dumps/${name}.json`, await readFile(sidecarPath(file)));
      state.dumps[name] = takenAt;
      result.sent.backups += 1;
    }

    if (pruneDue) await pruneWorkspace(store, setup, root, prefix, state, sent, result, now);

    state.seen = folder.signature;
    await saveState(root, state);
    if (result.pruned.chunks > 0 || result.verified) await writeSent(root, sent);

    const offsite = [...Object.values(state.manifests), ...Object.values(state.dumps)].map((t) => new Date(t).getTime()).filter(Number.isFinite);
    const data = {
      latestBackupAt: offsite.length ? new Date(Math.max(...offsite)) : null,
      backups: offsite.length,
      lastSyncedAt: now,
      lastError: null,
      ...(pruneDue ? { lastPrunedAt: now } : {}),
      ...(result.verified ? { lastVerifiedAt: now } : {}),
    };
    await control.offsiteWorkspace.upsert({ where: { tenantId: tenant.id }, create: { tenantId: tenant.id, ...data }, update: data });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    await control.offsiteWorkspace
      .upsert({ where: { tenantId: tenant.id }, create: { tenantId: tenant.id, lastError: result.error.slice(0, 500) }, update: { lastError: result.error.slice(0, 500) } })
      .catch(() => {});
  }
  return result;
}

/**
 * The weekly check: what the store really holds, in place of what this server remembers sending. A
 * manifest whose pieces aren't all there any more is forgotten, so it and its missing pieces are sent
 * again — while the server still has them.
 */
async function verifyAgainstStore(store: OffsiteStore, root: string, prefix: string, state: State): Promise<Set<string>> {
  const { objects } = await store.list(prefix);
  const there = new Set<string>();
  const manifests = new Set<string>();
  const dumps = new Set<string>();
  for (const o of objects) {
    const rest = o.key.slice(prefix.length);
    const chunk = /^chunks\/[0-9a-f]{2}\/([0-9a-f]{64})\.gz$/.exec(rest);
    if (chunk) there.add(chunk[1]);
    else if (/^manifests\/[^/]+\.json$/.test(rest)) manifests.add(rest.slice(10, -5));
    else if (/^dumps\/[^/]+\.dump$/.test(rest)) dumps.add(rest.slice(6));
  }

  for (const id of Object.keys(state.manifests)) if (!manifests.has(id)) delete state.manifests[id];
  for (const name of Object.keys(state.dumps)) if (!dumps.has(name)) delete state.dumps[name];

  for (const id of manifests) {
    let manifest: Manifest | null = await readManifest(root, id);
    if (!manifest) manifest = parseManifest(await store.get(`${prefix}manifests/${id}.json`));
    if (!manifest) continue;
    if (manifest.chunks.every((h) => there.has(h))) state.manifests[id] ??= manifest.takenAt ?? new Date(0).toISOString();
    else delete state.manifests[id];
  }
  for (const name of dumps) {
    if (state.dumps[name]) continue;
    const sidecar = await store.get(`${prefix}dumps/${name}.json`).catch(() => null);
    let takenAt: string | null = null;
    try {
      takenAt = sidecar ? ((JSON.parse(sidecar.toString("utf8")) as { takenAt?: string }).takenAt ?? null) : null;
    } catch {
      takenAt = null;
    }
    state.dumps[name] = takenAt ?? (await dumpTakenAt(path.join(root, name)).catch(() => new Date(0).toISOString()));
  }
  return there;
}

function parseManifest(raw: Buffer | null): Manifest | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw.toString("utf8")) as Partial<Manifest>;
    if (!Array.isArray(m.chunks) || typeof m.sha256 !== "string") return null;
    return { format: 1, chunks: m.chunks, totalBytes: m.totalBytes ?? 0, sha256: m.sha256, newBytes: m.newBytes ?? 0, newChunks: m.newChunks ?? 0, takenAt: m.takenAt, filename: m.filename, schemaVersion: m.schemaVersion ?? null };
  } catch {
    return null;
  }
}

/** Old backups off-site removed by age, then the pieces nothing still names. */
async function pruneWorkspace(store: OffsiteStore, setup: OffsiteSetup, root: string, prefix: string, state: State, sent: Set<string>, result: WorkspaceSync, now: Date): Promise<void> {
  const items = [
    ...Object.entries(state.manifests).map(([id, takenAt]) => ({ filename: `m:${id}`, takenAt: new Date(takenAt), keep: false })),
    ...Object.entries(state.dumps).map(([name, takenAt]) => ({ filename: `d:${name}`, takenAt: new Date(takenAt), keep: false })),
  ];
  const doomed = prunable(items, now, { keepDays: setup.backupKeepDays, keepMinimum: OFFSITE_KEEP_MINIMUM });
  let manifestGone = false;
  for (const item of doomed) {
    const name = item.filename.slice(2);
    const keys = item.filename.startsWith("m:") ? [`${prefix}manifests/${name}.json`] : [`${prefix}dumps/${name}`, `${prefix}dumps/${name}.json`];
    try {
      for (const key of keys) await store.remove(key);
    } catch (err) {
      if (err instanceof KeptByStore) {
        result.pruned.kept += 1;
        continue;
      }
      throw err;
    }
    if (item.filename.startsWith("m:")) {
      delete state.manifests[name];
      manifestGone = true;
    } else delete state.dumps[name];
    result.pruned.backups += 1;
  }
  if (!manifestGone) return;

  // Mark: every manifest still off-site, from this server when it still has it, from the store otherwise.
  const live = new Set<string>();
  for (const id of Object.keys(state.manifests)) {
    const manifest = (await readManifest(root, id)) ?? parseManifest(await store.get(`${prefix}manifests/${id}.json`));
    if (!manifest) return; // An unreadable index is a reason to keep pieces, not to delete them.
    for (const hash of manifest.chunks) live.add(hash);
  }
  // Sweep.
  for (const hash of [...sent]) {
    if (live.has(hash)) continue;
    try {
      await store.remove(`${prefix}chunks/${hash.slice(0, 2)}/${hash}.gz`);
      sent.delete(hash);
      result.pruned.chunks += 1;
    } catch (err) {
      if (!(err instanceof KeptByStore)) throw err;
    }
  }
}

/**
 * The backups of a workspace that is gone — purged, or no longer in the control plane — removed from
 * the store. Purging removes them itself (src/lib/platform/lifecycle.ts); this catches one the store
 * was unreachable for at the time.
 */
export async function removeOrphanedWorkspaces(store: OffsiteStore, keep: Set<string>): Promise<{ workspaces: number; objects: number }> {
  const { prefixes } = await store.list("backups/workspaces/", { delimiter: true });
  let workspaces = 0;
  let objects = 0;
  for (const folder of prefixes) {
    const id = folder.slice("backups/workspaces/".length).replace(/\/$/, "");
    if (!id || keep.has(id)) continue;
    objects += await removeWorkspaceBackups(store, id);
    workspaces += 1;
  }
  return { workspaces, objects };
}

/** Everything off-site for one workspace's backups. Returns how many objects went. */
export async function removeWorkspaceBackups(store: OffsiteStore, tenantId: string): Promise<number> {
  const { objects } = await store.list(prefixFor(tenantId));
  let removed = 0;
  // Manifests first: a half-removed workspace must never look like a backup with missing pieces.
  const ordered = [...objects].sort((a, b) => Number(!a.key.includes("/manifests/")) - Number(!b.key.includes("/manifests/")));
  for (const o of ordered) {
    try {
      await store.remove(o.key);
      removed += 1;
    } catch (err) {
      if (!(err instanceof KeptByStore)) throw err;
    }
  }
  return removed;
}
