/**
 * check:offsite — backups and logs kept off the server (src/lib/offsite, src/lib/logs).
 *
 * On a scratch control plane of its own (<db>_offsite_control, dropped at the end, pass or fail), with
 * BACKUP_DIR, SUPPORT_DIR and LOG_DIR in a temporary folder:
 *
 *   · the three stores — a fake S3 that checks every request's Signature Version 4 with AWS's own signer
 *     (@smithy/signature-v4), a fake Azure Blob that wants its SAS token, and a folder — each written,
 *     read, listed a page at a time and by folder, deleted; a retention lock is "kept", not a failure;
 *     the hand-written signer agrees with AWS's worked example;
 *   · the store's settings: plain http only to this machine, no SAS token in the address, a folder never
 *     inside BACKUP_DIR, logs never kept under CERT-In's 180 days;
 *   · the sync: pieces before manifests, everything sealed (a backup from before sealing too), a second
 *     run sending nothing, the store's retention by age keeping the newest three, unused pieces swept and
 *     only those, a piece lost from the store sent again at the weekly check, support files mirrored
 *     (staging never), a closed workspace's backups removed;
 *   · the control plane's dump, sealed and off-site; a restore drill of a real workspace backup fetched
 *     back from the store into a scratch database that is dropped after; a drill that fails, and its alert;
 *     the control plane's dump restored the same way;
 *   · the access log: a line a request, by UTC day and process, archived sealed once the day is over,
 *     kept here two weeks after; a workspace's security logs for a day, exported as they are in the
 *     database — without session ids or the values a change carried; the platform's own; old days pruned;
 *   · the clock against a time server (a fake one on this machine), and its alert;
 *   · the console: an owner saves the store (its secret sealed, in no audit entry and on no page), an
 *     admin can't; Check connection; Run now reaching the worker; the page, and the settings index.
 *
 * Nothing leaves this machine: every store is local, and so is the time server.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import http from "node:http";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";

const TMP = mkdtempSync(path.join(os.tmpdir(), "deskzo-offsite-"));
process.env.BACKUP_DIR = path.join(TMP, "backups");
process.env.SUPPORT_DIR = path.join(TMP, "support");
process.env.LOG_DIR = path.join(TMP, "logs");
process.env.ACCESS_LOG = "on";
process.env.DESKZO_TENANCY_FALLBACK = "legacy";
mkdirSync(process.env.BACKUP_DIR, { recursive: true });

let failures = 0;
const ok = (label: string, pass: boolean, detail?: unknown) => {
  if (!pass) failures += 1;
  console.log(`${pass ? "  ✓" : "  ✗"} ${label}${pass || detail === undefined ? "" : `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
}
const DAY = 86_400_000;
const dayKey = (at: Date) => at.toISOString().slice(0, 10);

// Nothing here calls out — fetch is not how the stores talk, but nothing else may use it either.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`check:offsite makes no outside calls — ${String(input)}`);
}) as typeof fetch;

// ─── The console's request ─────────────────────────────────────────────────────────────────────
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:offsite" });
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/settings/offsite",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// ─── A fake S3, checking each signature with AWS's own signer ──────────────────────────────────
const S3_KEY = { accessKeyId: "AKIAZZOFFSITECHECK01", secretAccessKey: `zz${randomBytes(18).toString("base64url")}` };
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Fake = { server: http.Server; port: number; objects: Map<string, { body: Buffer; at: Date }>; requests: number; refused: string[] };

function listPage(objects: Map<string, { body: Buffer; at: Date }>, prefix: string, delimiter: boolean, start: number, size: number) {
  const entries: { kind: "object" | "prefix"; key: string }[] = [];
  const seen = new Set<string>();
  for (const key of [...objects.keys()].sort()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (delimiter && rest.includes("/")) {
      const folder = prefix + rest.slice(0, rest.indexOf("/") + 1);
      if (!seen.has(folder)) {
        seen.add(folder);
        entries.push({ kind: "prefix", key: folder });
      }
    } else entries.push({ kind: "object", key });
  }
  return { page: entries.slice(start, start + size), more: start + size < entries.length, next: start + size };
}

async function fakeS3(bucket: string): Promise<Fake> {
  const fake: Fake = { server: null as unknown as http.Server, port: 0, objects: new Map(), requests: 0, refused: [] };
  const signer = new SignatureV4({ credentials: S3_KEY, region: "ap-south-1", service: "s3", sha256: Sha256, uriEscapePath: false, applyChecksum: false });
  fake.server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", async () => {
      fake.requests += 1;
      const body = Buffer.concat(parts);
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const deny = (status: number, code: string) => {
        fake.refused.push(`${req.method} ${url.pathname} ${code}`);
        res.writeHead(status, { "content-type": "application/xml" }).end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
      };
      const amzDate = String(req.headers["x-amz-date"] ?? "");
      const hash = String(req.headers["x-amz-content-sha256"] ?? "");
      if (hash !== sha256(body)) return deny(400, "XAmzContentSHA256Mismatch");
      if ((req.method === "PUT" && req.headers["content-length"] === undefined) || req.headers["transfer-encoding"]) return deny(411, "MissingContentLength");
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (query[k] = v));
      const signingDate = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
      const expected = await signer.sign(
        { method: req.method ?? "GET", protocol: "http:", hostname: "127.0.0.1", port: fake.port, path: url.pathname, query, headers: { host: String(req.headers.host), "x-amz-content-sha256": hash } },
        { signingDate },
      );
      if (expected.headers.authorization !== req.headers.authorization) return deny(403, "SignatureDoesNotMatch");
      const [, b, ...rest] = url.pathname.split("/");
      if (b !== bucket) return deny(404, "NoSuchBucket");
      const key = decodeURIComponent(rest.join("/"));
      if (!key && req.method === "GET" && query["list-type"] === "2") {
        const size = Math.min(3, Number(query["max-keys"] ?? 1000));
        const { page, more, next } = listPage(fake.objects, query.prefix ?? "", query.delimiter === "/", Number(query["continuation-token"] ?? 0), size);
        const xml =
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>${more}</IsTruncated>` +
          page
            .map((e) =>
              e.kind === "object"
                ? `<Contents><Key>${xmlEscape(e.key)}</Key><LastModified>${fake.objects.get(e.key)!.at.toISOString()}</LastModified><Size>${fake.objects.get(e.key)!.body.length}</Size></Contents>`
                : `<CommonPrefixes><Prefix>${xmlEscape(e.key)}</Prefix></CommonPrefixes>`,
            )
            .join("") +
          (more ? `<NextContinuationToken>${next}</NextContinuationToken>` : "") +
          `</ListBucketResult>`;
        return res.writeHead(200, { "content-type": "application/xml" }).end(xml);
      }
      if (req.method === "PUT") {
        fake.objects.set(key, { body, at: new Date() });
        return res.writeHead(200).end();
      }
      if (req.method === "GET") {
        const found = fake.objects.get(key);
        if (!found) return deny(404, "NoSuchKey");
        return res.writeHead(200, { "content-length": found.body.length }).end(found.body);
      }
      if (req.method === "DELETE") {
        if (key.includes("locked/")) return deny(403, "AccessDenied");
        fake.objects.delete(key);
        return res.writeHead(204).end();
      }
      deny(405, "MethodNotAllowed");
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.port = (fake.server.address() as { port: number }).port;
  return fake;
}

// ─── A fake Azure Blob container, wanting its SAS token ────────────────────────────────────────
const SAS = `sv=2023-11-03&ss=b&srt=co&sp=racwdl&se=2030-01-01T00:00:00Z&sig=${randomBytes(12).toString("hex")}`;

async function fakeAzure(account: string, container: string): Promise<Fake> {
  const fake: Fake = { server: null as unknown as http.Server, port: 0, objects: new Map(), requests: 0, refused: [] };
  const sig = new URLSearchParams(SAS).get("sig");
  fake.server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      fake.requests += 1;
      const body = Buffer.concat(parts);
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const deny = (status: number, code: string) => {
        fake.refused.push(`${req.method} ${url.pathname} ${code}`);
        res.writeHead(status, { "content-type": "application/xml" }).end(`<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
      };
      if (url.searchParams.get("sig") !== sig || !url.searchParams.get("sv")) return deny(403, "AuthenticationFailed");
      if (!req.headers["x-ms-version"]) return deny(400, "MissingRequiredHeader");
      const [, a, c, ...rest] = url.pathname.split("/");
      if (a !== account || c !== container) return deny(404, "ContainerNotFound");
      const key = decodeURIComponent(rest.join("/"));
      if (!key && req.method === "GET" && url.searchParams.get("comp") === "list" && url.searchParams.get("restype") === "container") {
        const size = Math.min(3, Number(url.searchParams.get("maxresults") ?? 5000));
        const { page, more, next } = listPage(fake.objects, url.searchParams.get("prefix") ?? "", url.searchParams.get("delimiter") === "/", Number(url.searchParams.get("marker") || 0), size);
        const xml =
          `<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>` +
          page
            .map((e) =>
              e.kind === "object"
                ? `<Blob><Name>${xmlEscape(e.key)}</Name><Properties><Last-Modified>${fake.objects.get(e.key)!.at.toUTCString()}</Last-Modified><Content-Length>${fake.objects.get(e.key)!.body.length}</Content-Length><BlobType>BlockBlob</BlobType></Properties></Blob>`
                : `<BlobPrefix><Name>${xmlEscape(e.key)}</Name></BlobPrefix>`,
            )
            .join("") +
          `</Blobs><NextMarker>${more ? next : ""}</NextMarker></EnumerationResults>`;
        return res.writeHead(200, { "content-type": "application/xml" }).end(xml);
      }
      if (req.method === "PUT") {
        if (req.headers["x-ms-blob-type"] !== "BlockBlob") return deny(400, "MissingRequiredHeader");
        if (req.headers["content-length"] === undefined || req.headers["transfer-encoding"]) return deny(411, "MissingContentLength");
        fake.objects.set(key, { body, at: new Date() });
        return res.writeHead(201).end();
      }
      if (req.method === "GET") {
        const found = fake.objects.get(key);
        if (!found) return deny(404, "BlobNotFound");
        return res.writeHead(200, { "content-length": found.body.length }).end(found.body);
      }
      if (req.method === "DELETE") {
        if (key.includes("locked/")) return deny(409, "BlobImmutableDueToPolicy");
        if (!fake.objects.delete(key)) return deny(404, "BlobNotFound");
        return res.writeHead(202).end();
      }
      deny(405, "UnsupportedHttpVerb");
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.port = (fake.server.address() as { port: number }).port;
  return fake;
}

// ─── A fake time server ────────────────────────────────────────────────────────────────────────
async function fakeNtp(aheadMs: number): Promise<{ port: number; close: () => void }> {
  const socket = createSocket("udp4");
  socket.on("message", (msg, from) => {
    const reply = Buffer.alloc(48);
    reply[0] = 0x24; // LI 0, version 4, mode 4 (server)
    const put = (at: number, ms: number) => {
      const seconds = Math.floor(ms / 1000) + 2_208_988_800;
      reply.writeUInt32BE(seconds >>> 0, at);
      reply.writeUInt32BE(Math.floor(((ms % 1000) / 1000) * 2 ** 32) >>> 0, at + 4);
    };
    const t = Date.now() + aheadMs;
    put(32, t);
    put(40, t);
    socket.send(reply, from.port, from.address);
    void msg;
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { port: socket.address().port, close: () => socket.close() };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const storeLib = require("../src/lib/offsite/store") as typeof import("../src/lib/offsite/store");
  const config = require("../src/lib/offsite/config") as typeof import("../src/lib/offsite/config");
  const { directClient } = require("../src/lib/tenancy/direct-client") as typeof import("../src/lib/tenancy/direct-client");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const s3 = await fakeS3("deskzo-backups");
  const azure = await fakeAzure("devaccount", "deskzo");
  const folderRoot = path.join(TMP, "offsite-folder");
  const s3Config = { provider: "s3" as const, endpoint: `http://127.0.0.1:${s3.port}`, region: "ap-south-1", bucket: "deskzo-backups", accessKeyId: S3_KEY.accessKeyId, pathStyle: true, prefix: "check" };
  const azureConfig = { provider: "azure" as const, containerUrl: `http://127.0.0.1:${azure.port}/devaccount/deskzo`, prefix: "check" };

  section("Signing an S3 request");
  {
    const signed = storeLib.s3Signature({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      pathname: "/",
      query: { prefix: "J", "max-keys": "2" },
      payloadHash: sha256(""),
      amzDate: "20130524T000000Z",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    ok(
      "AWS's worked example (GET Bucket, list objects) signs to its published signature",
      signed.authorization.endsWith("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7") && signed.canonicalQuery === "max-keys=2&prefix=J",
      signed,
    );
  }

  section("The three stores");
  const stores = {
    s3: storeLib.openStore(s3Config, S3_KEY.secretAccessKey),
    azure: storeLib.openStore(azureConfig, SAS),
    folder: storeLib.openStore({ provider: "filesystem", path: folderRoot, prefix: "check" }, null),
  };
  for (const [name, store] of Object.entries(stores)) {
    const steps = await storeLib.checkStore(store);
    ok(`${name}: Check connection writes, reads, lists and deletes`, steps.length === 4 && steps.every((s) => s.ok), steps);
    for (const key of ["a/b/1", "a/b/2", "a/c/3", "a/4", "x/5"]) await store.put(key, Buffer.from(`zz ${key}`));
    const all = await store.list("a/");
    ok(`  a listing a page at a time finds every object under its prefix`, all.objects.map((o) => o.key).sort().join() === "a/4,a/b/1,a/b/2,a/c/3", all.objects.map((o) => o.key));
    const byFolder = await store.list("a/", { delimiter: true });
    ok(`  by folder: the objects in it and the folders below`, byFolder.objects.map((o) => o.key).join() === "a/4" && byFolder.prefixes.sort().join() === "a/b/,a/c/", byFolder);
    ok(`  read back, and nothing for a key not there`, (await store.get("a/b/2"))?.toString() === "zz a/b/2" && (await store.get("a/nope")) === null);
    const big = path.join(TMP, `${name}-big.bin`);
    writeFileSync(big, randomBytes(3 * 1024 * 1024 + 17));
    await store.putFile("big/file.bin", big);
    const back = path.join(TMP, `${name}-back.bin`);
    ok(`  a 3 MB file streamed up with its length, and down to a file`, (await store.getToFile("big/file.bin", back)) && sha256(readFileSync(back)) === sha256(readFileSync(big)));
    await store.remove("a/b/1");
    await store.remove("a/never-there");
    ok(`  deleted, and deleting what isn't there is no error`, (await store.get("a/b/1")) === null);
    ok(`  a key that climbs out of the store is refused`, /Not a key/.test(await thrown(() => store.put("a/../../etc", Buffer.from("x")))));
    if (name !== "folder") {
      await store.put("locked/1", Buffer.from("x"));
      ok(`  a delete the store's retention refuses is "kept", not a failure`, /KeptByStore/.test(await thrown(() => store.remove("locked/1"))));
    }
  }
  ok("no request to the fake S3 failed its signature", !s3.refused.some((r) => /Signature/.test(r)), s3.refused);
  const wrong = storeLib.openStore(s3Config, "zz-not-the-secret");
  ok("a wrong secret is refused by S3, and the console is told what to check", /access key, its secret, the region/.test(await thrown(() => wrong.put("a/x", Buffer.from("x")))));
  ok("  and a wrong SAS token by Azure", /SAS token/.test(await thrown(() => storeLib.openStore(azureConfig, "sv=2023&sig=zz").put("a/x", Buffer.from("x")))));

  section("The store's settings");
  const refusal = async (input: unknown) => thrown(async () => config.parseStoreConfig(input));
  ok("plain http to anywhere but this machine is refused", /https/.test(await refusal({ provider: "s3", endpoint: "http://s3.example.com", bucket: "zz-bucket", accessKeyId: "AKIAZZZZZZZZ" })));
  ok("a container address with its SAS token on it is refused (the token has its own field)", /SAS token/.test(await refusal({ provider: "azure", containerUrl: "https://acct.blob.core.windows.net/deskzo?sv=1&sig=2" })));
  ok("a folder inside BACKUP_DIR is refused — it isn't off-site", /BACKUP_DIR/.test(await refusal({ provider: "filesystem", path: path.join(process.env.BACKUP_DIR!, "copy") })));
  ok("a bucket name S3 wouldn't take is refused", /bucket/.test(await refusal({ provider: "s3", endpoint: "https://s3.ap-south-1.amazonaws.com", bucket: "Zz_Bad", accessKeyId: "AKIAZZZZZZZZ" })));
  ok("logs can't be kept less than CERT-In's 180 days", /180/.test(await thrown(async () => config.parseKeepDays(90, "logs"))) && config.parseKeepDays(365, "logs") === 365);
  ok("an Azure address is kept as its container", config.parseStoreConfig({ provider: "azure", containerUrl: "https://acct.blob.core.windows.net/deskzo/" }).provider === "azure");

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_offsite_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  const scratchBefore = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname like 'w\_%'`;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const chunks = require("../src/lib/backup/chunks") as typeof import("../src/lib/backup/chunks");
    const atRest = require("../src/lib/backup/at-rest") as typeof import("../src/lib/backup/at-rest");
    const sidecar = require("../src/lib/backup/sidecar") as typeof import("../src/lib/backup/sidecar");
    const run = require("../src/lib/backup/run") as typeof import("../src/lib/backup/run");
    const policy = require("../src/lib/backup/policy") as typeof import("../src/lib/backup/policy");
    const backups = require("../src/lib/offsite/backups") as typeof import("../src/lib/offsite/backups");
    const chores = require("../src/lib/offsite/chores") as typeof import("../src/lib/offsite/chores");
    const control = require("../src/lib/offsite/control") as typeof import("../src/lib/offsite/control");
    const drill = require("../src/lib/offsite/drill") as typeof import("../src/lib/offsite/drill");
    const accessLog = require("../src/lib/logs/access-log") as typeof import("../src/lib/logs/access-log");
    const archive = require("../src/lib/logs/archive") as typeof import("../src/lib/logs/archive");
    const timeSync = require("../src/lib/platform/time-sync") as typeof import("../src/lib/platform/time-sync");
    const alertsLib = require("../src/lib/platform/alerts") as typeof import("../src/lib/platform/alerts");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const consoleOffsite = require("../src/actions/platform/console-offsite") as typeof import("../src/actions/platform/console-offsite");
    const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const db = controlDb();

    const tenant = (slug: string) => db.tenant.create({ data: { slug, name: `Zz ${slug}`, status: "ACTIVE", keyBundleCipher: "zz" }, select: { id: true, slug: true, isDefault: true } });
    const A = await tenant("zzoffsite-a");
    const B = await tenant("zzoffsite-b");
    const D = await tenant("zzoffsite-d");
    const rootOf = (t: { id: string }) => path.join(process.env.BACKUP_DIR!, "workspaces", t.id);

    // The store, as an owner would set it: the fake S3, everything under "deskzo".
    await settings.setSetting("offsite.provider", "s3", "check");
    await settings.setSetting("offsite.config", config.storedConfig({ ...s3Config, prefix: "deskzo" }), "check");
    await settings.setSecret("offsite.secret", S3_KEY.secretAccessKey, "check");
    const found = await config.currentStore();
    ok("the store is read back from the settings, with its secret", !!found && found.store.label.includes("deskzo-backups/deskzo") && found.setup.backupKeepDays === 35 && found.setup.logKeepDays === 365);
    const store = found!.store;
    const there = (prefix: string) => [...s3.objects.keys()].filter((k) => k.startsWith(`deskzo/${prefix}`)).map((k) => k.slice("deskzo/".length));

    section("Workspaces' backups off-site");
    // A: five chunked backups of made-up data sharing most of it, and a full one, taken 60 days back to now.
    const rootA = rootOf(A);
    await mkdir(rootA, { recursive: true });
    const base = randomBytes(1024 * 1024);
    const ages = [50, 45, 40, 20, 10, 2, 1];
    const manifestIds: string[] = [];
    for (const [i, age] of ages.entries()) {
      const file = path.join(TMP, `a-${i}.raw`);
      writeFileSync(file, Buffer.concat([base, randomBytes(400 * 1024)]));
      const m = await chunks.storeDump(rootA, file, A.id);
      const id = `zzbackup${i}`;
      await chunks.writeManifest(rootA, id, { ...m, takenAt: new Date(Date.now() - age * DAY).toISOString(), filename: `deskzo-zz-${i}.chunked`, schemaVersion: "zz" });
      manifestIds.push(id);
    }
    const fullA = path.join(rootA, "deskzo-2026-08-01-020000.dump");
    await pipeline(async function* () {
      yield randomBytes(200 * 1024);
    }, atRest.sealingStream(A.id, "dump"), createWriteStream(fullA));
    await sidecar.writeSidecar(fullA, { filename: path.basename(fullA), takenAt: new Date(Date.now() - 60 * DAY).toISOString(), schemaVersion: "zz", secretFingerprint: null, via: "check", sizeBytes: 1, app: "Deskzo One" });
    // B: a full backup from before backups were encrypted on disk — plain — and a dump still being written.
    const rootB = rootOf(B);
    await mkdir(rootB, { recursive: true });
    const plainB = randomBytes(150 * 1024);
    const fullB = path.join(rootB, "deskzo-2026-10-20-020000.dump");
    writeFileSync(fullB, plainB);
    await sidecar.writeSidecar(fullB, { filename: path.basename(fullB), takenAt: new Date(Date.now() - 4 * DAY).toISOString(), schemaVersion: "zz", secretFingerprint: null, via: "check", sizeBytes: plainB.length, app: "Deskzo One" });
    writeFileSync(path.join(rootB, "deskzo-2026-10-24-020000.dump"), randomBytes(2048));
    // Support files: two sent with a request, one still in staging.
    const supportA = path.join(process.env.SUPPORT_DIR!, A.id);
    mkdirSync(path.join(supportA, "zzreq1"), { recursive: true });
    mkdirSync(path.join(supportA, "staging"), { recursive: true });
    writeFileSync(path.join(supportA, "zzreq1", "zzatt1"), Buffer.from("zz recording"));
    writeFileSync(path.join(supportA, "zzreq1", "zzatt2"), Buffer.from("zz screenshot"));
    writeFileSync(path.join(supportA, "staging", "zzup1"), Buffer.from("zz not yet sent"));
    // A closed workspace's leftovers in the store.
    await store.put("backups/workspaces/zzghost/manifests/zz.json", Buffer.from("{}"));
    await store.put("backups/workspaces/zzghost/chunks/ab/zz.gz", Buffer.from("zz"));

    const first = await chores.runChore("sync", "check");
    ok("the sync runs, and says what it did", first.ran && first.ok && /3 workspaces/.test(first.summary), first);
    const manifestsThere = there(`backups/workspaces/${A.id}/manifests/`);
    const manifestKeys = (ids: string[]) => ids.map((id) => `backups/workspaces/${A.id}/manifests/${id}.json`).sort().join();
    const piecesOf = async (ids: string[]) => {
      const set = new Set<string>();
      for (const id of ids) for (const h of (await chunks.readManifest(rootA, id))!.chunks) set.add(h);
      return set;
    };
    const piecesOff = () => there(`backups/workspaces/${A.id}/chunks/`).map((k) => k.split("/").pop()!.replace(/\.gz$/, ""));
    const sentA = manifestIds.slice(3); // 20, 10, 2 and 1 days old
    ok("A's backups older than the 35 days kept off-site aren't sent at all — though the workspace keeps them longer here", manifestsThere.sort().join() === manifestKeys(sentA) && there(`backups/workspaces/${A.id}/dumps/`).length === 0, manifestsThere);
    let live = await piecesOf(sentA);
    let piecesThere = piecesOff();
    ok("  their pieces are, and only theirs", piecesThere.length === live.size && piecesThere.every((h) => live.has(h)), { there: piecesThere.length, live: live.size });
    ok("  every piece off-site is encrypted", piecesThere.every((h) => atRest.isSealed(s3.objects.get(`deskzo/backups/workspaces/${A.id}/chunks/${h.slice(0, 2)}/${h}.gz`)!.body)));
    const offB = s3.objects.get(`deskzo/backups/workspaces/${B.id}/dumps/${path.basename(fullB)}`);
    const openedB = path.join(TMP, "b-opened.dump");
    if (offB) {
      writeFileSync(path.join(TMP, "b-off.dump"), offB.body);
      await atRest.openBackupFileTo(B.id, path.join(TMP, "b-off.dump"), openedB);
    }
    ok("B's backup from before encryption goes encrypted, and opens to what it was", !!offB && atRest.isSealed(offB.body) && sha256(readFileSync(openedB)) === sha256(plainB));
    ok("  its sidecar goes beside it; the dump still being written (no sidecar) doesn't", !!s3.objects.get(`deskzo/backups/workspaces/${B.id}/dumps/${path.basename(fullB)}.json`) && there(`backups/workspaces/${B.id}/dumps/deskzo-2026-10-24`).length === 0);
    ok("  the copy encrypted for sending isn't left on the server", (await readdir(rootB)).every((f) => !f.includes(".dump.offsite-")));
    const att = s3.objects.get(`deskzo/support/${A.id}/zzreq1/zzatt1`);
    ok("support files go encrypted; one in staging doesn't go", !!att && atRest.isSealed(att.body) && there(`support/${A.id}/staging`).length === 0 && there(`support/${A.id}/`).length === 2);
    ok("a closed workspace's backups are removed from the store", there("backups/workspaces/zzghost/").length === 0);
    const rowA = await db.offsiteWorkspace.findUnique({ where: { tenantId: A.id } });
    ok("each workspace's record: its newest backup off-site, how many, when synced", !!rowA && rowA.backups === 4 && !!rowA.lastSyncedAt && !rowA.lastError && Math.abs(rowA.latestBackupAt!.getTime() - (Date.now() - DAY)) < 60_000);
    const objectsAfterFirst = s3.objects.size;
    const requestsBefore = s3.requests;

    // Within the hour, nothing changed: nothing is read from the store and nothing sent.
    await db.offsiteRun.updateMany({ data: { startedAt: new Date(Date.now() - 2 * 3_600_000) } });
    const second = await chores.runChore("sync", "check");
    ok("a second sync with nothing new sends nothing", second.ok && /nothing new to send/.test(second.summary) && s3.objects.size === objectsAfterFirst, second.summary);
    ok("  and asks the store about the workspaces nothing changed in only for support files", s3.requests - requestsBefore <= 2, s3.requests - requestsBefore);

    // Kept 7 days instead: the 20-day-old backup goes; the 10-day-old stays, being one of the newest three.
    await settings.setSetting("offsite.backupKeepDays", "7", "check");
    await db.offsiteWorkspace.update({ where: { tenantId: A.id }, data: { lastPrunedAt: new Date(Date.now() - 2 * DAY) } });
    const shorter = await backups.syncWorkspace(store, (await config.currentStore())!.setup, A);
    const remaining = manifestIds.slice(4); // 10, 2 and 1 days old
    ok("with fewer days kept, a backup past them is removed off-site — the newest three stay whatever their age", shorter.pruned.backups === 1 && there(`backups/workspaces/${A.id}/manifests/`).sort().join() === manifestKeys(remaining), shorter);
    live = await piecesOf(remaining);
    piecesThere = piecesOff();
    ok("  then exactly the pieces the remaining backups name — no more, no fewer", shorter.pruned.chunks > 0 && piecesThere.length === live.size && piecesThere.every((h) => live.has(h)), { there: piecesThere.length, live: live.size, swept: shorter.pruned.chunks });
    await settings.setSetting("offsite.backupKeepDays", "35", "check");

    // A piece goes missing from the store; the weekly check notices and sends it again.
    const lost = [...live][0];
    await store.remove(`backups/workspaces/${A.id}/chunks/${lost.slice(0, 2)}/${lost}.gz`);
    await db.offsiteWorkspace.update({ where: { tenantId: A.id }, data: { lastVerifiedAt: new Date(Date.now() - 8 * DAY) } });
    const third = await backups.syncWorkspace(store, found!.setup, A);
    ok("the weekly check finds a piece lost from the store and sends it again", third.verified && !third.error && !!(await store.get(`backups/workspaces/${A.id}/chunks/${lost.slice(0, 2)}/${lost}.gz`)), third);

    // A support file the support retention deleted here goes from the store too.
    await rm(path.join(supportA, "zzreq1", "zzatt2"));
    const supportSync = await (require("../src/lib/offsite/support") as typeof import("../src/lib/offsite/support")).syncSupportFiles(store); // eslint-disable-line @typescript-eslint/no-require-imports
    ok("a support file deleted here is deleted off-site at the next sync", supportSync.removed === 1 && there(`support/${A.id}/`).length === 1);

    ok("removing a workspace's backups (purging it) leaves nothing of them in the store", (await backups.removeWorkspaceBackups(store, B.id)) > 0 && there(`backups/workspaces/${B.id}/`).length === 0);

    section("The control plane's dump");
    const controlOutcome = await chores.runChore("control", "check");
    const controlKeys = there("backups/control/");
    ok("dumped, encrypted, kept here and off-site", controlOutcome.ok && controlKeys.length === 1 && atRest.isSealed(s3.objects.get(`deskzo/${controlKeys[0]}`)!.body), controlOutcome);
    ok("  named for the time in UTC", !!control.controlDumpTakenAt(controlKeys[0]!) && Math.abs(control.controlDumpTakenAt(controlKeys[0]!)!.getTime() - Date.now()) < 120_000);

    section("Restore drills");
    // D: a real chunked backup — of this machine's own demo workspace — taken as the backups take one.
    const tool = await run.resolveDumpTool("pg_dump");
    ok("pg_dump is found", !!tool);
    const rootD = rootOf(D);
    await mkdir(rootD, { recursive: true });
    const plainD = path.join(TMP, "d.dump");
    await run.dump(tool!, policy.parseDatabaseUrl(url)!, plainD, 0, null);
    const real = directClient(url, { max: 1 });
    const [latest] = await real.$queryRawUnsafe<{ name: string }[]>(`SELECT migration_name::text AS name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`);
    const [people] = await real.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "users"`);
    const md = await chunks.storeDump(rootD, plainD, D.id);
    await chunks.writeManifest(rootD, "zzreal", { ...md, takenAt: new Date().toISOString(), filename: "deskzo-zz.chunked", schemaVersion: latest.name });
    await backups.syncWorkspace(store, found!.setup, D);
    const drilled = await chores.runChore("drill", "check", { tenantId: D.id });
    const drillRun = await db.offsiteRun.findFirst({ where: { kind: "DRILL", tenantId: D.id }, orderBy: { startedAt: "desc" } });
    ok("a real backup fetched back from the store restores into a scratch database and reads back", drilled.ok && drillRun?.status === "SUCCEEDED", drilled);
    ok("  it found the backup's own migration, and the people in it", (drillRun?.summary ?? "").includes(latest.name) && (drillRun?.summary ?? "").includes(`${people.n} people`), drillRun?.summary);
    ok("  the scratch database is dropped, and its name cleared from the run", drillRun?.scratchDb === null && (await db.offsiteWorkspace.findUnique({ where: { tenantId: D.id } }))?.lastDrillOk === true);
    await real.$disconnect();

    // A: made-up data — it reassembles (the checksums hold) but pg_restore can't read it.
    const failed = await chores.runChore("drill", "check", { tenantId: A.id });
    const failedRun = await db.offsiteRun.findFirst({ where: { kind: "DRILL", tenantId: A.id }, orderBy: { startedAt: "desc" } });
    ok("a backup that won't restore fails its drill, saying why", !failed.ok && failedRun?.status === "FAILED" && !!failedRun.error, failedRun?.error);
    const ctlRun = await db.offsiteRun.create({ data: { kind: "DRILL", startedBy: "check" } });
    const ctl = await drill.drillControlPlane(store, ctlRun.id);
    ok("the control plane's newest dump restores and has its workspaces", ctl.ok && /3 workspaces/.test(ctl.summary), ctl);
    await db.offsiteRun.update({ where: { id: ctlRun.id }, data: { status: "SUCCEEDED", finishedAt: new Date(), summary: ctl.summary } });
    const scratchAfter = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname like 'w\_%'`;
    ok("  no scratch database is left behind", Number(scratchAfter[0].n) === Number(scratchBefore[0].n), { before: Number(scratchBefore[0].n), after: Number(scratchAfter[0].n) });

    section("Recovering a workspace onto a server that lost it");
    {
      // D as the restored control plane would name it: a database, role and password that don't exist yet.
      const name = `w_${randomBytes(6).toString("hex")}`;
      const address = new URL(url);
      address.username = name;
      address.password = randomBytes(18).toString("base64url");
      address.pathname = `/${name}`;
      address.search = "?schema=public";
      /* eslint-disable @typescript-eslint/no-require-imports */
      const recover = require("../src/lib/offsite/recover") as typeof import("../src/lib/offsite/recover");
      const provisioner = require("../src/lib/platform/provisioner") as typeof import("../src/lib/platform/provisioner");
      /* eslint-enable @typescript-eslint/no-require-imports */
      const target = { id: D.id, slug: D.slug, dbUrl: address.toString() };
      try {
        const done = await recover.recoverWorkspace(store, target);
        const back = directClient(address.toString(), { max: 1 });
        const [n] = await back.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "users"`);
        const [has] = await back.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = '${latest.name.replace(/'/g, "")}'`);
        await back.$disconnect();
        ok("its database made again under its own name, role and password, its newest backup restored, the migrations run", done.made && n.n === people.n && has.n === 1 && done.backup.kind === "manifest", { made: done.made, people: n.n });
        ok("  a database that is there with tables is left alone without --replace", /--replace/.test(await thrown(() => recover.recoverWorkspace(store, target))));
        const again = await recover.recoverWorkspace(store, target, { replace: true });
        ok("  and put back in its place with it", again.made);
        ok("  a name that isn't a workspace's is refused", /Refusing/.test(await thrown(() => provisioner.ensureWorkspaceDatabase("postgres", name, "x"))));
      } finally {
        await provisioner.dropWorkspaceDatabase(name, name).catch(() => {});
      }
      const scratchNow = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname like 'w\_%'`;
      ok("  dropped again afterwards", Number(scratchNow[0].n) === Number(scratchBefore[0].n));
    }

    section("The access log");
    const twoDaysAgo = new Date(Date.now() - 2 * DAY);
    accessLog.logAccess({ host: "acme.localhost", method: "GET", path: "/leads", status: null, ip: "203.0.113.9", userAgent: "zz-agent", userId: "zzuser" }, twoDaysAgo);
    accessLog.logAccess({ host: "acme.localhost", method: "POST", path: "/login", status: 303, ip: "203.0.113.9", userAgent: "zz-agent", userId: null }, twoDaysAgo);
    accessLog.logAccess({ host: "admin.localhost", method: "GET", path: "/", status: null, ip: null, userAgent: null, userId: null });
    await accessLog.flushAccessLog();
    const oldFile = accessLog.accessLogFile(twoDaysAgo);
    const lines = readFileSync(oldFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    ok("a line a request, in the file of its UTC day and this process", lines.length === 2 && lines[0].p === "/leads" && lines[0].u === "zzuser" && lines[1].s === 303 && path.basename(oldFile).endsWith(`-${process.pid}.jsonl`));
    ok("  today's goes to today's file", readFileSync(accessLog.accessLogFile(new Date()), "utf8").includes('"h":"admin.localhost"'));
    const archived = await archive.archiveAccessLogs(store);
    const accessKey = `logs/${dayKey(twoDaysAgo)}/access/${path.basename(oldFile)}.gz`;
    ok("a finished day is archived; today isn't", !!(await store.get(accessKey)) && there(`logs/${dayKey(new Date())}/`).length === 0 && archived.files >= 1, archived);
    const fetched = path.join(TMP, "access.sealed");
    const opened = path.join(TMP, "access.gz");
    writeFileSync(fetched, (await store.get(accessKey))!);
    await atRest.openBackupFileTo(archive.LOG_SEAL, fetched, opened, "log");
    const plainOut = path.join(TMP, "access.jsonl");
    await pipeline(createReadStream(opened), createGunzip(), createWriteStream(plainOut));
    ok("  sealed off-site, and opens to the same lines", atRest.isSealed(readFileSync(fetched)) && readFileSync(plainOut, "utf8") === readFileSync(oldFile, "utf8"));
    // Old days on disk: one archived 20 days back, one never archived 20 days back, one 400.
    for (const [age, sent] of [
      [20, true],
      [21, false],
      [400, false],
    ] as const) {
      const dir = path.join(accessLog.accessLogDir(), dayKey(new Date(Date.now() - age * DAY)));
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "zz-1.jsonl"), "{}\n");
      if (sent) writeFileSync(path.join(dir, "zz-1.jsonl.sent"), "");
    }
    const pruned = await archive.pruneLocalAccessLogs(180);
    const daysLeft = await readdir(accessLog.accessLogDir());
    ok("days archived over two weeks ago go from here; days past the retention go anyway", pruned === 2 && !daysLeft.includes(dayKey(new Date(Date.now() - 20 * DAY))) && !daysLeft.includes(dayKey(new Date(Date.now() - 400 * DAY))) && daysLeft.includes(dayKey(new Date(Date.now() - 21 * DAY))), daysLeft);

    section("Security logs");
    // A day of this machine's demo workspace (in the fallback the check runs under), as it is in the database.
    const demo = directClient(url, { max: 1 });
    const [busiest] = await demo.$queryRawUnsafe<{ day: string }[]>(`SELECT to_char(("createdAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day FROM "activity_logs" GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
    if (!busiest) {
      ok("the demo workspace has activity to export (seed it: npm run db:seed)", false);
    } else {
      const counts = async (table: string, column: string) =>
        Number((await demo.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" >= $1::timestamp AND "${column}" < $1::timestamp + interval '1 day'`, `${busiest.day} 00:00:00`))[0].n);
      const expected = { activity: await counts("activity_logs", "createdAt"), "sign-in": await counts("sign_ins", "at"), audit: await counts("audit_logs", "createdAt") };
      const exported = await archive.exportWorkspaceDay(store, "zzdemo", busiest.day, path.join(TMP, "demo.sealing"));
      const out = path.join(TMP, "demo.jsonl");
      const raw = path.join(TMP, "demo.sealed");
      writeFileSync(raw, (await store.get(`logs/${busiest.day}/workspaces/zzdemo.jsonl.gz`)) ?? Buffer.alloc(0));
      await atRest.openBackupFileTo("zzdemo", raw, path.join(TMP, "demo.gz"), "log");
      await pipeline(createReadStream(path.join(TMP, "demo.gz")), createGunzip(), createWriteStream(out));
      const rows = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const by = (log: string) => rows.filter((r) => r.log === log).length;
      ok(`a day's security logs (${busiest.day}) exported whole: activity, sign-ins, audit`, by("activity") === expected.activity && by("sign-in") === expected["sign-in"] && by("audit") === expected.audit && exported.rows === rows.length, { expected, got: { activity: by("activity"), "sign-in": by("sign-in"), audit: by("audit") } });
      ok("  sealed under the workspace's own key", atRest.isSealed(readFileSync(raw)));
      ok("  no session id, and no change's values — only the fields' names", rows.every((r) => !("sid" in r) && !("changes" in r)) && rows.filter((r) => r.log === "audit").every((r) => Array.isArray(r.changedFields)));
    }
    await demo.$disconnect();

    // The platform's own, from yesterday — picked up where the archive left off.
    const yesterday = new Date(Date.now() - DAY);
    await settings.setSetting("offsite.logsThrough", dayKey(new Date(Date.now() - 2 * DAY)), "check");
    await db.platformAuditLog.create({ data: { actorKind: "SYSTEM", actor: "check", action: "zz.offsite", at: new Date(`${dayKey(yesterday)}T12:00:00Z`) } });
    const platformLogs = await archive.exportPlatformLogs(store, TMP);
    ok("the platform's own logs: yesterday's archived, and the archive's place moved on", platformLogs.days === 1 && platformLogs.rows >= 1 && !!(await store.get(`logs/${dayKey(yesterday)}/platform.jsonl.gz`)) && (await settings.getSetting("offsite.logsThrough")) === dayKey(yesterday), platformLogs);
    await store.put(`logs/${dayKey(new Date(Date.now() - 400 * DAY))}/access/zz.jsonl.gz`, Buffer.from("zz"));
    await store.put(`logs/${dayKey(new Date(Date.now() - 10 * DAY))}/access/zz.jsonl.gz`, Buffer.from("zz"));
    const prunedThere = await archive.pruneArchivedLogs(store, 365);
    ok("days past the retention are removed from the store; recent ones stay", prunedThere.days === 1 && there(`logs/${dayKey(new Date(Date.now() - 400 * DAY))}/`).length === 0 && there(`logs/${dayKey(new Date(Date.now() - 10 * DAY))}/`).length === 1, prunedThere);

    section("The clock");
    const ntp = await fakeNtp(5_000);
    const asked = await timeSync.askTimeServer("127.0.0.1", 2_000, ntp.port);
    ok("a time server 5 s ahead reads as 5 s ahead", Math.abs(asked.offsetMs - 5_000) < 300, asked);
    ntp.close();
    ok("  one that doesn't answer is a timeout, not a hang", /didn't answer/.test(await thrown(() => timeSync.askTimeServer("127.0.0.1", 500, ntp.port))));
    await settings.setSetting("platform.clockCheck", JSON.stringify({ at: new Date().toISOString(), server: "time.nplindia.org", offsetMs: -5_000, delayMs: 20, error: null }), "check");

    section("Alerts");
    const list = await alertsLib.alerts("OWNER");
    const kinds = list.open.map((a) => a.kind);
    ok("a failed drill is a critical alert", list.open.some((a) => a.kind === "offsite.drill-failed" && a.severity === "critical" && a.href === "/settings/offsite#drills"), kinds);
    ok("  the clock 5 s out is a warning", kinds.includes("clock.drift"));
    ok("  copying, the control plane's dump: nothing behind", !kinds.includes("offsite.stalled") && !kinds.includes("offsite.control-stale") && !kinds.includes("offsite.unconfigured"), kinds);

    section("The console");
    const owner = (await staffLib.createStaff({ email: "owner@zzoffsite.example", name: "Zz Owner", role: "OWNER" }, "script:check")).id;
    const adminStaff = (await staffLib.createStaff({ email: "admin@zzoffsite.example", name: "Zz Admin", role: "ADMIN" }, "script:check")).id;
    const actAs = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      await db.platformSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.set("deskzo-console", token);
    };
    const azureInput = { provider: "azure", containerUrl: `${azureConfig.containerUrl}?${SAS}`, prefix: "deskzo", backupKeepDays: "35", logKeepDays: "365" };
    await actAs(adminStaff);
    ok("an admin can't change the store", !(await consoleOffsite.consoleSaveOffsite(azureInput)).ok);
    const checkedByAdmin = await consoleOffsite.consoleCheckOffsite(null);
    ok("  but checks the saved one", checkedByAdmin.ok && checkedByAdmin.data.steps.every((s) => s.ok), checkedByAdmin);
    await actAs(owner);
    const tooShort = await consoleOffsite.consoleSaveOffsite({ ...azureInput, logKeepDays: "90" });
    ok("an owner can't keep logs under 180 days", !tooShort.ok && /180/.test(tooShort.ok ? "" : tooShort.error));
    const tried = await consoleOffsite.consoleCheckOffsite(azureInput);
    ok("an owner checks what is typed before saving it — the SAS token pasted onto the address is split off", tried.ok && tried.data.steps.every((s) => s.ok), tried);
    const saved = await consoleOffsite.consoleSaveOffsite(azureInput);
    const sas = new URLSearchParams(SAS).get("sig")!;
    const secretRow = await db.platformSetting.findUnique({ where: { key: "offsite.secret" } });
    const audit = JSON.stringify(await db.platformAuditLog.findMany({ where: { action: { startsWith: "offsite." } } }));
    ok("  saved: the token sealed, and in no audit entry", saved.ok && !!secretRow?.secretCipher && !secretRow.secretCipher.includes(sas) && (await settings.getSecret("offsite.secret")) === SAS && !audit.includes(sas) && audit.includes("offsite.save"));
    const kept2 = await consoleOffsite.consoleSaveOffsite({ ...azureInput, containerUrl: azureConfig.containerUrl, logKeepDays: "400" });
    ok("  saved again with the token's field empty: the saved token is kept", kept2.ok && (await settings.getSecret("offsite.secret")) === SAS && (await config.offsiteSetup()).logKeepDays === 400);
    ok("  switching to S3 without its secret key is refused (an S3 key is no SAS token)", !(await consoleOffsite.consoleSaveOffsite({ ...s3Config, prefix: "deskzo", backupKeepDays: "35", logKeepDays: "365" })).ok);
    const asked2 = await consoleOffsite.consoleRunOffsite("sync");
    const pending = await chores.pendingRequest();
    ok("Run now asks the worker, as the staff member who asked", asked2.ok && pending?.chore === "sync" && pending.by === `staff:${owner}`);
    // Only what was asked for: tonight's work done already, the clock checked.
    for (const kind of ["CONTROL_DUMP", "LOGS", "DRILL"] as const) await db.offsiteRun.create({ data: { kind, status: "SUCCEEDED", startedBy: "check", finishedAt: new Date() } });
    const ranNow = await chores.runDueChores();
    const byStaff = await db.offsiteRun.findFirst({ where: { kind: "SYNC" }, orderBy: { startedAt: "desc" } });
    ok("  the worker runs it, and only it; the run says who asked; the request is gone", ranNow.length === 1 && ranNow[0]?.chore === "sync" && ranNow[0]?.ran && byStaff?.startedBy === `staff:${owner}` && (await chores.pendingRequest()) === null, ranNow.map((o) => `${o.chore}:${o.ok}:${o.summary}`));
    ok("  copied to the new store (Azure) in full, the old store's record set aside", [...azure.objects.keys()].some((k) => k.startsWith(`deskzo/backups/workspaces/${A.id}/manifests/`)) && [...azure.objects.keys()].some((k) => k.startsWith(`deskzo/backups/workspaces/${D.id}/chunks/`)));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Page = (require("../src/app/platform-console/(console)/settings/offsite/page") as { default: () => Promise<unknown> }).default;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SettingsPage = (require("../src/app/platform-console/(console)/settings/page") as { default: () => Promise<unknown> }).default;
    const html = await renderHtml(Page() as never);
    const words = text(html);
    ok("Settings › Backups & logs: the store, what ran, the drills, CERT-In — and no secret", words.includes("Backups & logs") && words.includes("devaccount/deskzo") && words.includes("Restore drill") && words.includes("zzoffsite-d") && words.includes("CERT-In") && words.includes("400 days") && !html.includes(sas) && !html.includes(S3_KEY.secretAccessKey));
    ok("  an owner sees Change and Turn off; the clock 5 s behind is said", words.includes("Change") && words.includes("Turn off") && words.includes("5000 ms behind"));
    await actAs(adminStaff);
    const asAdmin = text(await renderHtml(Page() as never));
    ok("  an admin sees it view only — Check connection and Run now, no Change", asAdmin.includes("View only") && asAdmin.includes("Check connection") && asAdmin.includes("Run now") && !asAdmin.includes("Change…"));
    const index = text(await renderHtml(SettingsPage() as never));
    ok("all settings: a Backups & logs section naming the store", index.includes("Backups & logs") && index.includes("devaccount/deskzo"));
    await actAs(owner);
    const off = await consoleOffsite.consoleTurnOffOffsite();
    ok("turned off by an owner: nothing set, the secret deleted", off.ok && !(await config.offsiteSetup()).config && (await settings.getSecret("offsite.secret")) === null);

    await closeControlDb();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${controlName}`;
    ok("the scratch control plane is dropped", Number(left[0].n) === 0);
    await admin.$disconnect();
    s3.server.close();
    azure.server.close();
    await rm(TMP, { recursive: true, force: true }).catch(() => {});
  }

  console.log(failures === 0 ? "\nAll off-site checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

