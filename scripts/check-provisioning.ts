/**
 * check:provisioning — a workspace from signup to closing, for real.
 *
 * On a scratch control plane, with real workspace databases made on the local server (every one
 * dropped at the end, pass or fail):
 *
 *   · the signup form refuses what it should, emails a code, and only the right code in the browser
 *     that asked starts a workspace; an invitation is spent once;
 *   · the worker sets it up from a warm database — owner, organisation, branding — and a second from
 *     a fresh one; each database has a role of its own that no other workspace's role can open;
 *   · the new owner is handed straight in with a one-time pass, once;
 *   · "forgot password" says the same for any address, and its link works once;
 *   · the migration runner goes round the workspaces, holds one whose migration fails, and lets it
 *     through again once it can; given a list, it migrates those workspaces and nothing else;
 *   · a workspace can be held, reopened, closed with a final backup, and purged.
 *
 * No mail leaves: the platform mailer is replaced. No worker process is started: the one the signup
 * starts is replaced, and the jobs are run here.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import bcrypt from "bcryptjs";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.WROFFY_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;
// The shared reference database is not this check's to migrate.
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.REFERENCE_DATABASE_URL = "";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ─── A request, as the signup and reset actions see one ──────────────────────────────────────────
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: "www.localhost:3000", "x-forwarded-for": "203.0.113.7" });
const load = Module.createRequire(__filename);
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
let workerStarts = 0;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    };
  }
  // The worker the signup starts: counted, not run — this check runs the jobs itself.
  if ((request === "node:child_process" || request === "child_process") && parent?.filename?.endsWith(`signup.ts`)) {
    return { spawn: () => ((workerStarts += 1), { unref() {} }) };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;
void load;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_provcheck_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  const made = new Set<string>();
  let cleanup: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
    const provisioning = require("../src/lib/platform/provisioning") as typeof import("../src/lib/platform/provisioning");
    const provisioner = require("../src/lib/platform/provisioner") as typeof import("../src/lib/platform/provisioner");
    const signup = require("../src/actions/platform/signup") as typeof import("../src/actions/platform/signup");
    const handoff = require("../src/lib/platform/handoff") as typeof import("../src/lib/platform/handoff");
    const lifecycle = require("../src/lib/platform/lifecycle") as typeof import("../src/lib/platform/lifecycle");
    const runner = require("../src/lib/platform/tenant-migrations") as typeof import("../src/lib/platform/tenant-migrations");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const { sealForTenant } = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();
    const mail: { to: string; subject: string; text: string }[] = [];
    mailer.setTestPlatformMailer(async (m) => void mail.push(m));
    const remember = async () => {
      for (const t of await control.tenant.findMany({ select: { dbName: true } })) if (t.dbName) made.add(t.dbName);
      for (const w of await control.warmDatabase.findMany({ select: { dbName: true } })) made.add(w.dbName);
    };

    section("A warm database, ready before anybody signs up");
    const pool = await provisioning.fillWarmPool(1);
    await remember();
    const warm = await control.warmDatabase.findFirst();
    ok("one is made and migrated", pool.made === 1 && !!warm?.schemaVersion, warm?.dbName);

    section("Signing up");
    const INVITE = "zz-provcheck-invite";
    await control.signupInvite.create({ data: { codeHash: sha256(INVITE), maxUses: 1 } });
    const form = { companyName: "Zz Provcheck Ltd", slug: "zzprov-a", ownerName: "Asha Zz", email: "asha@zzprov.example", password: "correct horse battery", country: "IN", invite: INVITE };
    const refusals = await Promise.all([
      signup.startSignup({ ...form, invite: "not-an-invite" }),
      signup.startSignup({ ...form, email: "someone@mailinator.com" }),
      signup.startSignup({ ...form, slug: "admin" }),
      signup.startSignup({ ...form, password: "short" }),
    ]);
    ok("refused: no invitation, a throwaway address, a reserved name, a short password", refusals.every((r) => !r.ok), refusals.map((r) => (r.ok ? "accepted" : r.error.slice(0, 40))).join(" | "));
    const started = await signup.startSignup(form);
    ok("the form is accepted and a code is emailed", started.ok && mail.length === 1 && /\d{6}/.test(mail[0].subject), started.ok ? mail[0]?.subject : started.error);
    const code = mail[0]?.subject.match(/(\d{6})$/)?.[1] ?? "";
    ok("  to the address given, with nothing else in it worth stealing", mail[0]?.to === form.email && !mail[0].text.includes(form.password));
    ok("  and only this browser holds the signup", jar.has("wroffy.signup"));
    const pendingRow = await control.pendingSignup.findFirst({ where: { slug: "zzprov-a" } });
    ok("  the password is kept only as a hash", !!pendingRow && pendingRow.passwordHash !== form.password && (await bcrypt.compare(form.password, pendingRow.passwordHash)));

    const wrong = await signup.verifySignup("000000" === code ? "111111" : "000000");
    ok("a wrong code is refused", !wrong.ok);
    const otherBrowser = new Map(jar);
    jar.clear();
    const noCookie = await signup.verifySignup(code);
    ok("the right code from another browser is refused", !noCookie.ok);
    for (const [k, v] of otherBrowser) jar.set(k, v);
    const verified = await signup.verifySignup(code);
    const tenantRow = await control.tenant.findUnique({ where: { slug: "zzprov-a" } });
    ok("the right code here starts the workspace", verified.ok && tenantRow?.status === "PROVISIONING" && workerStarts === 1, verified.ok ? tenantRow?.status : verified.error);
    ok("  and spends the invitation", (await control.signupInvite.findUnique({ where: { codeHash: sha256(INVITE) } }))?.uses === 1);
    ok("  and forgets the password everywhere but the job", (await control.pendingSignup.findFirst({ where: { slug: "zzprov-a" } }))?.passwordHash === "");
    ok("the address is now taken", !(await signup.checkWorkspaceName("zzprov-a")).ok);
    const waiting = await signup.signupProgress();
    ok("the progress page says it is being set up", waiting.state === "setting-up");

    section("The worker sets it up");
    const run = await provisioning.runNextJob();
    await remember();
    const A = await control.tenant.findUniqueOrThrow({ where: { slug: "zzprov-a" } });
    ok("the job runs", run?.ok === true, run?.error);
    ok("  on the warm database", A.dbName === warm?.dbName && !!(await control.warmDatabase.findFirst({ where: { dbName: A.dbName! } }))?.claimedAt);
    ok("  and the workspace is open", A.status === "ACTIVE");
    const job = await control.provisioningJob.findFirstOrThrow({ where: { tenantId: A.id } });
    ok("  the job no longer holds the password", job.status === "SUCCEEDED" && job.ownerPasswordHash === null);
    registry.forgetRegistry();
    const tenantA = (await registry.tenantBySlug("zzprov-a"))!;
    const inA = directClient(tenantA.dbUrl);
    try {
      const owner = await inA.user.findUnique({ where: { email: form.email } });
      ok("the owner is its super admin, with the password they chose", !!owner?.isSuperAdmin && owner.role === "ADMIN" && (await bcrypt.compare(form.password, owner.passwordHash)));
      ok("  and nobody else has an account", (await inA.user.count()) === 1);
      const org = await inA.organisationSettings.findUnique({ where: { id: "global" } });
      const brand = await inA.brandingSettings.findUnique({ where: { id: "global" } });
      ok("its organisation and its sign-in page carry its name", org?.legalName === form.companyName && org.country === "India" && brand?.appName === form.companyName);
    } finally {
      await inA.$disconnect();
    }
    ok("the owner is told where it is", mail.some((m) => m.to === form.email && /is ready/.test(m.subject) && m.text.includes("zzprov-a.")));

    section("Handed straight in");
    const ready = await signup.signupProgress();
    ok("the progress page hands over a one-time pass to the new address", ready.state === "ready" && ready.url.includes("zzprov-a.") && ready.url.includes("/handoff?t="));
    const again = await signup.signupProgress();
    ok("  once — a second look is sent to the sign-in page", again.state === "ready" && again.url.endsWith("/login"));
    const ticket = ready.state === "ready" ? decodeURIComponent(new URL(ready.url).searchParams.get("t") ?? "") : "";
    const spent = await handoff.spendHandoffTicket(ticket, A.id);
    ok("the pass signs in the owner, at their workspace", spent?.email === form.email && spent.purpose === "owner-signup");
    ok("  and only once", (await handoff.spendHandoffTicket(ticket, A.id)) === null);

    section("A second workspace, from a fresh database");
    const second = await provisioning.startProvisioning({ slug: "zzprov-b", companyName: "Zz Second", ownerName: "Ravi Zz", ownerEmail: "ravi@zzprov.example", ownerPasswordHash: await bcrypt.hash("another long password", 10), country: "AE" });
    const secondRun = await provisioning.runNextJob();
    await remember();
    const B = await control.tenant.findUniqueOrThrow({ where: { id: second.tenantId } });
    ok("with no warm database left, one is made on the spot", secondRun?.ok === true && B.status === "ACTIVE" && B.dbName !== A.dbName, secondRun?.error);
    ok("  in its country's currency", B.currency === "AED" && B.country === "AE");
    const passForB = await handoff.createHandoffTicket(B.id, "ravi@zzprov.example", "owner-signup");
    ok("a pass for one workspace is nothing at another", (await handoff.spendHandoffTicket(passForB, A.id)) === null);

    registry.forgetRegistry();
    const tenantB = (await registry.tenantBySlug("zzprov-b"))!;
    const roles = await admin.$queryRaw<{ rolname: string; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }[]>`
      select rolname::text as rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname in (${A.dbRole}, ${B.dbRole})`;
    ok("each database has a login of its own, with no power over the server", roles.length === 2 && roles.every((r) => !r.rolsuper && !r.rolcreatedb && !r.rolcreaterole));
    const crossUrl = new URL(tenantB.dbUrl);
    crossUrl.pathname = `/${A.dbName}`;
    const cross = directClient(crossUrl.toString());
    const crossed = await cross.$queryRaw`select 1`.then(() => "connected").catch((e: Error) => e.message);
    await cross.$disconnect();
    ok("B's login cannot even open A's database", crossed !== "connected" && /permission denied|not permitted|denied/i.test(crossed), crossed.split("\n").find((l) => /denied/i.test(l))?.trim().slice(0, 90));

    section("Forgot password");
    const reset = require("../src/actions/password-reset") as typeof import("../src/actions/password-reset");
    await control.tenant.update({ where: { id: A.id }, data: { isDefault: true } });
    registry.forgetRegistry();
    const tA = (await registry.tenantBySlug("zzprov-a"))!;
    const before = mail.length;
    await runAsTenant(tA, () => reset.requestPasswordReset("nobody@zzprov.example"));
    ok("an address with no account gets the same answer, and no mail", mail.length === before);
    await runAsTenant(tA, () => reset.requestPasswordReset(form.email));
    const resetMail = mail.at(-1);
    const link = resetMail?.text.match(/https?:\/\/\S+reset-password\?t=\S+/)?.[0] ?? "";
    ok("the owner is emailed a link to their own workspace", resetMail?.to === form.email && link.includes("zzprov-a."));
    const token = decodeURIComponent(new URL(link || "http://x/").searchParams.get("t") ?? "");
    const short = await runAsTenant(tA, () => reset.resetPassword({ token, password: "short" }));
    ok("a short password is refused", !short.ok);
    const done = await runAsTenant(tA, () => reset.resetPassword({ token, password: "a brand new long password" }));
    const reused = await runAsTenant(tA, () => reset.resetPassword({ token, password: "yet another long password" }));
    const inA2 = directClient(tA.dbUrl);
    const ownerAfter = await inA2.user.findUniqueOrThrow({ where: { email: form.email } });
    await inA2.$disconnect();
    ok("the link sets the new password", done.ok && (await bcrypt.compare("a brand new long password", ownerAfter.passwordHash)));
    ok("  once", !reused.ok);

    section("Migrations, every workspace");
    const first = await runner.migrateEverything();
    ok("the control plane, the canary and the rest", first.platform.every((p) => p.ok) && first.workspaces.length === 2 && first.workspaces.every((w) => w.ok === true), JSON.stringify(first.workspaces));
    const recordedRuns = await control.tenantMigrationRun.findMany({ where: { runId: first.runId }, select: { target: true, ok: true } });
    ok(
      "  each recorded: the control plane and both workspaces",
      recordedRuns.length === 3 && ["control", "zzprov-a", "zzprov-b"].every((t) => recordedRuns.some((r) => r.target === t && r.ok === true)),
      recordedRuns.map((r) => `${r.target}:${r.ok}`).join(", "),
    );
    // B's database becomes unreachable: its next migration fails.
    const goodCipher = B.dbUrlCipher!;
    const broken = new URL(tenantB.dbUrl);
    broken.password = "wrong";
    await control.tenant.update({ where: { id: B.id }, data: { dbUrlCipher: sealForTenant(B.id, "db-url", broken.toString()) } });
    registry.forgetRegistry();
    const failing = await runner.migrateEverything();
    ok("a workspace whose migration fails is reported", failing.workspaces.some((w) => w.slug === "zzprov-b" && w.ok === false));
    ok("  and held at the maintenance page, while the others carry on", (await control.tenant.findUniqueOrThrow({ where: { id: B.id } })).status === "MIGRATING" && failing.workspaces.some((w) => w.slug === "zzprov-a" && w.ok === true));
    await control.tenant.update({ where: { id: B.id }, data: { dbUrlCipher: goodCipher } });
    registry.forgetRegistry();
    const retried = await runner.migrateEverything({ only: "zzprov-b" });
    ok("the next run lets it through again", retried.workspaces.some((w) => w.slug === "zzprov-b" && w.ok === true) && (await control.tenant.findUniqueOrThrow({ where: { id: B.id } })).status === "ACTIVE");
    const listed = await runner.migrateEverything({ only: ["zzprov-a", "zzprov-b"] });
    const listedRuns = await control.tenantMigrationRun.findMany({ where: { runId: listed.runId }, select: { target: true, ok: true } });
    const slugsOf = (list: { slug?: string; target?: string }[]) => list.map((w) => w.slug ?? w.target).sort().join();
    ok(
      "a list of workspaces: each of them migrated, and nothing else — no control plane, no warm database",
      listed.platform.length === 0 && slugsOf(listed.workspaces) === "zzprov-a,zzprov-b" && listed.workspaces.every((w) => w.ok === true) && slugsOf(listedRuns) === "zzprov-a,zzprov-b",
      `${JSON.stringify(listed.workspaces)} · recorded ${slugsOf(listedRuns)}`,
    );
    const named = await runner.migrateEverything({ only: ["zzprov-a", "zz-nobody"] });
    ok("  a name that is no workspace is passed over, and one left off the list is not touched", named.platform.length === 0 && slugsOf(named.workspaces) === "zzprov-a", JSON.stringify(named.workspaces));

    section("Held, reopened, closed");
    await lifecycle.suspendTenant(B.id, "check:provisioning", "zz testing");
    ok("a held workspace is not served", (await registry.tenantBySlug("zzprov-b"))?.status === "SUSPENDED");
    await lifecycle.resumeTenant(B.id, "check:provisioning");
    ok("  and reopened, exactly as it was", (await registry.tenantBySlug("zzprov-b"))?.status === "ACTIVE");
    const closed = await lifecycle.deprovisionTenant(B.id, "check:provisioning");
    const backupFolder = path.join(process.env.BACKUP_DIR?.trim() || "backups", "workspaces", B.id);
    ok("closing it takes a final backup first, into its own folder", !!closed.backup && existsSync(path.join(backupFolder, closed.backup)), closed.backup);
    ok("  then drops its database and its login", !(await provisioner.workspaceDatabaseExists(B.dbName!)) && (await admin.$queryRaw<unknown[]>`select 1 from pg_roles where rolname = ${B.dbRole}`).length === 0);
    const closedRow = await control.tenant.findUniqueOrThrow({ where: { id: B.id } });
    ok("  and keeps its keys for the retention period", closedRow.status === "DEPROVISIONED" && !closedRow.dbUrlCipher && !!closedRow.keyBundleCipher);
    let early = "";
    await lifecycle.purgeTenant(B.id, "check:provisioning").catch((e: Error) => (early = e.message));
    ok("purging before the retention period is refused", /kept until/.test(early), early);
    await lifecycle.purgeTenant(B.id, "check:provisioning", { force: true });
    registry.forgetRegistry();
    const purged = (await registry.tenantById(B.id))!;
    ok("purged: its keys are gone for good and its backups deleted", !existsSync(backupFolder) && (await keys.keysFor(purged).then(() => "opened").catch(() => "refused")) === "refused");
    ok("the first workspace cannot be closed this way", await lifecycle.deprovisionTenant(A.id, "check:provisioning").then(() => false).catch(() => true));
  } finally {
    if (cleanup) await cleanup().catch(() => {});
    for (const name of made) {
      if (/^w_[0-9a-f]{12}$/.test(name)) {
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
        await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${name}"`).catch(() => {});
      }
    }
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = any(${[...made, controlName]})`;
    ok("every database this check made is dropped", Number(left[0].n) === 0, `${made.size + 1} made`);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll provisioning checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
