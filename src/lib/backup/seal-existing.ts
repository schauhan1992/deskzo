import { readdir } from "node:fs/promises";
import path from "node:path";
import { sealFileInPlace } from "@/lib/backup/at-rest";
import { chunkDir } from "@/lib/backup/chunks";
import { readSidecar } from "@/lib/backup/sidecar";

/**
 * Encrypts the backups a workspace's folder held from before backups were encrypted at rest (owner, 22 Oct
 * 2026 — src/lib/backup/at-rest.ts): every full backup's file and every piece in the chunk store, each in
 * place, each written beside itself and renamed over it so a failure leaves the original. Run once after
 * the release, `npm run db:backup -- --seal-existing --all-workspaces`; running it again finds nothing to do.
 * Until it has run, the old files still restore as they always did.
 */
export async function sealExistingBackups(directory: string, tenantId: string): Promise<{ dumps: number; chunks: number; already: number }> {
  const result = { dumps: 0, chunks: 0, already: 0 };
  const files = await readdir(directory).catch(() => [] as string[]);
  for (const name of files.filter((f) => f.endsWith(".dump") && !f.startsWith("."))) {
    const file = path.join(directory, name);
    // A dump without its description never finished: not a backup, and not this command's to touch.
    if (!(await readSidecar(file))) continue;
    if (await sealFileInPlace(tenantId, file, "dump")) result.dumps += 1;
    else result.already += 1;
  }
  for (const file of await chunkFiles(chunkDir(directory))) {
    if (await sealFileInPlace(tenantId, file, "chunk")) result.chunks += 1;
    else result.already += 1;
  }
  return result;
}

/** Every piece in the store: `.chunks/ab/<hash>.gz`. */
async function chunkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const fan of await readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, fan);
    for (const name of await readdir(dir).catch(() => [] as string[])) if (name.endsWith(".gz")) out.push(path.join(dir, name));
  }
  return out;
}
