import type { KeyObject } from "node:crypto";
import { controlDb } from "@/lib/platform/control-db";
import { assetHash, readUpdateBody, signedBy, type AppUpdateBody, type AppUpdatePlatform } from "@/lib/app-updates/protocol";

/**
 * The Deskzo phone app's over-the-air updates in the control plane (app_updates, app_update_assets — owner,
 * 23 Oct 2026): the newest for a native build, a file by its hash, what's been published, and publishing one.
 * See src/lib/app-updates/protocol.ts for what an update is and how it's trusted.
 */

/** The tables aren't there yet: an installation whose control plane hasn't run 20261123100000_app_updates. */
export function updatesNotMigrated(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "P2021" || code === "P2022";
}

export type PublishedUpdate = { id: string; kind: "UPDATE" | "ROLL_BACK_TO_EMBEDDED"; body: string; signature: string };

/** The newest thing published for a platform's native build — what its phones should be running. */
export async function latestAppUpdate(platform: AppUpdatePlatform, runtimeVersion: string): Promise<PublishedUpdate | null> {
  return controlDb().appUpdate.findFirst({
    where: { platform, runtimeVersion },
    orderBy: { createdAt: "desc" },
    select: { id: true, kind: true, body: true, signature: true },
  });
}

/** One of an update's files, by its hash. */
export async function appUpdateAsset(hash: string): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  return controlDb().appUpdateAsset.findUnique({ where: { hash }, select: { contentType: true, bytes: true } });
}

/** What's been published for a platform, newest first — for one native build, or every one. */
export async function appUpdateHistory(platform: AppUpdatePlatform, runtimeVersion: string | null, take = 20) {
  const rows = await controlDb().appUpdate.findMany({
    where: { platform, ...(runtimeVersion ? { runtimeVersion } : {}) },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, kind: true, runtimeVersion: true, createdAt: true, publishedAt: true, body: true },
  });
  return rows.map((r) => {
    const read = readUpdateBody(r.kind, r.body);
    return { ...r, commit: read.ok ? read.update.commit : null };
  });
}

export type PublishInput = {
  kind: string;
  body: string;
  signature: string;
  /** The files sent with it, by the hash they claim; files the server already has needn't be sent again. */
  files: Map<string, { bytes: Uint8Array; contentType: string }>;
};

type Refusal = { ok: false; status: number; error: string };

/**
 * Keeps a published update, after checking everything about it: that `key` signed exactly this body; that it's
 * newer than anything already published for its native build (phones run the newest they have, so an older one
 * would never be taken); that its id is new; and that every file it names is here — each sent file's bytes hashing
 * to what the manifest says.
 */
export async function publishAppUpdate(input: PublishInput, key: KeyObject): Promise<{ ok: true; update: AppUpdateBody } | Refusal> {
  if (!signedBy(input.body, input.signature, key)) return { ok: false, status: 403, error: "That isn't signed with Deskzo's update key." };
  const read = readUpdateBody(input.kind, input.body);
  if (!read.ok) return { ok: false, status: 422, error: read.error };
  const update = read.update;

  for (const [hash, file] of input.files) {
    if (assetHash(file.bytes) !== hash) return { ok: false, status: 422, error: "A file doesn't match its hash." };
    if (!update.assets.some((a) => a.hash === hash)) return { ok: false, status: 422, error: "A file was sent that the manifest doesn't name." };
  }

  const db = controlDb();
  const [existing, newest, have] = await Promise.all([
    db.appUpdate.findUnique({ where: { id: update.id }, select: { id: true } }),
    db.appUpdate.findFirst({ where: { platform: update.platform, runtimeVersion: update.runtimeVersion }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    update.assets.length ? db.appUpdateAsset.findMany({ where: { hash: { in: update.assets.map((a) => a.hash) } }, select: { hash: true } }) : Promise.resolve([]),
  ]);
  if (existing) return { ok: false, status: 409, error: "That update has been published already." };
  if (newest && newest.createdAt >= update.createdAt) return { ok: false, status: 409, error: "Something newer is already published for this build — make the update again." };
  const missing = update.assets.filter((a) => !input.files.has(a.hash) && !have.some((h) => h.hash === a.hash));
  if (missing.length) return { ok: false, status: 422, error: `${missing.length} of the update's files weren't sent.` };

  const fresh = update.assets.filter((a) => input.files.has(a.hash) && !have.some((h) => h.hash === a.hash));
  await db.$transaction(async (tx) => {
    if (fresh.length) {
      await tx.appUpdateAsset.createMany({
        data: fresh.map((a) => {
          const bytes = input.files.get(a.hash)!.bytes;
          return { hash: a.hash, contentType: a.contentType, size: bytes.byteLength, bytes: Buffer.from(bytes) };
        }),
        skipDuplicates: true,
      });
    }
    await tx.appUpdate.create({
      data: {
        id: update.id,
        platform: update.platform,
        runtimeVersion: update.runtimeVersion,
        kind: update.kind,
        body: input.body,
        signature: input.signature,
        createdAt: update.createdAt,
        assetHashes: update.assets.map((a) => a.hash),
      },
    });
  });
  return { ok: true, update };
}
