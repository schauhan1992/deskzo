/**
 * Makes the installation that existed before workspaces into workspace #1 of the control plane.
 *
 *   npm run platform:adopt              check, then adopt (or bring an adopted one up to date)
 *   npm run platform:adopt -- --dry-run check only; writes nothing
 *
 * What it records, in the control plane (CONTROL_DATABASE_URL):
 *
 *   · the workspace — TENANCY_DEFAULT_SLUG / TENANCY_DEFAULT_NAME — marked as the default, which is
 *     what scripts and check suites act as;
 *   · its database address (DATABASE_URL), sealed under the platform key;
 *   · its keys, sealed likewise: exactly the keys its stored secrets are already encrypted under and
 *     its links already signed with (derived from AUTH_SECRET), so nothing is re-encrypted and no
 *     link in anybody's inbox breaks — plus a new sign-in secret, so everybody signs in once more;
 *   · the addresses it answered on before (TENANCY_LEGACY_HOSTS), still reaching it, the first one
 *     still the one links are built on;
 *   · its biometric terminals' serial numbers, so a terminal on a bare IP address keeps reaching it.
 *
 * Before writing anything it opens a sample of the secrets already stored in the database with the
 * keys it is about to record, and stops if they don't open — that would mean AUTH_SECRET is not the
 * one they were stored under, and adopting would record keys that read nothing.
 *
 * Run again at any time: the keys of an adopted workspace are never replaced, only its addresses and
 * terminals are brought up to date. After a successful adoption AUTH_SECRET no longer protects any
 * stored data and can be rotated (which signs everybody out of workspaces still read from the
 * environment — there are none once this has run).
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { closeControlDb, controlConfigured, controlDb } from "../src/lib/platform/control-db";
import { openForTenant, sealForTenant } from "../src/lib/platform/kek";
import { decryptWith } from "../src/lib/crypto";
import { adoptedKeyBundle, openKeyBundle, sealKeyBundle } from "../src/lib/tenancy/keys";
import { legacyHosts, SLUG_PATTERN, RESERVED_SLUGS } from "../src/lib/tenancy/host";
import { defaultSlug, forgetRegistry } from "../src/lib/tenancy/registry";
import { INTERNAL_PLAN_KEY, startOnPlan } from "../src/lib/platform/plans";
import { refreshEntitlements } from "../src/lib/platform/entitlements";

const dryRun = process.argv.includes("--dry-run");
const say = (line: string) => console.log(line);

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

/** Up to `take` stored ciphertexts from each table that holds some, for proving keys open them. */
async function sampleCiphertexts(workspace: PrismaClient, take = 5): Promise<{ where: string; cipher: string }[]> {
  const out: { where: string; cipher: string }[] = [];
  const add = (where: string, ciphers: (string | null | undefined)[]) => {
    for (const cipher of ciphers) if (cipher) out.push({ where, cipher });
  };
  add("two-factor secrets", (await workspace.user.findMany({ where: { twoFactorSecretCipher: { not: null } }, select: { twoFactorSecretCipher: true }, take })).map((r) => r.twoFactorSecretCipher));
  add("the vault", (await workspace.vaultCredential.findMany({ select: { secretCipher: true }, take })).map((r) => r.secretCipher));
  add("project credentials", (await workspace.projectCredential.findMany({ select: { secretCipher: true }, take })).map((r) => r.secretCipher));
  add("messaging providers", (await workspace.messagingProvider.findMany({ where: { secretCipher: { not: null } }, select: { secretCipher: true }, take })).map((r) => r.secretCipher));
  add("mailbox connections", (await workspace.mailConnection.findMany({ select: { refreshTokenCipher: true }, take })).map((r) => r.refreshTokenCipher));
  const security = await workspace.securitySettings.findUnique({ where: { id: "global" }, select: { microsoftClientSecretCipher: true } });
  add("the Microsoft sign-in secret", [security?.microsoftClientSecretCipher]);
  return out;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const authSecret = process.env.AUTH_SECRET;
  if (!controlConfigured()) fail("CONTROL_DATABASE_URL is not set — see .env.example.");
  if (!process.env.PLATFORM_MASTER_KEY?.trim()) fail("PLATFORM_MASTER_KEY is not set — see .env.example.");
  if (!databaseUrl) fail("DATABASE_URL is not set: it is the database being adopted.");
  if (!authSecret) fail("AUTH_SECRET is not set: the keys being adopted are derived from it.");

  const slug = defaultSlug();
  if (!SLUG_PATTERN.test(slug) || RESERVED_SLUGS.has(slug)) fail(`TENANCY_DEFAULT_SLUG "${slug}" cannot be a workspace address.`);
  const name = process.env.TENANCY_DEFAULT_NAME?.trim() || slug;
  const hosts = legacyHosts();
  const dbName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));

  const control = controlDb();
  const workspace = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    say(`Workspace #1: "${name}" at ${slug}.${process.env.PLATFORM_DOMAIN ?? "localhost"}, database ${dbName}${dryRun ? " — dry run, nothing will be written" : ""}`);

    // ── Which migration it is on ────────────────────────────────────────────────────────────────
    const [latest] = await workspace.$queryRaw<{ name: string }[]>`
      select migration_name as name from _prisma_migrations where finished_at is not null and rolled_back_at is null order by migration_name desc limit 1`;
    say(`  schema: ${latest?.name ?? "unknown"}`);

    // ── The keys, proved against what is already stored ─────────────────────────────────────────
    const existing = await control.tenant.findFirst({ where: { isDefault: true } });
    const bundle = existing ? openKeyBundle(existing.id, existing.keyBundleCipher) : adoptedKeyBundle(authSecret);
    const dataKey = Buffer.from(bundle.data, "base64");
    const samples = await sampleCiphertexts(workspace);
    const failed = samples.filter((s) => {
      try {
        decryptWith({ dataKey }, s.cipher);
        return false;
      } catch {
        return true;
      }
    });
    say(`  keys: ${samples.length - failed.length} of ${samples.length} stored secret(s) sampled open with them`);
    if (samples.length > 0 && failed.length === samples.length) {
      fail("None of the stored secrets open with these keys: AUTH_SECRET is not the one they were stored under. Nothing was written.");
    }
    if (failed.length) {
      say(`  (${failed.length} did not — ${[...new Set(failed.map((f) => f.where))].join(", ")}. Those were already unreadable to the app; they are re-entered, not recovered.)`);
    }

    // ── Its biometric terminals ─────────────────────────────────────────────────────────────────
    const devices = await workspace.biometricDevice.findMany({ select: { serialNumber: true } });
    const serials = devices.map((d) => d.serialNumber.trim()).filter(Boolean);
    const claimed = await control.biometricDeviceRoute.findMany({ where: { serial: { in: serials } }, select: { serial: true, tenantId: true } });

    if (existing) {
      say(`  already adopted as ${existing.id} — keys kept; addresses and terminals brought up to date`);
      if (existing.slug !== slug) say(`  (its address name is "${existing.slug}"; TENANCY_DEFAULT_SLUG "${slug}" is ignored once adopted)`);
      const dbUrl = existing.dbUrlCipher ? openForTenant(existing.id, "db-url", existing.dbUrlCipher) : null;
      if (dbUrl !== databaseUrl) say("  NOTE: DATABASE_URL differs from the one recorded. The recorded one is kept — change it from the console.");
    }

    const taken = claimed.filter((c) => existing?.id !== c.tenantId);
    if (taken.length) say(`  ${taken.length} terminal serial(s) already belong to another workspace and are left there: ${taken.map((t) => t.serial).join(", ")}`);
    const otherHosts = await control.tenantDomain.findMany({ where: { host: { in: hosts }, NOT: existing ? { tenantId: existing.id } : undefined }, select: { host: true } });
    if (otherHosts.length) fail(`These addresses already reach another workspace: ${otherHosts.map((h) => h.host).join(", ")}. Nothing was written.`);

    if (dryRun) {
      say("\nDry run: every check passed; nothing was written.");
      return;
    }

    // ── Write ───────────────────────────────────────────────────────────────────────────────────
    const tenantId = existing?.id ?? randomUUID();
    const freeSerials = serials.filter((s) => !claimed.some((c) => c.serial === s));
    await control.$transaction(async (tx) => {
      if (!existing) {
        await tx.tenant.create({
          data: {
            id: tenantId,
            slug,
            name,
            status: "ACTIVE",
            isDefault: true,
            dbName,
            dbUrlCipher: sealForTenant(tenantId, "db-url", databaseUrl),
            keyBundleCipher: sealKeyBundle(tenantId, bundle),
            schemaVersion: latest?.name ?? null,
          },
        });
      } else {
        await tx.tenant.update({ where: { id: tenantId }, data: { schemaVersion: latest?.name ?? existing.schemaVersion } });
      }
      const known = await tx.tenantDomain.findMany({ where: { tenantId }, select: { host: true, isPrimary: true } });
      const hasPrimary = known.some((d) => d.isPrimary);
      for (const [i, host] of hosts.entries()) {
        if (known.some((d) => d.host === host)) continue;
        await tx.tenantDomain.create({ data: { tenantId, host, kind: "LEGACY", isPrimary: !hasPrimary && i === 0 } });
      }
      if (freeSerials.length) await tx.biometricDeviceRoute.createMany({ data: freeSerials.map((serial) => ({ serial, tenantId })), skipDuplicates: true });
      await tx.platformAuditLog.create({
        data: {
          actorKind: "SCRIPT",
          actor: "platform:adopt",
          action: existing ? "tenant.adopt.refresh" : "tenant.adopt",
          tenantId,
          detail: { slug, hosts, terminals: freeSerials.length, schema: latest?.name ?? null },
        },
      });
    });
    // Everything it had before plans existed, and no limits — the installation's own workspace.
    const internal = await control.plan.findUnique({ where: { key: INTERNAL_PLAN_KEY }, select: { id: true } });
    if (!internal) throw new Error(`The ${INTERNAL_PLAN_KEY} plan is missing — run the control plane's migrations first.`);
    const onPlan = await control.subscriptionItem.count({ where: { subscription: { tenantId }, planId: internal.id } });
    if (!onPlan) await control.$transaction((tx) => startOnPlan(tx, tenantId, internal.id));
    await refreshEntitlements(tenantId);
    forgetRegistry();

    // Read back, through the same functions the app uses.
    const saved = await control.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { domains: true } });
    const reopened = openKeyBundle(saved.id, saved.keyBundleCipher);
    const addressReadsBack = existing ? true : !!saved.dbUrlCipher && openForTenant(saved.id, "db-url", saved.dbUrlCipher) === databaseUrl;
    if (reopened.data !== bundle.data || !addressReadsBack) {
      fail("The recorded workspace does not read back as written. Check the control plane before going on.");
    }
    say(`\n${existing ? "Updated" : "Adopted"}: ${saved.id}`);
    say(`  addresses: ${[`${saved.slug}.${process.env.PLATFORM_DOMAIN ?? "localhost"}${process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : ""}`, ...saved.domains.map((d) => `${d.host}${d.isPrimary ? " (links)" : ""}`)].join(", ")}`);
    say(`  terminals: ${freeSerials.length} routed`);
    if (!existing) say("\nEverybody signs in once more: sessions are now this workspace's own.");
  } finally {
    await workspace.$disconnect();
    await closeControlDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
