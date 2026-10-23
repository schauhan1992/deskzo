import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import { APP_UPDATE_CERTIFICATE } from "@/lib/app-updates/certificate";

/**
 * Over-the-air updates of the Deskzo phone app (owner, 23 Oct 2026), in the Expo Updates protocol (version 1) that
 * the app's expo-updates speaks: what a published update must be, how its signature is checked, and the answers a
 * phone reads. Pure — the database is src/lib/app-updates/store.ts, the addresses src/app/api/app-updates.
 *
 * An update is signed on the computer that publishes it (scripts/app-update.ts) with Deskzo's update key. The phone
 * checks the signature against the certificate built into it; the server checks it against the same certificate
 * before it keeps anything, and serves the body byte for byte as it was signed. The private key never reaches here.
 */

export const APP_UPDATE_PLATFORMS = ["android"] as const;
export type AppUpdatePlatform = (typeof APP_UPDATE_PLATFORMS)[number];

/** Where a file of an update is served; a manifest names each of its files there, by hash. */
export const APP_UPDATE_ASSET_PATH = "/api/app-updates/assets/";

/** The base64url SHA-256 a manifest names a file by, and the phone checks it against. */
export const ASSET_HASH = /^[A-Za-z0-9_-]{43}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ASSETS = 500;

export const isAppUpdatePlatform = (v: unknown): v is AppUpdatePlatform => (APP_UPDATE_PLATFORMS as readonly string[]).includes(String(v));

export const assetHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("base64url");

/** The key the server trusts: the public half of Deskzo's update certificate. */
export const deskzoUpdateKey = (): KeyObject => createPublicKey(APP_UPDATE_CERTIFICATE);

/**
 * An expo-signature header — the Structured Field dictionary `sig="…", keyid="main", alg="rsa-v1_5-sha256"` — read
 * back. Null when it isn't one.
 */
export function readSignature(header: string): { sig: string; keyid: string | null; alg: string | null } | null {
  const fields: Record<string, string> = {};
  for (const part of header.split(",")) {
    const m = /^\s*([a-z]+)\s*=\s*"([^"]*)"\s*$/.exec(part);
    if (!m) return null;
    fields[m[1]!] = m[2]!;
  }
  return fields.sig ? { sig: fields.sig, keyid: fields.keyid ?? null, alg: fields.alg ?? null } : null;
}

/** Whether `signature` (an expo-signature header) signs `body` exactly, with the key the app trusts. */
export function signedBy(body: string, signature: string, key: KeyObject): boolean {
  const s = readSignature(signature);
  if (!s || (s.alg && s.alg !== "rsa-v1_5-sha256") || (s.keyid && s.keyid !== "main")) return false;
  try {
    return verify("sha256", Buffer.from(body, "utf8"), key, Buffer.from(s.sig, "base64"));
  } catch {
    return false;
  }
}

export type AppUpdateAssetRef = { hash: string; contentType: string };

/** What a published update is, read out of its signed body. */
export type AppUpdateBody = {
  id: string;
  kind: "UPDATE" | "ROLL_BACK_TO_EMBEDDED";
  platform: AppUpdatePlatform;
  runtimeVersion: string;
  createdAt: Date;
  assets: AppUpdateAssetRef[];
  /** The git commit its screens were built from, when it says. */
  commit: string | null;
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const when = (v: unknown): Date | null => {
  const d = typeof v === "string" ? new Date(v) : null;
  return d && Number.isFinite(d.getTime()) ? d : null;
};

/**
 * Reads a published update's signed body — a manifest, or a directive back to what came inside the app. Every
 * fact the server acts on is taken from inside the signature: which phones it's for (platform and native build),
 * its id and when it was made, and the files it needs, each served here by its hash. Null, with why, when it isn't
 * one.
 */
export function readUpdateBody(kind: string, body: string): { ok: true; update: AppUpdateBody } | { ok: false; error: string } {
  let parsed: Json | null;
  try {
    parsed = obj(JSON.parse(body));
  } catch {
    parsed = null;
  }
  if (!parsed) return { ok: false, error: "The update isn't JSON." };

  if (kind === "ROLL_BACK_TO_EMBEDDED") {
    const extra = obj(parsed.extra);
    const at = when(obj(parsed.parameters)?.commitTime);
    const id = text(extra?.id);
    const runtimeVersion = text(extra?.runtimeVersion);
    if (parsed.type !== "rollBackToEmbedded" || !at || !id || !UUID.test(id) || !runtimeVersion || !isAppUpdatePlatform(extra?.platform)) {
      return { ok: false, error: "That isn't a rollback this server serves." };
    }
    return { ok: true, update: { id: id.toLowerCase(), kind, platform: extra.platform as AppUpdatePlatform, runtimeVersion, createdAt: at, assets: [], commit: null } };
  }
  if (kind !== "UPDATE") return { ok: false, error: "Say whether it's an update or a rollback." };

  const id = text(parsed.id);
  const createdAt = when(parsed.createdAt);
  const runtimeVersion = text(parsed.runtimeVersion);
  const metadata = obj(parsed.metadata);
  if (!id || !UUID.test(id) || !createdAt || !runtimeVersion || !isAppUpdatePlatform(metadata?.platform)) {
    return { ok: false, error: "The manifest needs an id, when it was made, its native build and its platform." };
  }
  const files = [obj(parsed.launchAsset), ...(Array.isArray(parsed.assets) ? parsed.assets.map(obj) : [null])];
  if (!files[0] || files.length > MAX_ASSETS + 1) return { ok: false, error: "The manifest names no JavaScript to run, or too many files." };
  const assets: AppUpdateAssetRef[] = [];
  for (const f of files) {
    const hash = text(f?.hash, 64);
    const contentType = text(f?.contentType, 100);
    const url = text(f?.url, 500);
    if (!hash || !ASSET_HASH.test(hash) || !contentType || !url || !url.endsWith(`${APP_UPDATE_ASSET_PATH}${hash}`)) {
      return { ok: false, error: "Every file the manifest names must be served here, by its hash." };
    }
    if (!assets.some((a) => a.hash === hash)) assets.push({ hash, contentType });
  }
  return { ok: true, update: { id: id.toLowerCase(), kind, platform: metadata.platform as AppUpdatePlatform, runtimeVersion, createdAt, assets, commit: text(metadata?.commit, 64) } };
}

const PROTOCOL_HEADERS = { "expo-protocol-version": "1", "expo-sfv-version": "0", "cache-control": "private, max-age=0" };

/** Nothing newer for this phone — protocol 1's empty answer. */
export const noUpdate = (): Response => new Response(null, { status: 204, headers: PROTOCOL_HEADERS });

/** The update (a manifest) or the rollback (a directive), in the multipart answer the phone reads, with its signature. */
export function updateAnswer(kind: "UPDATE" | "ROLL_BACK_TO_EMBEDDED", body: string, signature: string): Response {
  const boundary = `deskzo-${randomUUID()}`;
  const part = kind === "UPDATE" ? "manifest" : "directive";
  const payload = [
    `--${boundary}`,
    `content-type: application/json; charset=utf-8`,
    `content-disposition: form-data; name="${part}"`,
    `expo-signature: ${signature}`,
    "",
    body,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return new Response(payload, { status: 200, headers: { ...PROTOCOL_HEADERS, "content-type": `multipart/mixed; boundary=${boundary}` } });
}

/**
 * What a phone is told, from what it says it runs and the newest thing published for its build. Nothing, when it
 * already runs the newest update — or is already back on what came inside it.
 */
export function answerFor(
  latest: { id: string; kind: "UPDATE" | "ROLL_BACK_TO_EMBEDDED"; body: string; signature: string } | null,
  phone: { currentUpdateId: string | null; embeddedUpdateId: string | null },
): Response {
  if (!latest) return noUpdate();
  const current = phone.currentUpdateId?.toLowerCase() ?? null;
  if (latest.kind === "UPDATE" && current === latest.id) return noUpdate();
  if (latest.kind === "ROLL_BACK_TO_EMBEDDED" && current !== null && current === phone.embeddedUpdateId?.toLowerCase()) return noUpdate();
  return updateAnswer(latest.kind, latest.body, latest.signature);
}
