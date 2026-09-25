/**
 * check:fanout — scheduled jobs run for every workspace, and terminals reach their own.
 *
 * Builds a scratch control plane and two scratch workspaces beside the real databases (all dropped
 * at the end, pass or fail) — one of them the default, so nothing here runs against the real
 * workspace — and shows:
 *
 *   · a job run for every workspace runs as each one: its database, its links;
 *   · a few at a time; one workspace's failure leaves the others alone;
 *   · a job that overruns its time limit is reported and left to finish — and while it runs, the
 *     same job for the same workspace is not started again, by anybody;
 *   · the tick routes: on a workspace's address that workspace, on the platform's address every
 *     active one and no held one, and nothing without the operator's secret;
 *   · a terminal's serial belongs to one workspace; a punch sent from a bare IP address lands in the
 *     workspace its serial is registered to, and nowhere else.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

process.env.WROFFY_TENANCY_FALLBACK = "legacy";
delete process.env.TRUST_PROXY;

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  section("A scratch control plane and two scratch workspaces");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const names = { control: `${realName}_fanout_control`, a: `${realName}_fanout_a`, b: `${realName}_fanout_b` };
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

    process.env.CONTROL_DATABASE_URL = urls.control;
    process.env.MARKETING_TICK_SECRET = "zz-fanout-tick-secret-0123456789";
    process.env.BACKUP_TICK_SECRET = "zz-fanout-backup-secret-0123456789";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const { sealForTenant } = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant, currentTenant, tenantOrigin } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const fanout = require("../src/lib/platform/fanout") as typeof import("../src/lib/platform/fanout");
    const routes = require("../src/lib/platform/device-routes") as typeof import("../src/lib/platform/device-routes");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };

    const control = controlDb();
    const make = async (slug: string, dbUrl: string, extra: { status?: "ACTIVE" | "SUSPENDED"; isDefault?: boolean } = {}) => {
      const id = randomUUID();
      await control.tenant.create({
        data: {
          id,
          slug,
          name: slug,
          status: extra.status ?? "ACTIVE",
          isDefault: extra.isDefault ?? false,
          dbName: new URL(dbUrl).pathname.slice(1),
          dbUrlCipher: sealForTenant(id, "db-url", dbUrl),
          keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()),
        },
      });
      return id;
    };
    // A is the default, so the environment's first workspace — the real one — is never among them.
    const idA = await make("zzfan-a", urls.a, { isDefault: true });
    const idB = await make("zzfan-b", urls.b);
    const idHeld = await make("zzfan-held", urls.b, { status: "SUSPENDED" });
    const extraIds = [];
    for (const n of [1, 2, 3]) extraIds.push(await make(`zzfan-x${n}`, urls.a));
    registry.forgetRegistry();
    const all = await registry.activeTenants();
    const A = all.find((t) => t.id === idA)!;
    const B = all.find((t) => t.id === idB)!;
    ok("every active workspace, and neither the held one nor the real one", all.length === 5 && !all.some((t) => t.id === idHeld) && !all.some((t) => t.source === "env"), all.map((t) => t.slug).join(", "));

    section("A job for every workspace");
    const who = await fanout.forEachTenant("zz-who", [A, B], async () => {
      const [{ name }] = await db.$queryRaw<{ name: string }[]>`select current_database() as name`;
      return { id: (await currentTenant()).id, database: name, origin: await tenantOrigin() };
    });
    const [ra, rb] = who;
    ok(
      "each runs as itself — its own database",
      "ok" in ra && ra.ok && ra.value.id === idA && ra.value.database === names.a && "ok" in rb && rb.ok && rb.value.id === idB && rb.value.database === names.b,
    );
    ok("  and its own address in links", "ok" in ra && ra.ok && ra.value.origin.includes("zzfan-a.") && "ok" in rb && rb.ok && rb.value.origin.includes("zzfan-b."));

    const mixed = await fanout.forEachTenant("zz-mixed", [A, B], async (t) => {
      if (t.id === idA) throw new Error("zz A broke");
      return "fine";
    });
    ok("one workspace failing is reported, and the other still runs", "ok" in mixed[0] && !mixed[0].ok && mixed[0].error === "zz A broke" && "ok" in mixed[1] && mixed[1].ok);
    const record = await control.tenantJobLease.findUnique({ where: { tenantId_job: { tenantId: idA, job: "zz-mixed" } } });
    ok("  the failure is on record for the console", record?.lastOk === false && record.lastError === "zz A broke" && record.leasedUntil <= new Date());

    let running = 0;
    let most = 0;
    await fanout.forEachTenant(
      "zz-lanes",
      all,
      async () => {
        running += 1;
        most = Math.max(most, running);
        await sleep(150);
        running -= 1;
      },
      { concurrency: 2 },
    );
    ok("a few at a time — never more than asked", most === 2, `${most} at once over ${all.length}`);

    section("A job that overruns");
    let finished = false;
    const slow = await fanout.forEachTenant(
      "zz-slow",
      [A],
      async () => {
        await sleep(1_500);
        finished = true;
      },
      { timeoutMs: 300 },
    );
    ok("is reported failed at its limit", "ok" in slow[0] && !slow[0].ok && /Still running/.test(slow[0].error) && !finished, "ok" in slow[0] && !slow[0].ok ? slow[0].error : "");
    const again = await fanout.forEachTenant("zz-slow", [A], async () => "second", { timeoutMs: 300 });
    ok("  and while it is still running, the same job is not started again for that workspace", "skipped" in again[0]);
    const other = await fanout.forEachTenant("zz-slow", [B], async () => "b", { timeoutMs: 300 });
    ok("  though another workspace's is", "ok" in other[0] && other[0].ok);
    await sleep(1_600);
    ok("once it really finishes, it may run again", finished && (await fanout.forEachTenant("zz-slow", [A], async () => "third")).every((o) => "ok" in o && o.ok));

    const [first, second] = await Promise.all([
      fanout.forEachTenant("zz-race", [A], async () => sleep(300)),
      fanout.forEachTenant("zz-race", [A], async () => sleep(300)),
    ]);
    ok("two schedulers at the same moment: one runs it, the other is told it is running", ["skipped" in first[0], "skipped" in second[0]].filter(Boolean).length === 1);

    section("The tick routes");
    const marketing = require("../src/app/api/marketing/tick/route") as typeof import("../src/app/api/marketing/tick/route");
    const backup = require("../src/app/api/backup/tick/route") as typeof import("../src/app/api/backup/tick/route");
    const port = process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : "";
    const domain = process.env.PLATFORM_DOMAIN ?? "localhost";
    const call = (route: typeof marketing, host: string, secret: string | null) =>
      route.GET(new Request(`http://${host}/api/tick`, { headers: { host, ...(secret ? { authorization: `Bearer ${secret}` } : {}) } }));

    ok("without the operator's secret, nothing", (await call(marketing, `admin.${domain}${port}`, null)).status === 401 && (await call(marketing, `admin.${domain}${port}`, "wrong")).status === 401);
    const platform = await call(marketing, `admin.${domain}${port}`, process.env.MARKETING_TICK_SECRET!);
    const platformBody = (await platform.json()) as { scope?: string; results?: { workspace: string; ok?: boolean; error?: string }[] };
    ok(
      "on the platform's address: every active workspace, each with its outcome",
      platformBody.scope === "platform" && platformBody.results?.length === 5 && platformBody.results.every((r) => r.ok === true),
      JSON.stringify(platformBody.results?.map((r) => `${r.workspace}:${r.ok ?? r.error}`)),
    );
    ok("  and not the held one", !platformBody.results?.some((r) => r.workspace === "zzfan-held"));
    const one = await call(marketing, `zzfan-b.${domain}${port}`, process.env.MARKETING_TICK_SECRET!);
    const oneBody = (await one.json()) as { ok?: boolean; scope?: string };
    ok("on a workspace's address: that workspace alone, answered as before", one.status === 200 && oneBody.ok === true && oneBody.scope === undefined);
    const held = await call(marketing, `zzfan-held.${domain}${port}`, process.env.MARKETING_TICK_SECRET!);
    ok("  a held workspace runs nothing", held.status === 404);
    const backups = await call(backup, `admin.${domain}${port}`, process.env.BACKUP_TICK_SECRET!);
    const backupBody = (await backups.json()) as { results?: { ran?: boolean }[] };
    ok("the backup tick fans out the same way — each on its own schedule, none due here", backups.status === 200 && backupBody.results?.length === 5 && backupBody.results.every((r) => r.ran === false));
    ok("  and the marketing secret does not open it", (await call(backup, `admin.${domain}${port}`, process.env.MARKETING_TICK_SECRET!)).status === 401);

    section("Terminals reach their own workspace");
    const SERIAL = "ZZFAN0001";
    const claimA = await runAsTenant(A, () => routes.claimDeviceSerial(SERIAL.toLowerCase()));
    ok("a serial is claimed by the workspace registering it", claimA.ok);
    const claimB = await runAsTenant(B, () => routes.claimDeviceSerial(SERIAL));
    ok("  and refused to another", !claimB.ok && /another workspace/.test(claimB.error), claimB.ok ? "claimed" : claimB.error);
    ok("  claiming it again is no change", (await runAsTenant(A, () => routes.claimDeviceSerial(SERIAL))).ok);
    ok("its route leads to its workspace, however it is typed", (await routes.tenantForDeviceSerial(" zzfan0001 "))?.id === idA);

    const workspaceA = new PrismaClient({ datasourceUrl: urls.a });
    const workspaceB = new PrismaClient({ datasourceUrl: urls.b });
    try {
      await workspaceA.biometricDevice.create({ data: { serialNumber: SERIAL, name: "ZZ Front door" } });
      // The same serial registered in B's own database too — only the route says whose it is.
      await workspaceB.biometricDevice.create({ data: { serialNumber: SERIAL, name: "ZZ Impostor" } });
      const iclock = require("../src/app/api/biometric/iclock/[[...path]]/route") as typeof import("../src/app/api/biometric/iclock/[[...path]]/route");
      const bareIp = "10.20.30.40:3000";
      const device = (path: string, query: string, init: RequestInit & { host: string }) =>
        new Request(`http://${init.host}/iclock/${path}?${query}`, { ...init, headers: { host: init.host } });
      const params = (path: string) => ({ params: Promise.resolve({ path: [path] }) });

      const hello = await iclock.GET(device("cdata", `SN=${SERIAL}&options=all`, { host: bareIp }), params("cdata"));
      ok("a terminal on a bare IP is answered, by its serial", hello.status === 200 && (await hello.text()).startsWith(`GET OPTION FROM: ${SERIAL}`));
      const body = `7\t2026-09-26 09:05:00\t0\t1\t0\t0\t0\t0`;
      const punch = await iclock.POST(device("cdata", `SN=${SERIAL}&table=ATTLOG`, { host: bareIp, method: "POST", body }), params("cdata"));
      ok("  its punch is accepted", punch.status === 200, punch.status);
      const [inA, inB] = await Promise.all([workspaceA.biometricPunch.count(), workspaceB.biometricPunch.count()]);
      ok("  and lands in the workspace its serial belongs to, and nowhere else", inA === 1 && inB === 0, `${inA} in A, ${inB} in B`);
      const onHost = await iclock.GET(device("cdata", `SN=${SERIAL}`, { host: `zzfan-b.${domain}${port}` }), params("cdata"));
      ok("on a workspace's own address, that workspace decides — B has it registered too", onHost.status === 200);
      const stranger = await iclock.GET(device("cdata", "SN=ZZFANNOBODY", { host: bareIp }), params("cdata"));
      ok("an unknown serial on a bare IP is refused", stranger.status === 401);

      await runAsTenant(A, () => routes.releaseDeviceSerial(SERIAL));
      ok("a released serial leads nowhere", (await routes.tenantForDeviceSerial(SERIAL)) === null);
      await control.biometricDeviceRoute.create({ data: { serial: SERIAL, tenantId: idHeld } });
      const toHeld = await iclock.GET(device("cdata", `SN=${SERIAL}`, { host: bareIp }), params("cdata"));
      ok("a terminal of a held workspace is turned away", toHeld.status === 503);
    } finally {
      await workspaceA.$disconnect();
      await workspaceB.$disconnect();
    }
  } finally {
    if (cleanup) await cleanup().catch(() => {});
    for (const name of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname in (${names.control}, ${names.a}, ${names.b})`;
    ok("the scratch databases are dropped", Number(left[0].n) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? "\nAll fan-out checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
