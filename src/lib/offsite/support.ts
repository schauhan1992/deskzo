import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { sealingStream } from "@/lib/backup/at-rest";
import { backupBase } from "@/lib/backup/maintenance";
import { KeptByStore, type OffsiteStore } from "@/lib/offsite/store";
import { supportDir } from "@/lib/support/storage";

/**
 * Support requests' attachments and screen recordings off-site (docs/runbook.md §4: "synced off-site
 * with BACKUP_DIR"). The requests are in the control plane, whose dump is off-site too; their files are
 * only on this server's disk.
 *
 *   support/<workspace>/<request>/<attachment>   sealed under the workspace's backup key ("file")
 *
 * A mirror, not an archive: a file the support retention deletes here (src/lib/support/retention.ts)
 * is deleted from the store at the next sync, so the retention promised to customers holds off-site too.
 * Uploads still in staging aren't copied — they belong to no request yet.
 *
 * What was sent is kept in BACKUP_DIR/platform/offsite-support.json, with the store it went to.
 */

type State = { v: 1; store: string; files: Record<string, number> };

const stateFile = () => path.join(backupBase(), "platform", "offsite-support.json");
const SAFE = /^[A-Za-z0-9._-]+$/;

async function readState(store: OffsiteStore): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(stateFile(), "utf8")) as State;
    if (parsed.v === 1 && parsed.store === store.fingerprint) return parsed;
  } catch {
    // None yet.
  }
  return { v: 1, store: store.fingerprint, files: {} };
}

async function saveState(state: State): Promise<void> {
  await mkdir(path.dirname(stateFile()), { recursive: true });
  await writeFile(`${stateFile()}.tmp`, JSON.stringify(state), "utf8");
  await rename(`${stateFile()}.tmp`, stateFile());
}

/** Every sent attachment on disk now, by "<workspace>/<request>/<attachment>". */
async function filesOnDisk(): Promise<Map<string, { full: string; tenantId: string }>> {
  const root = supportDir();
  const out = new Map<string, { full: string; tenantId: string }>();
  for (const tenant of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!tenant.isDirectory() || !SAFE.test(tenant.name)) continue;
    for (const request of await readdir(path.join(root, tenant.name), { withFileTypes: true }).catch(() => [])) {
      if (!request.isDirectory() || request.name === "staging" || !SAFE.test(request.name)) continue;
      for (const file of await readdir(path.join(root, tenant.name, request.name), { withFileTypes: true }).catch(() => [])) {
        if (!file.isFile() || !SAFE.test(file.name) || file.name.endsWith(".tmp")) continue;
        out.set(`${tenant.name}/${request.name}/${file.name}`, { full: path.join(root, tenant.name, request.name, file.name), tenantId: tenant.name });
      }
    }
  }
  return out;
}

export async function syncSupportFiles(store: OffsiteStore): Promise<{ sent: number; bytes: number; removed: number }> {
  const state = await readState(store);
  const onDisk = await filesOnDisk();
  let sent = 0;
  let bytes = 0;
  let removed = 0;

  for (const [rel, { full, tenantId }] of onDisk) {
    if (state.files[rel] !== undefined) continue;
    const temp = path.join(backupBase(), "platform", `.support-${process.pid}.sealing`);
    await mkdir(path.dirname(temp), { recursive: true });
    try {
      await pipeline(createReadStream(full), sealingStream(tenantId, "file"), createWriteStream(temp));
      await store.putFile(`support/${rel}`, temp);
      const { size } = await stat(temp);
      state.files[rel] = size;
      bytes += size;
      sent += 1;
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    if (sent % 50 === 0) await saveState(state);
  }

  for (const rel of Object.keys(state.files)) {
    if (onDisk.has(rel)) continue;
    try {
      await store.remove(`support/${rel}`);
      delete state.files[rel];
      removed += 1;
    } catch (err) {
      if (!(err instanceof KeptByStore)) throw err;
    }
  }

  await saveState(state);
  return { sent, bytes, removed };
}
