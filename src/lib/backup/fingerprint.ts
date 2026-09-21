import { createHmac } from "node:crypto";

/**
 * A fingerprint of the encryption secret, for comparing two instances.
 *
 * An HMAC of a fixed string under the secret, truncated: it identifies the key without being the
 * key, so it can sit in a table and in a sidecar file next to a dump without being worth stealing.
 *
 * The reason it exists at all is the failure it prevents. Ten kinds of column in this database are
 * encrypted with a key derived from `AUTH_SECRET`. Restore a dump into an instance with a different
 * secret and every one of them arrives intact and unreadable — pg_restore reports success, the row
 * counts match, and the vault is gone. Comparing fingerprints turns that into a refusal.
 *
 * It lives apart from `policy.ts` for one reason: `node:crypto`. The backup screen is a client
 * component and imports `formatBytes` from policy, so policy has to stay importable in a browser
 * bundle. One Node-only import in it would break the build of a page that never needed this.
 */
export function secretFingerprint(secret: string | undefined): string | null {
  if (!secret) return null;
  return createHmac("sha256", secret).update("wroffy-backup-fingerprint").digest("hex").slice(0, 16);
}
