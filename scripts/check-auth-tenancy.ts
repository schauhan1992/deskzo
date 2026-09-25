/**
 * check:auth-tenancy — what one workspace holds means nothing in another.
 *
 * Builds a scratch control plane and two scratch workspaces beside the real databases (all three
 * dropped at the end, pass or fail), records the workspaces the way provisioning will — sealed
 * database address, sealed random key bundle, a custom domain — and then shows:
 *
 *   · the registry finds each by its subdomain and its own domain, and nothing else;
 *   · until a workspace is marked the default, the environment's first workspace stands in; after,
 *     it does not;
 *   · a stored secret, a secret's digest, a tracking link, a document render pass and a sign-in
 *     session made in one workspace are refused in the other;
 *   · a sealed key bundle or database address copied onto another workspace's row does not open;
 *   · the session cookie is bound to its host over https;
 *   · the first workspace, adopted, reads everything the installation stored before workspaces —
 *     ciphertexts, digests and tracking links made the old way;
 *   · the restore worker refuses to start without being told its workspace.
 */
import "dotenv/config";
import { execSync, spawnSync } from "node:child_process";
import { createCipheriv, createHmac, randomBytes, randomUUID, scryptSync } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

process.env.WROFFY_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
const throws = async (run: () => unknown) => {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
};
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function main() {
  const url = process.env.DATABASE_URL;
  const authSecret = process.env.AUTH_SECRET;
  if (!url || !authSecret) throw new Error("DATABASE_URL and AUTH_SECRET are needed.");
  if (!process.env.PLATFORM_MASTER_KEY) throw new Error("PLATFORM_MASTER_KEY is needed — see .env.example.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A scratch control plane and two scratch workspaces");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const names = { control: `${realName}_authcheck_control`, a: `${realName}_authcheck_a`, b: `${realName}_authcheck_b` };
  const urls = { control: withDatabase(url, names.control), a: withDatabase(url, names.a), b: withDatabase(url, names.b) };
  const admin = new PrismaClient({ datasourceUrl: withDatabase(url, "postgres") });
  let cleanup: (() => Promise<void>) | null = null;
  try {
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    for (const name of [names.control, names.a]) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: urls.control }, timeout: 5 * 60_000 });
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: urls.a }, timeout: 10 * 60_000 });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.b}" TEMPLATE "${names.a}"`);
    ok("built from the migrations", true);

    // Everything under src reads this when it first needs the control plane.
    process.env.CONTROL_DATABASE_URL = urls.control;
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const { sealForTenant } = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const crypto = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
    const tracking = require("../src/lib/marketing/tracking") as typeof import("../src/lib/marketing/tracking");
    const render = require("../src/lib/documents/render-token") as typeof import("../src/lib/documents/render-token");
    const { sessionOptions, SESSION_COOKIE_SECURE, SESSION_COOKIE_PLAIN } = require("../src/lib/auth-session") as typeof import("../src/lib/auth-session");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const { encode, decode } = require("@auth/core/jwt") as typeof import("@auth/core/jwt");
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };

    const control = controlDb();
    const make = async (slug: string, dbUrl: string, extra: { domain?: string; status?: "ACTIVE" | "SUSPENDED" } = {}) => {
      const id = randomUUID();
      await control.tenant.create({
        data: {
          id,
          slug,
          name: slug,
          status: extra.status ?? "ACTIVE",
          dbName: new URL(dbUrl).pathname.slice(1),
          dbUrlCipher: sealForTenant(id, "db-url", dbUrl),
          keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()),
          domains: extra.domain ? { create: { host: extra.domain, kind: "CUSTOM", isPrimary: true } } : undefined,
        },
      });
      return id;
    };
    const idA = await make("zzauth-a", urls.a);
    const idB = await make("zzauth-b", urls.b, { domain: "erp.zzauth-b.example" });
    await make("zzauth-held", urls.a, { status: "SUSPENDED" });
    registry.forgetRegistry();

    section("The registry reads the control plane");
    const port = process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : "";
    const domain = process.env.PLATFORM_DOMAIN ?? "localhost";
    const A = await registry.tenantForHost(`zzauth-a.${domain}${port}`);
    const B = await registry.tenantForHost("erp.zzauth-b.example");
    ok("each workspace by its subdomain", A?.id === idA && (await registry.tenantForHost(`zzauth-b.${domain}${port}`))?.id === idB);
    ok("  and by a domain of its own", B?.id === idB, B?.slug);
    ok("  whose links are built on that domain", B?.primaryHost === "erp.zzauth-b.example");
    ok("  its database address opened from its seal", A?.dbUrl === urls.a && B?.dbUrl === urls.b);
    ok("an unknown name reaches nothing", (await registry.tenantForHost(`zzauth-nobody.${domain}${port}`)) === null);
    ok("a held workspace is found, and says so — the proxy refuses it", (await registry.tenantBySlug("zzauth-held"))?.status === "SUSPENDED");
    if (!A || !B) throw new Error("registry");

    const envDefault = process.env.TENANCY_DEFAULT_SLUG ?? "wroffy";
    ok("with no default workspace yet, the environment's first one stands in", (await registry.legacyTenant())?.source === "env" && !!(await registry.tenantBySlug(envDefault)));
    await control.tenant.update({ where: { id: idA }, data: { isDefault: true } });
    registry.forgetRegistry();
    ok("  once one is the default, it is the first workspace", (await registry.legacyTenant())?.id === idA);
    ok("  and the environment's no longer answers", envDefault === "zzauth-a" || (await registry.tenantBySlug(envDefault)) === null);
    await control.tenant.update({ where: { id: idA }, data: { isDefault: false } });
    registry.forgetRegistry();

    section("Nothing one workspace holds means anything in the other");
    const [kA, kB] = await Promise.all([keys.keysFor(A), keys.keysFor(B)]);
    ok("each has keys of its own", !kA.dataKey.equals(kB.dataKey) && kA.sessionSecret !== kB.sessionSecret && kA.fingerprint !== kB.fingerprint);

    const cipher = await runAsTenant(A, () => crypto.encryptSecret("zz-the-vault-password"));
    ok("a secret stored in A reads back in A", (await runAsTenant(A, () => crypto.decryptSecret(cipher))) === "zz-the-vault-password");
    ok("  and does not open in B", await throws(() => runAsTenant(B, () => crypto.decryptSecret(cipher))));
    const [digestA, digestB] = await Promise.all([runAsTenant(A, () => crypto.digestSecret("hunter2")), runAsTenant(B, () => crypto.digestSecret("hunter2"))]);
    ok("the same password digests differently in each — reuse can't be matched across them", digestA !== digestB);

    const token = "zz-message-token";
    const destination = "https://example.com/offer";
    const signature = tracking.signDestinationWith(kA.trackingKey, token, destination);
    ok("a tracking link A sent is followed in A", await runAsTenant(A, () => tracking.destinationIsOurs(token, destination, signature)));
    ok("  and not in B — its signature is A's", !(await runAsTenant(B, () => tracking.destinationIsOurs(token, destination, signature))));

    const webhook = require("../src/lib/marketing/webhook-secret") as typeof import("../src/lib/marketing/webhook-secret");
    const [hookA, hookB] = await Promise.all([runAsTenant(A, webhook.marketingWebhookSecret), runAsTenant(B, webhook.marketingWebhookSecret)]);
    ok("delivery reports for A carry A's own key", hookA !== hookB && (await runAsTenant(A, () => webhook.isMarketingWebhookSecret(hookA))));
    ok("  which B does not accept", !(await runAsTenant(B, () => webhook.isMarketingWebhookSecret(hookA))));
    const sharedBefore = process.env.MARKETING_WEBHOOK_SECRET;
    process.env.MARKETING_WEBHOOK_SECRET = "zz-install-wide-key";
    try {
      ok("  the install-wide key from before workspaces is refused by a new workspace", !(await runAsTenant(A, () => webhook.isMarketingWebhookSecret("zz-install-wide-key"))));
      ok("  and still accepted by the first, whose providers were set up with it", await runAsTenant({ ...A, isDefault: true }, () => webhook.isMarketingWebhookSecret("zz-install-wide-key")));
    } finally {
      if (sharedBefore === undefined) delete process.env.MARKETING_WEBHOOK_SECRET;
      else process.env.MARKETING_WEBHOOK_SECRET = sharedBefore;
    }

    const pass = await runAsTenant(A, () => render.newRenderToken("zz-document-1"));
    ok("a render pass minted in A opens A's print page", (await runAsTenant(A, () => render.verifyRenderToken(pass.token, "zz-document-1"))) === pass.nonce);
    ok("  and not B's, for a document with the same id", (await runAsTenant(B, () => render.verifyRenderToken(pass.token, "zz-document-1"))) === null);

    const rowA = await control.tenant.findUniqueOrThrow({ where: { id: idA } });
    ok("A's sealed keys copied onto B's row do not open as B's", await throws(() => keys.openKeyBundle(idB, rowA.keyBundleCipher)));
    const { openForTenant } = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    ok("  nor does A's database address", await throws(() => openForTenant(idB, "db-url", rowA.dbUrlCipher ?? "")));
    ok("  nor A's keys read as a database address", await throws(() => openForTenant(idA, "db-url", rowA.keyBundleCipher)));

    section("Sign-in sessions");
    const request = (host: string) => new Request(`http://${host}/login`, { headers: { host } });
    const optsA = await sessionOptions(request(`zzauth-a.${domain}${port}`));
    const optsB = await sessionOptions(request(`zzauth-b.${domain}${port}`));
    ok("each workspace signs sessions with its own secret", optsA.tenantId === idA && optsB.tenantId === idB && optsA.options.secret !== optsB.options.secret);
    const cookie = optsA.options.cookies.sessionToken.name;
    const jwt = await encode({ token: { sub: "u1", id: "u1", tid: idA }, secret: optsA.options.secret, salt: cookie });
    ok("a session from A opens in A, naming A", (await decode({ token: jwt, secret: optsA.options.secret, salt: cookie }))?.tid === idA);
    ok("  and is nothing in B", await throws(async () => {
      const decoded = await decode({ token: jwt, secret: optsB.options.secret, salt: cookie });
      if (decoded === null) throw new Error("no session");
    }));
    ok("over http in development the cookie is plain", cookie === SESSION_COOKIE_PLAIN && optsA.options.cookies.sessionToken.options.secure === false);
    const secure = await sessionOptions(request("erp.zzauth-b.example"));
    ok(
      "over https it is __Host-: this host only, never a sibling subdomain",
      secure.options.cookies.sessionToken.name === SESSION_COOKIE_SECURE && secure.options.cookies.sessionToken.options.secure && secure.options.cookies.sessionToken.options.path === "/",
    );
    const nowhere = await sessionOptions(request(`zzauth-nobody.${domain}${port}`));
    ok("an address that reaches no workspace gets a secret no session was made with", nowhere.tenantId === null && nowhere.options.secret !== optsA.options.secret && nowhere.options.secret !== optsB.options.secret);

    section("The first workspace, adopted, reads what came before");
    const adopted = keys.adoptedKeyBundle(authSecret);
    const adoptedKeys = { dataKey: Buffer.from(adopted.data, "base64") };
    // Written exactly as src/lib/crypto.ts did before workspaces.
    const oldKey = scryptSync(authSecret, "wroffy-crm-secret-store", 32);
    const iv = randomBytes(12);
    const oldCipher = createCipheriv("aes-256-gcm", oldKey, iv);
    const oldData = Buffer.concat([oldCipher.update("zz-stored-before-workspaces", "utf8"), oldCipher.final()]);
    const oldStored = [iv.toString("base64"), oldCipher.getAuthTag().toString("base64"), oldData.toString("base64")].join(":");
    ok("a secret stored before workspaces opens with the adopted keys", crypto.decryptWith(adoptedKeys, oldStored) === "zz-stored-before-workspaces");
    const oldDigest = createHmac("sha256", scryptSync(authSecret, "wroffy-crm-secret-digest", 32)).update("hunter2", "utf8").digest("base64");
    ok("  a digest made before matches one made now", createHmac("sha256", Buffer.from(adopted.digest, "base64")).update("hunter2", "utf8").digest("base64") === oldDigest);
    const oldLink = createHmac("sha256", authSecret).update(`${token}${String.fromCharCode(0)}${destination}`).digest("hex").slice(0, 32);
    ok("  a tracking link already in somebody's inbox still verifies", tracking.signDestinationWith(Buffer.from(adopted.tracking, "base64"), token, destination) === oldLink);
    ok("  and its sign-in secret is new — everybody signs in once more", adopted.session !== keys.adoptedKeyBundle(authSecret).session);

    section("Workers are told their workspace");
    const worker = spawnSync(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), path.join("scripts", "restore-worker.ts"), "zzcheck-staged-id"], {
      env: { ...process.env, WROFFY_TENANT_ID: "" },
      encoding: "utf8",
      timeout: 60_000,
    });
    ok("the restore worker will not start without one", worker.status === 1 && /WROFFY_TENANT_ID is required/.test(worker.stderr), worker.stderr.trim().split("\n").pop());
  } finally {
    if (cleanup) await cleanup().catch(() => {});
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname in (${names.control}, ${names.a}, ${names.b})`;
    ok("the scratch databases are dropped", Number(left[0].n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll auth tenancy checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
