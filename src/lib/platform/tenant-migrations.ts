import { randomUUID } from "node:crypto";
import { controlDb } from "@/lib/platform/control-db";
import { forEachTenant, withPlatformLease } from "@/lib/platform/fanout";
import { openForPlatform } from "@/lib/platform/kek";
import { latestMigrationName, migrateDeploy } from "@/lib/platform/migrate";
import { activeTenants, forgetRegistry, tenantById } from "@/lib/tenancy/registry";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Bringing every database up to this version of the code — `npm run tenants:migrate`, before the new
 * code is deployed. Migrations are written expand-then-contract, so the old code keeps running on a
 * migrated database while this goes round.
 *
 * In this order, stopping at the first thing that fails before the workspaces:
 *
 *   1. the control plane and the shared reference database;
 *   2. the warm pool — databases waiting for a signup;
 *   3. the canary: the first workspace (the platform's own). If it fails, nobody else is touched;
 *   4. every other workspace, eight at a time.
 *
 * Each database's run is recorded (TenantMigrationRun). A workspace whose migration fails is held
 * (MIGRATING — the proxy shows a maintenance page) until a later run brings it through; one already
 * held is retried by every run. A workspace that succeeds is marked current.
 *
 * `only` names workspaces by slug — one, or a list — and a run then covers just those of them it
 * would have covered anyway, skipping steps 1–2. Given but naming none (an empty list or string), it
 * migrates nothing — it is never read as "everything".
 */

export type MigrationSummary = {
  runId: string;
  version: string | null;
  platform: { target: string; ok: boolean; error?: string }[];
  workspaces: { slug: string; ok: boolean | "skipped"; error?: string }[];
  stoppedAt: string | null;
};

const tail = (text: string) => text.trim().split("\n").slice(-12).join("\n").slice(0, 4000);

async function recorded(runId: string, target: string, tenant: Tenant | null, fromVersion: string | null, run: () => Promise<string>) {
  const control = controlDb();
  const row = await control.tenantMigrationRun.create({
    data: { runId, target, tenantId: tenant?.source === "control" ? tenant.id : null, fromVersion, toVersion: latestMigrationName() },
  });
  try {
    const output = await run();
    await control.tenantMigrationRun.update({ where: { id: row.id }, data: { ok: true, finishedAt: new Date(), output: tail(output) } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await control.tenantMigrationRun.update({ where: { id: row.id }, data: { ok: false, finishedAt: new Date(), output: tail(message) } });
    throw err;
  }
}

async function migrateWorkspace(runId: string, tenant: Tenant): Promise<void> {
  const control = controlDb();
  const before = tenant.source === "control" ? await control.tenant.findUnique({ where: { id: tenant.id }, select: { schemaVersion: true } }) : null;
  try {
    await recorded(runId, tenant.slug, tenant, before?.schemaVersion ?? null, () => migrateDeploy(tenant.dbUrl));
    if (tenant.source === "control") {
      await control.tenant.update({ where: { id: tenant.id }, data: { schemaVersion: latestMigrationName(), ...(tenant.status === "MIGRATING" ? { status: "ACTIVE" } : {}) } });
    }
  } catch (err) {
    if (tenant.source === "control") {
      await control.tenant.update({ where: { id: tenant.id }, data: { status: "MIGRATING" } });
      await control.platformAuditLog.create({
        data: { actorKind: "SCRIPT", actor: "tenants:migrate", action: "tenant.migration.failed", tenantId: tenant.id, detail: { runId } },
      });
    }
    throw err;
  }
}

/** The workspaces a run covers: every active one, and every one a failed run left held — of those named, when some are. */
async function runnable(only: ReadonlySet<string> | null): Promise<Tenant[]> {
  const held = await controlDb().tenant.findMany({ where: { status: "MIGRATING" }, select: { id: true } });
  const heldTenants = (await Promise.all(held.map((h) => tenantById(h.id)))).filter((t): t is Tenant => !!t);
  const all = [...(await activeTenants()), ...heldTenants.filter((t) => t.dbUrl)];
  return only ? all.filter((t) => only.has(t.slug)) : all;
}

/** The slugs `only` names — null when it is not given, which is every database. */
function namedSlugs(only: string | string[] | null | undefined): ReadonlySet<string> | null {
  if (only === null || only === undefined) return null;
  return new Set((Array.isArray(only) ? only : [only]).map((s) => String(s).trim()).filter(Boolean));
}

export async function migrateEverything(options: { only?: string | string[] | null; concurrency?: number; log?: (line: string) => void } = {}): Promise<MigrationSummary> {
  const log = options.log ?? (() => {});
  const only = namedSlugs(options.only);
  const runId = randomUUID();
  const summary: MigrationSummary = { runId, version: latestMigrationName(), platform: [], workspaces: [], stoppedAt: null };
  if (only?.size === 0) {
    log("  no workspace named: nothing to migrate");
    return summary;
  }
  const outcome = await withPlatformLease("migrate", 2 * 60 * 60_000, async () => {
    // 1–2. The platform's own databases and the warm pool — unless workspaces were named.
    if (!only) {
      const platform: { target: string; run: () => Promise<string> }[] = [
        { target: "control", run: () => migrateDeploy(process.env.CONTROL_DATABASE_URL!, "control") },
        ...(process.env.REFERENCE_DATABASE_URL ? [{ target: "reference", run: () => migrateDeploy(process.env.REFERENCE_DATABASE_URL!, "reference") }] : []),
      ];
      for (const warm of await controlDb().warmDatabase.findMany({ where: { claimedAt: null } })) {
        platform.push({
          target: `warm:${warm.dbName}`,
          run: async () => {
            const output = await migrateDeploy(openForPlatform("warm-db-url", warm.dbUrlCipher));
            await controlDb().warmDatabase.update({ where: { id: warm.id }, data: { schemaVersion: latestMigrationName() } });
            return output;
          },
        });
      }
      for (const p of platform) {
        log(`  ${p.target}…`);
        try {
          await recorded(runId, p.target, null, null, p.run);
          summary.platform.push({ target: p.target, ok: true });
        } catch (err) {
          summary.platform.push({ target: p.target, ok: false, error: err instanceof Error ? err.message : String(err) });
          summary.stoppedAt = p.target;
          return;
        }
      }
    }

    // 3–4. The canary, then everyone else.
    const tenants = await runnable(only);
    if (only) {
      const found = new Set(tenants.map((t) => t.slug));
      const absent = [...only].filter((slug) => !found.has(slug));
      if (absent.length) log(`  not open or held, so not migrated: ${absent.join(", ")}`);
    }
    const canaries = tenants.filter((t) => t.isDefault);
    const rest = tenants.filter((t) => !t.isDefault);
    for (const [group, list, concurrency] of [["canary", canaries, 1], ["workspaces", rest, options.concurrency ?? 8]] as const) {
      if (list.length === 0) continue;
      log(`  ${group === "canary" ? "the first workspace" : `${list.length} workspace(s)`}…`);
      const outcomes = await forEachTenant("migrate", list, (t) => migrateWorkspace(runId, t), { concurrency, timeoutMs: 30 * 60_000 });
      for (const o of outcomes) {
        summary.workspaces.push("skipped" in o ? { slug: o.slug, ok: "skipped" } : o.ok ? { slug: o.slug, ok: true } : { slug: o.slug, ok: false, error: o.error });
      }
      if (group === "canary" && outcomes.some((o) => "ok" in o && !o.ok)) {
        summary.stoppedAt = "canary";
        return;
      }
    }
  });
  forgetRegistry();
  if (!outcome.ran) throw new Error("Another migration run is in progress.");
  return summary;
}
