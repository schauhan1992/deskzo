import { readFile, writeFile } from "node:fs/promises";

/**
 * A small JSON file written beside every dump.
 *
 * The dump itself cannot carry any of this. `pg_dump` produces a database, not a description of the
 * instance it came from, and the two facts a restore has to check — which encryption secret the data
 * was written under, and which migration the schema was on — are properties of the instance.
 *
 * It travels with the dump. Copying one off the box without the other leaves a file that restores
 * cleanly and silently loses the vault, which is the failure this pair exists to prevent, so the
 * name is deliberately the dump's own with `.json` on the end: they sort together and a missing one
 * is obvious.
 *
 * Nothing in here is secret. The fingerprint identifies a key without being one, and the rest is
 * metadata somebody would want on the day they are deciding whether this is the right file.
 */

export type Sidecar = {
  filename: string;
  takenAt: string;
  schemaVersion: string | null;
  /** See `secretFingerprint` — an HMAC under the secret, not the secret. */
  secretFingerprint: string | null;
  via: string | null;
  sizeBytes: number | null;
  /** So a file found in five years says what wrote it. */
  app: string;
};

export function sidecarPath(dumpPath: string): string {
  return `${dumpPath}.json`;
}

export async function writeSidecar(dumpPath: string, sidecar: Sidecar): Promise<void> {
  await writeFile(sidecarPath(dumpPath), JSON.stringify(sidecar, null, 2), "utf8");
}

/**
 * Reads it, or null.
 *
 * Null for a missing file, unreadable JSON or the wrong shape alike — the caller's question is
 * "can I check this dump", and every one of those answers no in the same way. A restore then says
 * it cannot check rather than pretending it did.
 */
export async function readSidecar(dumpPath: string): Promise<Sidecar | null> {
  try {
    const raw = await readFile(sidecarPath(dumpPath), "utf8");
    const parsed = JSON.parse(raw) as Partial<Sidecar>;
    if (typeof parsed.takenAt !== "string") return null;
    return {
      filename: parsed.filename ?? "",
      takenAt: parsed.takenAt,
      schemaVersion: parsed.schemaVersion ?? null,
      secretFingerprint: parsed.secretFingerprint ?? null,
      via: parsed.via ?? null,
      sizeBytes: parsed.sizeBytes ?? null,
      app: parsed.app ?? "unknown",
    };
  } catch {
    return null;
  }
}
