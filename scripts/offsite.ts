/**
 * Off-site backups and the log archive by hand (src/lib/offsite, src/lib/logs/archive.ts).
 *
 *   npm run offsite -- status                         the store, and how each kind of work last went
 *   npm run offsite -- check                          write, read, list and delete a small object
 *   npm run offsite -- run <sync|control|logs|drill|clock> [--workspace <slug>]
 *                                                     one now, as the platform worker would
 *   npm run offsite -- list <prefix>                  what the store holds under a prefix
 *   npm run offsite -- fetch <key> <out>              one object, decrypted: a workspace's backup (its
 *                                                     manifest rebuilds the whole dump), the control
 *                                                     plane's dump, a day's logs (as JSON lines), a
 *                                                     support file
 *   npm run offsite -- recover <slug> [--backup <id or file>] [--replace]
 *                                                     a workspace's database made again on this server
 *                                                     from its newest backup off-site (or the one named),
 *                                                     and brought up to this release (runbook §5.10)
 *
 * The store is the one saved in the console. When the control plane itself is what was lost, give it
 * instead — OFFSITE_STORE as JSON and OFFSITE_SECRET, the same values as in the console (docs/runbook.md
 * §5.3) — and fetch its dump:
 *
 *   OFFSITE_STORE='{"provider":"azure","containerUrl":"https://….blob.core.windows.net/deskzo","prefix":"deskzo"}' \
 *   OFFSITE_SECRET='sv=…&sig=…' npm run offsite -- list backups/control/
 *
 * PLATFORM_MASTER_KEY must be the one the copies were sealed under. Nothing is opened without it.
 */
import "dotenv/config";
import { mkdir, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { openBackupFileTo } from "../src/lib/backup/at-rest";
import { reassemble, type Manifest } from "../src/lib/backup/chunks";
import { CHORES, runChore, type Chore } from "../src/lib/offsite/chores";
import { currentStore, parseStoreConfig } from "../src/lib/offsite/config";
import { CONTROL_SEAL } from "../src/lib/offsite/control";
import { checkStore, openStore, type OffsiteStore } from "../src/lib/offsite/store";
import { LOG_SEAL } from "../src/lib/logs/archive";
import { closeControlDb, controlDb } from "../src/lib/platform/control-db";
import { recoverWorkspace } from "../src/lib/offsite/recover";
import { tenantById } from "../src/lib/tenancy/registry";
import { installLogLabels } from "../src/lib/tenancy/log-labels";

installLogLabels();

async function store(): Promise<OffsiteStore> {
  const given = process.env.OFFSITE_STORE?.trim();
  if (given) return openStore(parseStoreConfig(JSON.parse(given)), process.env.OFFSITE_SECRET?.trim() || null);
  const found = await currentStore();
  if (!found) throw new Error("No off-site store is set up — in the console (Settings › Backups & logs), or as OFFSITE_STORE and OFFSITE_SECRET.");
  return found.store;
}

function usage(): never {
  console.error("usage: npm run offsite -- status | check | run <" + CHORES.join("|") + "> [--workspace <slug>] | list <prefix> | fetch <key> <out> | recover <slug> [--backup <id>] [--replace]");
  process.exit(2);
}

/** Which key a stored object is sealed under, and as what. */
function sealOf(key: string): { id: string; what: "dump" | "log" | "file" } | null {
  let m = /^backups\/workspaces\/([^/]+)\/dumps\/[^/]+\.dump$/.exec(key);
  if (m) return { id: m[1], what: "dump" };
  if (/^backups\/control\/[^/]+\.dump$/.test(key)) return { id: CONTROL_SEAL, what: "dump" };
  m = /^logs\/\d{4}-\d{2}-\d{2}\/workspaces\/([^/]+)\.jsonl\.gz$/.exec(key);
  if (m) return { id: m[1], what: "log" };
  if (/^logs\/\d{4}-\d{2}-\d{2}\/(access\/[^/]+|platform)\.jsonl\.gz$/.test(key)) return { id: LOG_SEAL, what: "log" };
  m = /^support\/([^/]+)\/[^/]+\/[^/]+$/.exec(key);
  if (m) return { id: m[1], what: "file" };
  return null;
}

async function fetchOne(s: OffsiteStore, key: string, out: string): Promise<void> {
  const work = path.join(os.tmpdir(), `deskzo-fetch-${process.pid}`);
  await mkdir(work, { recursive: true });
  try {
    const manifest = /^backups\/workspaces\/([^/]+)\/manifests\/[^/]+\.json$/.exec(key);
    if (manifest) {
      // A chunked backup: every piece it names, then rebuilt and checked — a pg_restore-able dump.
      const raw = await s.get(key);
      if (!raw) throw new Error(`No such object: ${key}`);
      const m = JSON.parse(raw.toString("utf8")) as Manifest;
      const tenantId = manifest[1];
      let n = 0;
      for (const hash of new Set(m.chunks)) {
        const target = path.join(work, ".chunks", hash.slice(0, 2), `${hash}.gz`);
        await mkdir(path.dirname(target), { recursive: true });
        if (!(await s.getToFile(`backups/workspaces/${tenantId}/chunks/${hash.slice(0, 2)}/${hash}.gz`, target))) throw new Error(`A piece is missing from the store: ${hash}`);
        if (++n % 100 === 0) console.log(`  ${n} pieces…`);
      }
      await reassemble(work, m, out, tenantId);
      console.log(`Rebuilt the backup taken ${m.takenAt ?? "(time not recorded)"} into ${out} (${(await stat(out)).size} bytes), checksum verified. Restore it with pg_restore --no-owner --no-privileges.`);
      return;
    }
    const seal = sealOf(key);
    const fetched = path.join(work, "object");
    if (!(await s.getToFile(key, fetched))) throw new Error(`No such object: ${key}`);
    if (!seal) {
      await pipeline(createReadStream(fetched), createWriteStream(out));
    } else if (seal.what === "log") {
      const opened = path.join(work, "opened.gz");
      await openBackupFileTo(seal.id, fetched, opened, "log");
      await pipeline(createReadStream(opened), createGunzip(), createWriteStream(out));
    } else {
      await openBackupFileTo(seal.id, fetched, out, seal.what);
    }
    console.log(`Wrote ${out} (${(await stat(out)).size} bytes).`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "status": {
      const found = await currentStore().catch(() => null);
      console.log(found ? `Store: ${found.store.label} — backups ${found.setup.backupKeepDays} days, logs ${found.setup.logKeepDays} days` : "Store: not set up");
      const control = controlDb();
      for (const kind of ["SYNC", "CONTROL_DUMP", "LOGS", "DRILL"] as const) {
        const run = await control.offsiteRun.findFirst({ where: { kind }, orderBy: { startedAt: "desc" } });
        console.log(`${kind.padEnd(13)} ${run ? `${run.startedAt.toISOString()} ${run.status}: ${run.summary ?? ""}${run.error ? `\n${" ".repeat(14)}${run.error.replace(/\n/g, `\n${" ".repeat(14)}`)}` : ""}` : "never"}`);
      }
      return;
    }
    case "check": {
      const s = await store();
      const steps = await checkStore(s);
      console.log(s.label);
      for (const step of steps) console.log(`  ${step.ok ? "ok  " : "FAIL"} ${step.step}: ${step.detail}`);
      if (steps.length < 4 || steps.some((x) => !x.ok)) process.exitCode = 1;
      return;
    }
    case "run": {
      const chore = rest[0] as Chore;
      if (!(CHORES as readonly string[]).includes(chore)) usage();
      let tenantId: string | null = null;
      const at = rest.indexOf("--workspace");
      if (at >= 0) {
        const slug = rest[at + 1];
        const tenant = slug ? await controlDb().tenant.findUnique({ where: { slug }, select: { id: true } }) : null;
        if (!tenant) throw new Error(`There is no workspace "${slug ?? ""}".`);
        tenantId = tenant.id;
      }
      const outcome = await runChore(chore, "script", { tenantId });
      console.log(`${chore}: ${outcome.ran ? (outcome.ok ? "done" : "FAILED") : "not run"} — ${outcome.summary}`);
      if (outcome.error) console.log(outcome.error);
      if (!outcome.ok) process.exitCode = 1;
      return;
    }
    case "list": {
      const s = await store();
      const { objects } = await s.list(rest[0] ?? "");
      for (const o of objects) console.log(`${o.modified?.toISOString() ?? "".padEnd(24)}  ${String(o.size).padStart(12)}  ${o.key}`);
      console.log(`${objects.length} object(s)`);
      return;
    }
    case "fetch": {
      if (!rest[0] || !rest[1]) usage();
      await fetchOne(await store(), rest[0], path.resolve(rest[1]));
      return;
    }
    case "recover": {
      const slug = rest[0];
      if (!slug) usage();
      const row = await controlDb().tenant.findUnique({ where: { slug }, select: { id: true } });
      const tenant = row ? await tenantById(row.id) : null;
      if (!tenant) throw new Error(`There is no workspace "${slug}" in the control plane — restore the control plane first (runbook §5.3).`);
      const at = rest.indexOf("--backup");
      const done = await recoverWorkspace(await store(), tenant, { backup: at >= 0 ? rest[at + 1] : null, replace: rest.includes("--replace") }, (line) => console.log(line));
      console.log(`${slug}: recovered in ${done.seconds} s. Reopen it from the console once you have checked it (and run npm run tenants:migrate if this server's release is newer).`);
      return;
    }
    default:
      usage();
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
