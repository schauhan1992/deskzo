/**
 * Backups encrypted at rest (owner, 22 Oct 2026 — src/lib/backup/at-rest.ts), on files in a scratch folder:
 *
 *   · a piece and a whole file go in encrypted and come back byte for byte; another workspace's key doesn't
 *     open them, a changed byte is caught, and a failed open leaves nothing behind;
 *   · a file from before — never encrypted — reads exactly as it always did;
 *   · one encrypted where there was no platform key (AUTH_SECRET) still opens once there is one;
 *   · the chunk store encrypts its pieces, still finds an unchanged piece by its name, and rebuilds a dump
 *     from old plain pieces and new encrypted ones alike — but not without the workspace;
 *   · `--seal-existing` encrypts an older folder in place, and a second run has nothing to do.
 *
 *   npm run check:backup-at-rest
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isSealed, isSealedFile, openBackupFileTo, openBuffer, sealBuffer, sealFileInPlace, sealingStream, SealedBackupError } from "../src/lib/backup/at-rest";
import { chunkDir, reassemble, storeDump } from "../src/lib/backup/chunks";
import { sealExistingBackups } from "../src/lib/backup/seal-existing";
import { writeSidecar } from "../src/lib/backup/sidecar";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const throws = async (fn: () => Promise<unknown> | unknown) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as Error;
  }
};
const exists = async (file: string) => !!(await readFile(file).catch(() => null));

async function chunkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const fan of await readdir(chunkDir(root)).catch(() => [] as string[])) {
    for (const name of await readdir(path.join(chunkDir(root), fan))) out.push(path.join(chunkDir(root), fan, name));
  }
  return out;
}

async function main() {
  const A = "zz-at-rest-workspace-a";
  const B = "zz-at-rest-workspace-b";
  const dir = await mkdtemp(path.join(os.tmpdir(), "deskzo-at-rest-"));
  try {
    section("A piece");
    const piece = randomBytes(200_000);
    const sealedPiece = sealBuffer(A, piece);
    ok("goes in encrypted, and comes back as it was", isSealed(sealedPiece) && !sealedPiece.includes(piece.subarray(0, 64)) && openBuffer(A, sealedPiece).equals(piece));
    ok("another workspace's key doesn't open it", (await throws(() => openBuffer(B, sealedPiece))) instanceof SealedBackupError);
    const tampered = Buffer.from(sealedPiece);
    tampered[tampered.length - 40] ^= 0xff;
    ok("a changed byte is caught", (await throws(() => openBuffer(A, tampered))) instanceof SealedBackupError);
    ok("one from before, never encrypted, comes back untouched", openBuffer(A, piece).equals(piece));

    section("A whole file");
    const plain = path.join(dir, "plain.bin");
    const body = randomBytes(3 * 1024 * 1024 + 17);
    await writeFile(plain, body);
    const sealed = path.join(dir, "sealed.dump");
    await pipeline(Readable.from([body.subarray(0, 1_000_000), body.subarray(1_000_000)]), sealingStream(A), createWriteStream(sealed));
    ok("written through the cipher, it is encrypted on disk", (await isSealedFile(sealed)) && !(await readFile(sealed)).includes(body.subarray(5000, 5100)));
    const opened = path.join(dir, "opened.dump");
    await openBackupFileTo(A, sealed, opened);
    ok("and opens byte for byte", (await readFile(opened)).equals(body));
    const wrong = path.join(dir, "wrong.dump");
    ok("another workspace can't open it", (await throws(() => openBackupFileTo(B, sealed, wrong))) instanceof SealedBackupError);
    ok("  and nothing half-opened is left behind", !(await exists(wrong)));
    const copied = path.join(dir, "copied.bin");
    await openBackupFileTo(A, plain, copied);
    ok("a file from before is copied as it is", !(await isSealedFile(plain)) && (await readFile(copied)).equals(body));
    const empty = path.join(dir, "empty.dump");
    await pipeline(Readable.from([]), sealingStream(A), createWriteStream(empty));
    const emptyOut = path.join(dir, "empty.out");
    await openBackupFileTo(A, empty, emptyOut);
    ok("an empty one round-trips too", (await readFile(emptyOut)).length === 0);

    section("Encrypted without a platform key, opened with one");
    const was = process.env.PLATFORM_MASTER_KEY;
    // Emptied rather than deleted: a later import that loads .env would put a deleted value back.
    process.env.PLATFORM_MASTER_KEY = "";
    const beforeAdoption = sealBuffer(A, piece);
    process.env.PLATFORM_MASTER_KEY = was ?? randomBytes(32).toString("base64");
    const afterAdoption = sealBuffer(A, piece);
    ok("the file says which key it was under", beforeAdoption[8] === 2 && afterAdoption[8] === 1, `${beforeAdoption[8]} then ${afterAdoption[8]}`);
    ok("  and the one from before still opens", openBuffer(A, beforeAdoption).equals(piece) && openBuffer(A, afterAdoption).equals(piece));
    if (was === undefined) process.env.PLATFORM_MASTER_KEY = "";

    section("The chunk store");
    const store = path.join(dir, "store");
    const dump = path.join(dir, "big.dump");
    const dumpBody = randomBytes(4 * 1024 * 1024);
    await writeFile(dump, dumpBody);
    // Old pieces first, as a store from before this has them: plain.
    const old = await storeDump(store, dump);
    const oldPieces = await chunkFiles(store);
    ok("a store from before holds plain pieces", oldPieces.length > 1 && !(await isSealedFile(oldPieces[0]!)));
    // Change the end, and store again encrypted: the unchanged pieces are found by name and not written again.
    const changed = Buffer.concat([dumpBody.subarray(0, dumpBody.length - 300_000), randomBytes(300_000)]);
    await writeFile(dump, changed);
    const next = await storeDump(store, dump, A);
    const pieces = await chunkFiles(store);
    const sealedNow = (await Promise.all(pieces.map((p) => isSealedFile(p)))).filter(Boolean).length;
    ok("a new backup's new pieces are encrypted, the unchanged ones reused", next.newChunks > 0 && next.newChunks < next.chunks.length && sealedNow === next.newChunks, `${next.newChunks} new of ${next.chunks.length}, ${sealedNow} encrypted`);
    const rebuiltOld = path.join(dir, "rebuilt-old.dump");
    const rebuiltNew = path.join(dir, "rebuilt-new.dump");
    await reassemble(store, old, rebuiltOld, A);
    await reassemble(store, next, rebuiltNew, A);
    ok("both rebuild exactly — old plain pieces and new encrypted ones", (await readFile(rebuiltOld)).equals(dumpBody) && (await readFile(rebuiltNew)).equals(changed));
    const noWorkspace = await throws(() => reassemble(store, next, path.join(dir, "rebuilt-none.dump")));
    ok("not without the workspace to open them", !!noWorkspace && /encrypted/.test(noWorkspace.message), noWorkspace?.message);
    const otherWorkspace = await throws(() => reassemble(store, next, path.join(dir, "rebuilt-b.dump"), B));
    ok("  nor with another's", otherWorkspace instanceof SealedBackupError);

    section("Encrypting an older folder in place");
    const folder = path.join(dir, "folder");
    await storeDump(folder, dump);
    const fullDump = path.join(folder, "deskzo-2026-10-01-120000.dump");
    await writeFile(fullDump, dumpBody);
    await writeSidecar(fullDump, { filename: path.basename(fullDump), takenAt: "2026-10-01T12:00:00.000Z", schemaVersion: null, secretFingerprint: null, via: null, sizeBytes: dumpBody.length, app: "Deskzo One" });
    const unfinished = path.join(folder, "deskzo-2026-10-02-120000.dump");
    await writeFile(unfinished, randomBytes(2048));
    const first = await sealExistingBackups(folder, A);
    ok("every finished backup and every piece is encrypted", first.dumps === 1 && first.chunks > 0 && (await isSealedFile(fullDump)), JSON.stringify(first));
    ok("  a dump that never finished is left alone", !(await isSealedFile(unfinished)));
    const back = path.join(dir, "back.dump");
    await openBackupFileTo(A, fullDump, back);
    ok("  and each still opens to what it was", (await readFile(back)).equals(dumpBody));
    ok("a second run has nothing to do", (await sealFileInPlace(A, fullDump)) === false && (await sealExistingBackups(folder, A)).dumps === 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "\nAll backup-at-rest checks passed." : `\n${failures} backup-at-rest check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
