/**
 * app:update — over-the-air updates of the Deskzo phone app's own screens (owner, 23 Oct 2026). Publishing is by
 * hand: pushing to main changes no phone; this does, for every phone whose native build the update fits.
 *
 *   npm run app:update -- publish                 this commit's screens, to every phone on deskzo.com
 *   npm run app:update -- rollback                back to the update before the newest
 *   npm run app:update -- rollback --to <id>      back to that update
 *   npm run app:update -- rollback --embedded     back to the screens that came inside the installed app
 *   npm run app:update -- list                    what's been published
 *
 *   --server http://localhost:3000   a Deskzo on this computer instead of https://deskzo.com
 *   --key <file>                     the update key (default ~/.deskzo/app-updates/private-key.pem, or
 *                                    DESKZO_APP_UPDATE_KEY)
 *   --allow-uncommitted              publish screens that aren't committed (for a test on this computer)
 *
 * What it does: `expo export` builds the screens (mobile/), the update is described in a manifest naming each file
 * by its hash, and the manifest is signed here with the update key — the private half of mobile/certs/certificate.pem,
 * which the app checks every update against. The server keeps nothing it can't verify against that certificate, so
 * the key is all there is to publishing: keep it safe, and back it up — without it no update reaches the phones
 * already installed, and a new store release (with a new certificate) would be needed.
 *
 * A phone takes an update only for its own native build: the runtime version is a fingerprint of the app's native
 * parts (mobile/app.config.ts `runtimeVersion`). Anything native — a new library, a permission — needs a store
 * release; an update made after it reaches only phones that have that release.
 */
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = path.join(__dirname, "..");
const MOBILE = path.join(ROOT, "mobile");
const PLATFORM = "android";

const args = process.argv.slice(2);
const command = args[0];
const option = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : null;
};
const flag = (name: string) => args.includes(name);
const server = (option("--server") ?? "https://deskzo.com").replace(/\/+$/, "");

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

/** The phone app's own tooling, as a release build would run it — never the development build's settings. */
function inMobile(cmd: string, cmdArgs: string[]): string {
  const env = { ...process.env };
  delete env.DESKZO_APP_DEV;
  const r = spawnSync(cmd, cmdArgs, { cwd: MOBILE, env, shell: process.platform === "win32", encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) fail(`${cmd} ${cmdArgs.join(" ")} failed:\n${(r.stderr || r.stdout || "").slice(-3000)}`);
  return r.stdout;
}

function git(cmdArgs: string[]): string {
  const r = spawnSync("git", cmdArgs, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

/** The native build the screens here fit — what a phone says it runs. */
function runtimeVersion(): string {
  const out = inMobile("npx", ["expo-updates", "runtimeversion:resolve", "--platform", PLATFORM]);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("{"));
  const rv = line ? (JSON.parse(line) as { runtimeVersion?: string }).runtimeVersion : null;
  if (!rv) fail("Couldn't work out the app's runtime version.");
  return rv;
}

/** The update key, checked against the certificate the app trusts — so a wrong key is caught here, not by the server. */
function updateKey(): KeyObject {
  const file = option("--key") ?? process.env.DESKZO_APP_UPDATE_KEY ?? path.join(homedir(), ".deskzo", "app-updates", "private-key.pem");
  if (!existsSync(file)) fail(`No update key at ${file}. Publishing needs Deskzo's update key (see mobile/README.md, "Updates over the air").`);
  const key = createPrivateKey(readFileSync(file, "utf8"));
  const probe = Buffer.from("deskzo");
  const trusted = createPublicKey(readFileSync(path.join(MOBILE, "certs", "certificate.pem"), "utf8"));
  if (!verify("sha256", probe, trusted, sign("sha256", probe, key))) fail(`The key at ${file} isn't the one mobile/certs/certificate.pem trusts.`);
  return key;
}

const signatureOf = (body: string, key: KeyObject) => `sig="${sign("sha256", Buffer.from(body, "utf8"), key).toString("base64")}", keyid="main", alg="rsa-v1_5-sha256"`;

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  json: "application/json",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  pdf: "application/pdf",
};

type File = { hash: string; key: string; contentType: string; fileExtension: string; bytes: Buffer };

function fileAt(relative: string, ext: string, contentType: string, dir: string): File {
  const bytes = readFileSync(path.join(dir, relative));
  return { hash: createHash("sha256").update(bytes).digest("base64url"), key: createHash("md5").update(bytes).digest("hex"), contentType, fileExtension: `.${ext}`, bytes };
}

const assetUrl = (hash: string) => `${server}/api/app-updates/assets/${hash}`;
const asManifestFile = (f: Omit<File, "bytes">) => ({ hash: f.hash, key: f.key, contentType: f.contentType, fileExtension: f.fileExtension, url: assetUrl(f.hash) });

async function send(kind: "UPDATE" | "ROLL_BACK_TO_EMBEDDED", body: string, key: KeyObject, files: File[]) {
  const form = new FormData();
  form.append("package", JSON.stringify({ kind, body, signature: signatureOf(body, key) }));
  for (const f of files) form.append(f.hash, new Blob([new Uint8Array(f.bytes)], { type: f.contentType }), `${f.key}${f.fileExtension}`);
  const res = await fetch(`${server}/api/app-updates/publish`, { method: "POST", body: form });
  const answer = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
  if (!res.ok) fail(`${server} refused it (${res.status}): ${answer.error ?? "no reason given"}`);
  return answer;
}

type HistoryRow = { id: string; kind: "UPDATE" | "ROLL_BACK_TO_EMBEDDED"; runtimeVersion: string; createdAt: string; publishedAt: string; commit: string | null; body: string | null };

async function history(rv: string | null): Promise<HistoryRow[]> {
  const res = await fetch(`${server}/api/app-updates/history?platform=${PLATFORM}${rv ? `&runtime-version=${encodeURIComponent(rv)}` : ""}`);
  if (!res.ok) fail(`${server} didn't list its updates (${res.status}).`);
  return ((await res.json()) as { updates: HistoryRow[] }).updates;
}

async function publish() {
  const dirty = git(["status", "--porcelain", "--", "mobile"]);
  if (dirty && !flag("--allow-uncommitted")) fail(`The app has uncommitted changes — commit them first, so what phones run is a commit:\n${dirty}`);
  const key = updateKey();
  const commit = git(["rev-parse", "--short", "HEAD"]) || "unknown";
  console.log("Working out the native build…");
  const rv = runtimeVersion();

  console.log("Building the screens (expo export)…");
  const out = path.join("dist", "updates", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(path.join(MOBILE, out), { recursive: true });
  inMobile("npx", ["expo", "export", "--platform", PLATFORM, "--output-dir", out]);
  const dir = path.join(MOBILE, out);
  const meta = JSON.parse(readFileSync(path.join(dir, "metadata.json"), "utf8")) as { fileMetadata: Record<string, { bundle: string; assets: { path: string; ext: string }[] }> };
  const built = meta.fileMetadata[PLATFORM];
  if (!built) fail("expo export made nothing for Android.");
  const launch = fileAt(built.bundle, "bundle", "application/javascript", dir);
  const assets = built.assets.map((a) => fileAt(a.path, a.ext, TYPES[a.ext.toLowerCase()] ?? "application/octet-stream", dir));
  // What the app reads as its own config (expo-constants) while it runs an update.
  const expoClient = JSON.parse(inMobile("npx", ["expo", "config", "--type", "public", "--json"]));

  const manifest = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    runtimeVersion: rv,
    launchAsset: asManifestFile(launch),
    assets: assets.map(asManifestFile),
    metadata: { platform: PLATFORM, commit },
    extra: { expoClient },
  };
  const files = [launch, ...assets.filter((a, i, all) => a.hash !== launch.hash && all.findIndex((b) => b.hash === a.hash) === i)];
  const size = files.reduce((n, f) => n + f.bytes.byteLength, 0);
  console.log(`Publishing ${files.length} files (${(size / 1024 / 1024).toFixed(1)} MB) to ${server}…`);
  const done = await send("UPDATE", JSON.stringify(manifest), key, files);
  console.log(`\nPublished update ${done.id} — commit ${commit}, for the native build ${rv.slice(0, 12)}…`);
  console.log("Phones on that build download it at their next launch and run it from the launch after (or at once, from Settings).");
}

async function rollback() {
  const key = updateKey();
  const rv = option("--runtime") ?? runtimeVersion();
  const rows = await history(rv);
  const now = new Date().toISOString();
  if (flag("--embedded")) {
    const body = JSON.stringify({ type: "rollBackToEmbedded", parameters: { commitTime: now }, extra: { id: randomUUID(), runtimeVersion: rv, platform: PLATFORM } });
    await send("ROLL_BACK_TO_EMBEDDED", body, key, []);
    console.log(`\nPhones on the native build ${rv.slice(0, 12)}… go back to the screens that came inside the app, at their next launch.`);
    return;
  }
  const updates = rows.filter((r) => r.kind === "UPDATE" && r.body);
  const to = option("--to");
  const current = rows[0];
  const target = to ? updates.find((u) => u.id === to) : current?.kind === "UPDATE" ? updates[1] : undefined;
  if (!target) {
    fail(
      to
        ? `No update ${to} for this native build (npm run app:update -- list).`
        : current?.kind === "UPDATE"
          ? "There's no earlier update to go back to — use --embedded for the screens inside the app."
          : "Phones are already back on the screens inside the app; publish again, or name an update with --to.",
    );
  }
  const old = JSON.parse(target.body!) as { metadata?: Record<string, string> } & Record<string, unknown>;
  // A new id and a new date: phones run the newest update they have, so going back is publishing the old screens anew.
  const body = JSON.stringify({ ...old, id: randomUUID(), createdAt: now, metadata: { ...old.metadata, republished: target.id } });
  const done = await send("UPDATE", body, key, []);
  console.log(`\nRepublished ${target.id} (commit ${target.commit ?? "?"}) as ${done.id}: phones go back to it at their next launch.`);
}

async function list() {
  const rv = flag("--all") ? null : runtimeVersion();
  const rows = await history(rv);
  if (!rows.length) return console.log(`Nothing published${rv ? " for this native build" : ""} on ${server}.`);
  console.log(`${rv ? `Native build ${rv.slice(0, 12)}…` : "Every native build"} on ${server}, newest first:\n`);
  for (const r of rows) {
    const what = r.kind === "UPDATE" ? `update ${r.id}  commit ${r.commit ?? "?"}` : "back to the screens inside the app";
    const at = new Date(r.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
    console.log(`  ${at}  ${what}${rv ? "" : `  build ${r.runtimeVersion.slice(0, 12)}…`}`);
  }
}

const commands: Record<string, () => Promise<void>> = { publish, rollback, list };
const run = command ? commands[command] : undefined;
if (!run) fail("Say what to do: publish, rollback or list (see the top of scripts/app-update.ts).");
run().catch((e) => fail(e instanceof Error ? e.message : String(e)));
