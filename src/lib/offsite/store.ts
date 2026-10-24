import { createHash, createHmac, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { answerText, request, unescapeXml, xmlAll, xmlOne, type Answer, type Body } from "@/lib/offsite/http";

/**
 * Where backups and logs are kept off the server (owner, 24 Oct 2026: "Both supported, I'll choose later").
 *
 *   azure        an Azure Blob container, through a SAS token
 *   s3           anything that speaks S3: AWS, Cloudflare R2, Wasabi, MinIO, DigitalOcean Spaces…
 *   filesystem   a folder — a mounted share (an Azure Files or NFS mount), and the check suite
 *
 * All three are written by hand over HTTP rather than through the vendors' SDKs: five calls each (put,
 * get, list, delete, and a put from a file), and no new packages. S3's requests are signed with
 * Signature Version 4, below; Azure's carry the SAS token as their query.
 *
 * Every key is relative to the store's own prefix, so one bucket can hold several installations, or
 * a staging copy beside production, without either seeing the other's objects.
 *
 * Nothing that goes in is readable on its own: backups are encrypted on the server before they are
 * copied (src/lib/backup/at-rest.ts), and logs are sealed as they are archived (src/lib/logs/archive.ts).
 * A leaked SAS token or access key gives somebody ciphertext.
 */

export type OffsiteObject = { key: string; size: number; modified: Date | null };
export type Listing = { objects: OffsiteObject[]; prefixes: string[] };

export interface OffsiteStore {
  /** "Azure Blob · deskzobackups/deskzo", for the console and the log. Never a secret. */
  readonly label: string;
  /** Changes whenever the store does — a different bucket, container, folder or prefix. */
  readonly fingerprint: string;
  put(key: string, body: Buffer): Promise<void>;
  putFile(key: string, file: string): Promise<void>;
  /** Null when there is no such object. */
  get(key: string): Promise<Buffer | null>;
  /** False when there is no such object. */
  getToFile(key: string, file: string): Promise<boolean>;
  /** Everything under `prefix`; with `delimiter`, only what is directly in it and the "folders" below it. */
  list(prefix: string, options?: { delimiter?: boolean }): Promise<Listing>;
  /** Gone, or never there. Throws `KeptByStore` when the store's own retention refuses it. */
  remove(key: string): Promise<void>;
}

export class OffsiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OffsiteError";
  }
}

/**
 * The store refused a delete because of its own rules — Azure's immutable storage, S3's Object Lock. Not
 * a failure: a store set up that way is protecting the backups from exactly the kind of deletion that
 * ransomware does, and an old backup stays until the store lets it go.
 */
export class KeptByStore extends OffsiteError {
  constructor(key: string) {
    super(`The store's own retention keeps ${key} for now.`);
    this.name = "KeptByStore";
  }
}

export type AzureConfig = { provider: "azure"; containerUrl: string; prefix: string };
export type S3Config = { provider: "s3"; endpoint: string; region: string; bucket: string; accessKeyId: string; pathStyle: boolean; prefix: string };
export type FolderConfig = { provider: "filesystem"; path: string; prefix: string };
export type StoreConfig = AzureConfig | S3Config | FolderConfig;

export function openStore(config: StoreConfig, secret: string | null): OffsiteStore {
  if (config.provider === "filesystem") return folderStore(config);
  if (!secret) throw new OffsiteError(config.provider === "azure" ? "The SAS token isn't set." : "The secret access key isn't set.");
  return config.provider === "azure" ? azureStore(config, secret) : s3Store(config, secret);
}

// ─── Keys ────────────────────────────────────────────────────────────────────────────────────────

/** A key as this platform writes them: letters, digits and `._-~/`, no empty or dot segments. */
const KEY = /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;

function checkKey(key: string): string {
  if (!KEY.test(key) || key.split("/").some((s) => s === "." || s === "..")) throw new OffsiteError(`Not a key this store writes: ${key}`);
  return key;
}

/** Each segment percent-encoded, slashes kept — what both S3 and Azure expect in a path. */
const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const keyPath = (key: string) => key.split("/").map(encodeSegment).join("/");

/** "deskzo" → "deskzo/"; "" stays "". */
export function normalPrefix(prefix: string): string {
  const p = prefix.trim().replace(/^\/+|\/+$/g, "");
  return p ? `${p}/` : "";
}

const sha256hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const piece of createReadStream(file)) hash.update(piece as Buffer);
  return hash.digest("hex");
}

// ─── Azure Blob ──────────────────────────────────────────────────────────────────────────────────

const AZURE_VERSION = "2023-11-03";

function azureStore(config: AzureConfig, sasToken: string): OffsiteStore {
  const container = new URL(config.containerUrl);
  const sas = sasToken.trim().replace(/^\?/, "");
  const prefix = normalPrefix(config.prefix);
  const base = `${container.origin}${container.pathname.replace(/\/+$/, "")}`;
  const account = container.hostname.split(".")[0];
  const containerName = container.pathname.replace(/^\/+|\/+$/g, "");

  const blobUrl = (key: string) => new URL(`${base}/${keyPath(prefix + checkKey(key))}?${sas}`);
  const headers = { "x-ms-version": AZURE_VERSION };

  async function call(method: string, key: string, body: Body = null, extra: Record<string, string> = {}, toFile?: string): Promise<Answer> {
    return request(method, blobUrl(key), { ...headers, ...extra }, body, toFile);
  }

  function fail(what: string, answer: Answer): never {
    if (answer.status === 403) throw new OffsiteError(`Azure refused to ${what} (403 — ${answerText(answer)}). Check the SAS token's permissions (read, add, create, write, delete, list) and that it hasn't expired.`);
    throw new OffsiteError(`Azure couldn't ${what}: ${answerText(answer)}`);
  }

  const putHeaders = { "x-ms-blob-type": "BlockBlob", "content-type": "application/octet-stream" };

  return {
    label: `Azure Blob · ${account}/${containerName}${prefix ? `/${prefix.slice(0, -1)}` : ""}`,
    fingerprint: `azure|${base}|${prefix}`,
    async put(key, body) {
      const answer = await call("PUT", key, body, putHeaders);
      if (answer.status !== 201) fail(`store ${key}`, answer);
    },
    async putFile(key, file) {
      const { size } = await stat(file);
      const answer = await call("PUT", key, { file, size }, putHeaders);
      if (answer.status !== 201) fail(`store ${key}`, answer);
    },
    async get(key) {
      const answer = await call("GET", key);
      if (answer.status === 404) return null;
      if (answer.status !== 200) fail(`read ${key}`, answer);
      return answer.body;
    },
    async getToFile(key, file) {
      const answer = await call("GET", key, null, {}, file);
      if (answer.status === 404) return false;
      if (answer.status !== 200) fail(`read ${key}`, answer);
      return true;
    },
    async list(under, options) {
      const objects: OffsiteObject[] = [];
      const prefixes: string[] = [];
      let marker = "";
      for (;;) {
        const query = new URLSearchParams({ restype: "container", comp: "list", prefix: prefix + under, maxresults: "5000" });
        if (options?.delimiter) query.set("delimiter", "/");
        if (marker) query.set("marker", marker);
        const answer = await request("GET", new URL(`${base}?${query.toString()}&${sas}`), headers);
        if (answer.status !== 200) fail(`list ${under || "the container"}`, answer);
        const xml = answer.body.toString("utf8");
        for (const blob of xmlAll(xml, "Blob")) {
          const name = unescapeXml(xmlOne(blob, "Name") ?? "");
          if (!name.startsWith(prefix)) continue;
          const modified = xmlOne(blob, "Last-Modified");
          objects.push({ key: name.slice(prefix.length), size: Number(xmlOne(blob, "Content-Length") ?? 0), modified: modified ? new Date(modified) : null });
        }
        for (const folder of xmlAll(xml, "BlobPrefix")) {
          const name = unescapeXml(xmlOne(folder, "Name") ?? "");
          if (name.startsWith(prefix)) prefixes.push(name.slice(prefix.length));
        }
        marker = unescapeXml(xmlOne(xml, "NextMarker") ?? "");
        if (!marker) return { objects, prefixes };
      }
    },
    async remove(key) {
      const answer = await call("DELETE", key);
      if (answer.status === 202 || answer.status === 200 || answer.status === 404) return;
      if (answer.status === 409 && /Immutab|LegalHold/i.test(answer.body.toString("utf8"))) throw new KeptByStore(key);
      fail(`delete ${key}`, answer);
    },
  };
}

// ─── S3 (Signature Version 4) ────────────────────────────────────────────────────────────────────

function s3Store(config: S3Config, secretKey: string): OffsiteStore {
  const endpoint = new URL(config.endpoint);
  const prefix = normalPrefix(config.prefix);
  const host = config.pathStyle ? endpoint.host : `${config.bucket}.${endpoint.host}`;
  const bucketPath = config.pathStyle ? `/${encodeSegment(config.bucket)}` : "";

  async function call(method: string, key: string | null, query: Record<string, string>, body: Body, payloadHash: string, extra: Record<string, string> = {}, toFile?: string): Promise<Answer> {
    const pathname = key === null ? bucketPath || "/" : `${bucketPath}/${keyPath(prefix + checkKey(key))}`;
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const signed = s3Signature({ method, host, pathname, query, payloadHash, amzDate, region: config.region, accessKeyId: config.accessKeyId, secretKey });
    const url = new URL(`${endpoint.protocol}//${host}${pathname}${signed.canonicalQuery ? `?${signed.canonicalQuery}` : ""}`);
    // Host goes as node sends it from the address — the same value that was signed.
    return request(method, url, { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...extra, authorization: signed.authorization }, body, toFile);
  }

  const EMPTY = sha256hex("");

  function fail(what: string, answer: Answer): never {
    if (answer.status === 403) throw new OffsiteError(`The store refused to ${what} (403 — ${answerText(answer)}). Check the access key, its secret, the region and the key's permissions on the bucket.`);
    throw new OffsiteError(`The store couldn't ${what}: ${answerText(answer)}`);
  }

  return {
    label: `S3 · ${endpoint.host}/${config.bucket}${prefix ? `/${prefix.slice(0, -1)}` : ""}`,
    fingerprint: `s3|${endpoint.origin}|${config.bucket}|${prefix}`,
    async put(key, body) {
      const answer = await call("PUT", key, {}, body, sha256hex(body), { "content-type": "application/octet-stream" });
      if (answer.status !== 200) fail(`store ${key}`, answer);
    },
    async putFile(key, file) {
      const [{ size }, hash] = await Promise.all([stat(file), fileSha256(file)]);
      const answer = await call("PUT", key, {}, { file, size }, hash, { "content-type": "application/octet-stream" });
      if (answer.status !== 200) fail(`store ${key}`, answer);
    },
    async get(key) {
      const answer = await call("GET", key, {}, null, EMPTY);
      if (answer.status === 404) return null;
      if (answer.status !== 200) fail(`read ${key}`, answer);
      return answer.body;
    },
    async getToFile(key, file) {
      const answer = await call("GET", key, {}, null, EMPTY, {}, file);
      if (answer.status === 404) return false;
      if (answer.status !== 200) fail(`read ${key}`, answer);
      return true;
    },
    async list(under, options) {
      const objects: OffsiteObject[] = [];
      const prefixes: string[] = [];
      let token = "";
      for (;;) {
        const query: Record<string, string> = { "list-type": "2", prefix: prefix + under, "max-keys": "1000" };
        if (options?.delimiter) query.delimiter = "/";
        if (token) query["continuation-token"] = token;
        const answer = await call("GET", null, query, null, EMPTY);
        if (answer.status !== 200) fail(`list ${under || "the bucket"}`, answer);
        const xml = answer.body.toString("utf8");
        for (const item of xmlAll(xml, "Contents")) {
          const name = unescapeXml(xmlOne(item, "Key") ?? "");
          if (!name.startsWith(prefix)) continue;
          const modified = xmlOne(item, "LastModified");
          objects.push({ key: name.slice(prefix.length), size: Number(xmlOne(item, "Size") ?? 0), modified: modified ? new Date(modified) : null });
        }
        for (const folder of xmlAll(xml, "CommonPrefixes")) {
          const name = unescapeXml(xmlOne(folder, "Prefix") ?? "");
          if (name.startsWith(prefix)) prefixes.push(name.slice(prefix.length));
        }
        token = xmlOne(xml, "IsTruncated") === "true" ? unescapeXml(xmlOne(xml, "NextContinuationToken") ?? "") : "";
        if (!token) return { objects, prefixes };
      }
    },
    async remove(key) {
      const answer = await call("DELETE", key, {}, null, EMPTY);
      if (answer.status === 204 || answer.status === 200 || answer.status === 404) return;
      // Object Lock answers a delete it won't allow with AccessDenied; so does a key without delete rights.
      // Either way the object stays, and the check of the connection says which it is.
      if (answer.status === 403) throw new KeptByStore(key);
      fail(`delete ${key}`, answer);
    },
  };
}

/**
 * Signature Version 4 for one S3 request, signing the host, the payload's hash and the time. The
 * canonical request is method, path, sorted query, the signed headers and the payload's hash; its hash
 * is signed with a key derived from the secret for the day, region and service. What is signed must be
 * exactly what is sent, so the query is encoded once, here, and the caller builds the URL from
 * `canonicalQuery`. Exported for the check suite, which holds it to AWS's own worked example.
 */
export function s3Signature(r: { method: string; host: string; pathname: string; query: Record<string, string>; payloadHash: string; amzDate: string; region: string; accessKeyId: string; secretKey: string }): { authorization: string; canonicalQuery: string } {
  const canonicalQuery = Object.keys(r.query)
    .sort()
    .map((k) => `${encodeSegment(k)}=${encodeSegment(r.query[k])}`)
    .join("&");
  const day = r.amzDate.slice(0, 8);
  const scope = `${day}/${r.region}/s3/aws4_request`;
  const headers: Record<string, string> = { host: r.host, "x-amz-content-sha256": r.payloadHash, "x-amz-date": r.amzDate };
  const names = Object.keys(headers).sort();
  const canonical = [r.method, r.pathname, canonicalQuery, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), r.payloadHash].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", r.amzDate, scope, sha256hex(canonical)].join("\n");
  let key: Buffer = createHmac("sha256", `AWS4${r.secretKey}`).update(day).digest();
  for (const part of [r.region, "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return { authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`, canonicalQuery };
}

// ─── A folder ────────────────────────────────────────────────────────────────────────────────────

function folderStore(config: FolderConfig): OffsiteStore {
  const root = path.resolve(config.path);
  const prefix = normalPrefix(config.prefix);
  const fileOf = (key: string) => path.join(root, ...(prefix + checkKey(key)).split("/"));

  async function place(key: string, write: (temp: string) => Promise<void>) {
    const target = fileOf(key);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${randomBytes(3).toString("hex")}.part`;
    try {
      await write(temp);
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async function walk(dir: string, rel: string, out: OffsiteObject[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, key, out);
      else if (entry.isFile() && !entry.name.endsWith(".part")) {
        const info = await stat(full).catch(() => null);
        if (info) out.push({ key, size: info.size, modified: info.mtime });
      }
    }
  }

  return {
    label: `Folder · ${root}${prefix ? `/${prefix.slice(0, -1)}` : ""}`,
    fingerprint: `folder|${root}|${prefix}`,
    async put(key, body) {
      await place(key, (temp) => writeFile(temp, body));
    },
    async putFile(key, file) {
      await place(key, (temp) => copyFile(file, temp));
    },
    async get(key) {
      return readFile(fileOf(key)).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
    },
    async getToFile(key, file) {
      try {
        await copyFile(fileOf(key), file);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
    },
    async list(under, options) {
      const full = prefix + under;
      // Walk from the deepest folder the prefix names in full, then keep what starts with the rest.
      const folder = full.includes("/") ? full.slice(0, full.lastIndexOf("/")) : "";
      const found: OffsiteObject[] = [];
      await walk(folder ? path.join(root, ...folder.split("/")) : root, folder, found);
      const objects: OffsiteObject[] = [];
      const prefixes = new Set<string>();
      for (const o of found) {
        if (!o.key.startsWith(full)) continue;
        const rest = o.key.slice(full.length);
        if (options?.delimiter && rest.includes("/")) prefixes.add(`${under}${rest.slice(0, rest.indexOf("/") + 1)}`);
        else objects.push({ ...o, key: o.key.slice(prefix.length) });
      }
      return { objects, prefixes: [...prefixes] };
    },
    async remove(key) {
      await rm(fileOf(key), { force: true });
    },
  };
}

// ─── Checking a store ────────────────────────────────────────────────────────────────────────────

export type CheckStep = { step: "write" | "read" | "list" | "delete"; ok: boolean; detail: string };

/**
 * Writes a small object, reads it back, finds it in a listing and deletes it — the four things the
 * backups need, each reported on its own, so a token that can write but not list says so rather than
 * failing the first night's prune.
 */
export async function checkStore(store: OffsiteStore): Promise<CheckStep[]> {
  const key = `offsite-check/${Date.now()}-${randomBytes(4).toString("hex")}.txt`;
  const body = Buffer.from(`Deskzo off-site check ${new Date().toISOString()}\n`, "utf8");
  const steps: CheckStep[] = [];
  const attempt = async (step: CheckStep["step"], work: () => Promise<string>): Promise<boolean> => {
    try {
      steps.push({ step, ok: true, detail: await work() });
      return true;
    } catch (err) {
      steps.push({ step, ok: false, detail: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  if (!(await attempt("write", async () => (await store.put(key, body), `Wrote ${key}.`)))) return steps;
  await attempt("read", async () => {
    const back = await store.get(key);
    if (!back) throw new OffsiteError("The object just written couldn't be found.");
    if (!back.equals(body)) throw new OffsiteError("The object came back different from what was written.");
    return "Read it back unchanged.";
  });
  await attempt("list", async () => {
    const { objects } = await store.list("offsite-check/");
    if (!objects.some((o) => o.key === key)) throw new OffsiteError("The listing doesn't show the object just written.");
    return "Found it in a listing.";
  });
  await attempt("delete", async () => {
    try {
      await store.remove(key);
      return "Deleted it.";
    } catch (err) {
      if (err instanceof KeptByStore) return "The store refused the delete — its own retention or Object Lock keeps objects, so old backups stay until it lets them go.";
      throw err;
    }
  });
  return steps;
}
