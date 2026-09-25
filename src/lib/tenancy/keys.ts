import { createHmac, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { openForTenant, sealForTenant } from "@/lib/platform/kek";
import { currentTenant } from "@/lib/tenancy/resolve";
import { tenancyState, type Tenant } from "@/lib/tenancy/state";

/**
 * Each workspace's own keys.
 *
 * Every secret a workspace stores (two-factor seeds, the vault, mailbox tokens, provider keys) is
 * encrypted under its data key; every fingerprint of one is an HMAC under its digest key; its
 * tracking links, its document render passes and its sign-in sessions are signed with keys of their
 * own. So nothing one workspace holds — a ciphertext, a link, a session cookie — means anything to
 * another, even on the same server, even restored from the same backup.
 *
 * The keys are random, generated when the workspace is made, and kept in the control plane sealed
 * under the platform key (src/lib/platform/kek.ts). Opened bundles are kept for ten minutes.
 *
 * ## The first workspace
 *
 * The installation from before workspaces encrypted everything under keys derived from its
 * AUTH_SECRET, and sent out tracking links signed with it. Adopting it (`npm run platform:adopt`)
 * puts exactly those keys in its bundle, so not one stored secret has to be re-encrypted and no
 * link already in somebody's inbox breaks. After that its keys no longer depend on AUTH_SECRET.
 *
 * ## Workspaces from the environment
 *
 * With no control plane (before adoption) the first workspace's keys are derived from AUTH_SECRET
 * as they always were. Extra workspaces declared in the environment — check suites only — get keys
 * derived from AUTH_SECRET and their own id: distinct from each other's, which is what a suite needs.
 */

export type KeyBundle = {
  v: 1;
  /** AES-256-GCM, for stored secrets (src/lib/crypto.ts). */
  data: string;
  /** HMAC, for fingerprints of stored secrets. */
  digest: string;
  /** HMAC, for tracking links in mail. */
  tracking: string;
  /** HMAC, for document render passes. */
  render: string;
  /** The sign-in session secret (src/lib/auth-session.ts). */
  session: string;
  /** Backup fingerprints this workspace's data was also known by — see `backupFingerprints`. */
  legacyFingerprints: string[];
};

export type TenantKeys = {
  dataKey: Buffer;
  digestKey: Buffer;
  trackingKey: Buffer;
  renderKey: Buffer;
  sessionSecret: string;
  /** What a backup of this workspace is marked with: identifies the data key without being it. */
  fingerprint: string;
  legacyFingerprints: string[];
};

const b64 = (b: Buffer) => b.toString("base64");
const random = () => b64(randomBytes(32));

/** The fingerprint of a data key, for a backup's header. */
function fingerprintOf(dataKey: Buffer): string {
  return createHmac("sha256", dataKey).update("wroffy-backup-fingerprint").digest("hex").slice(0, 16);
}

/** The fingerprint backups carried before workspaces: an HMAC under AUTH_SECRET itself. */
export function legacyFingerprint(authSecret: string): string {
  return createHmac("sha256", authSecret).update("wroffy-backup-fingerprint").digest("hex").slice(0, 16);
}

/** The keys the installation used before workspaces, all derived from its AUTH_SECRET. */
function legacyMaterial(authSecret: string) {
  return {
    data: scryptSync(authSecret, "wroffy-crm-secret-store", 32),
    digest: scryptSync(authSecret, "wroffy-crm-secret-digest", 32),
    // Tracking links were signed with the secret itself, as a string — the same bytes.
    tracking: Buffer.from(authSecret, "utf8"),
    render: scryptSync(authSecret, "wroffy-document-render", 32),
  };
}

/** A new workspace's keys. */
export function newKeyBundle(): KeyBundle {
  return { v: 1, data: random(), digest: random(), tracking: random(), render: random(), session: random(), legacyFingerprints: [] };
}

/**
 * The first workspace's keys, when it is adopted: the ones its data is already encrypted and its
 * links already signed under, and a new session secret (everybody signs in once more).
 */
export function adoptedKeyBundle(authSecret: string): KeyBundle {
  const legacy = legacyMaterial(authSecret);
  return {
    v: 1,
    data: b64(legacy.data),
    digest: b64(legacy.digest),
    tracking: b64(legacy.tracking),
    render: b64(legacy.render),
    session: random(),
    legacyFingerprints: [legacyFingerprint(authSecret)],
  };
}

export function sealKeyBundle(tenantId: string, bundle: KeyBundle): string {
  return sealForTenant(tenantId, "key-bundle", JSON.stringify(bundle));
}

export function openKeyBundle(tenantId: string, sealed: string): KeyBundle {
  const bundle = JSON.parse(openForTenant(tenantId, "key-bundle", sealed)) as KeyBundle;
  if (bundle.v !== 1) throw new Error(`Key bundle version ${String(bundle.v)} is not one this code reads.`);
  return bundle;
}

function fromBundle(bundle: KeyBundle): TenantKeys {
  const dataKey = Buffer.from(bundle.data, "base64");
  return {
    dataKey,
    digestKey: Buffer.from(bundle.digest, "base64"),
    trackingKey: Buffer.from(bundle.tracking, "base64"),
    renderKey: Buffer.from(bundle.render, "base64"),
    sessionSecret: bundle.session,
    fingerprint: fingerprintOf(dataKey),
    legacyFingerprints: bundle.legacyFingerprints ?? [],
  };
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET must be set for a workspace that is not in the control plane.");
  return secret;
}

function environmentKeys(tenant: Tenant): TenantKeys {
  const secret = authSecret();
  const derive = (purpose: string) => Buffer.from(hkdfSync("sha256", secret, `wroffy/${purpose}`, tenant.id, 32));
  if (tenant.isDefault) {
    const legacy = legacyMaterial(secret);
    return {
      dataKey: legacy.data,
      digestKey: legacy.digest,
      trackingKey: legacy.tracking,
      renderKey: legacy.render,
      sessionSecret: b64(derive("authjs")),
      fingerprint: fingerprintOf(legacy.data),
      legacyFingerprints: [legacyFingerprint(secret)],
    };
  }
  const dataKey = derive("env-tenant/data");
  return {
    dataKey,
    digestKey: derive("env-tenant/digest"),
    trackingKey: derive("env-tenant/tracking"),
    renderKey: derive("env-tenant/render"),
    sessionSecret: b64(derive("authjs")),
    fingerprint: fingerprintOf(dataKey),
    legacyFingerprints: [],
  };
}

const KEYS_MS = 10 * 60_000;

export async function keysFor(tenant: Tenant): Promise<TenantKeys> {
  const { keys } = tenancyState();
  const hit = keys.get(tenant.id);
  if (hit && hit.cipher === tenant.keyBundleCipher && Date.now() - hit.at < KEYS_MS) return hit.keys as TenantKeys;
  const opened = tenant.keyBundleCipher ? fromBundle(openKeyBundle(tenant.id, tenant.keyBundleCipher)) : environmentKeys(tenant);
  keys.set(tenant.id, { cipher: tenant.keyBundleCipher, keys: opened, at: Date.now() });
  return opened;
}

/** The keys of the workspace the work in hand is for. */
export async function currentKeys(): Promise<TenantKeys> {
  return keysFor(await currentTenant());
}

/** Every fingerprint a backup of this workspace may carry and still be its own. */
export function backupFingerprints(keys: TenantKeys): string[] {
  return [keys.fingerprint, ...keys.legacyFingerprints];
}

/** A workspace's keys as a bundle again — to seal into a backup archive. */
export function bundleOf(keys: TenantKeys): KeyBundle {
  return {
    v: 1,
    data: b64(keys.dataKey),
    digest: b64(keys.digestKey),
    tracking: b64(keys.trackingKey),
    render: b64(keys.renderKey),
    session: keys.sessionSecret,
    legacyFingerprints: keys.legacyFingerprints,
  };
}

const ARCHIVE_KIND = "wroffy-key-bundle";

/** What a backup archive carries, sealed under its passphrase, so it restores readable anywhere. */
export function archiveKeyMaterial(keys: TenantKeys): string {
  // Not the session secret: a restored workspace keeps its own, and nobody carries a sign-in in a file.
  const { session: _session, ...rest } = bundleOf(keys);
  void _session;
  return JSON.stringify({ kind: ARCHIVE_KIND, ...rest });
}

/**
 * The keys a backup archive carried — the bundle a newer archive holds, or, from an archive written
 * before workspaces, the AUTH_SECRET its data was encrypted under. Without a session secret: the
 * workspace restoring it keeps its own.
 */
export function keysFromArchive(material: string): Omit<KeyBundle, "session"> {
  try {
    const parsed = JSON.parse(material) as Partial<KeyBundle> & { kind?: string };
    if (parsed?.kind === ARCHIVE_KIND && parsed.data && parsed.digest && parsed.tracking && parsed.render) {
      return { v: 1, data: parsed.data, digest: parsed.digest, tracking: parsed.tracking, render: parsed.render, legacyFingerprints: parsed.legacyFingerprints ?? [] };
    }
  } catch {
    // Not JSON: an AUTH_SECRET, below.
  }
  const { session: _session, ...legacy } = adoptedKeyBundle(material);
  void _session;
  return legacy;
}

/** Every fingerprint the keys an archive carried answer to — to compare with a workspace's own. */
export function archiveFingerprints(material: string): string[] {
  const bundle = keysFromArchive(material);
  return [fingerprintOf(Buffer.from(bundle.data, "base64")), ...bundle.legacyFingerprints];
}
