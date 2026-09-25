import { hostname } from "node:os";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { HOST_MISMATCH, classifyHost, requestHost } from "@/lib/tenancy/host";
import { activeTenants, tenantForKind } from "@/lib/tenancy/registry";
import { runAsTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Running a scheduled job for every workspace — the marketing heartbeat, the nightly backup.
 *
 * The app has no job runner: a scheduler outside it calls /api/marketing/tick and /api/backup/tick.
 * Called on a workspace's own address, a tick runs that workspace only — which is how the first
 * workspace's existing scheduler keeps working unchanged. Called on the platform's own address (the
 * bare domain, or admin.), it runs for every active workspace, through here:
 *
 *   · a few at a time (`concurrency`), so one tick cannot open a connection to every database at once;
 *   · each as its workspace (`runAsTenant`), so every query, cache and link is that workspace's;
 *   · each under a lease in the control plane, so the platform's fan-out and a workspace's own
 *     scheduler never run the same job for the same workspace at once — the second is skipped;
 *   · each with a time limit, after which it is reported failed and the next one starts. The work
 *     itself cannot be cancelled, so its lease is held until it really finishes;
 *   · each on its own: one workspace's failure is reported and the others carry on.
 */

export type JobOutcome<T> =
  | { tenantId: string; slug: string; ok: true; value: T; ms: number }
  | { tenantId: string; slug: string; ok: false; error: string; ms: number }
  | { tenantId: string; slug: string; skipped: "already-running" };

export type FanoutOptions = {
  /** How many workspaces at once. */
  concurrency?: number;
  /** How long one workspace's run may take before it is reported failed. */
  timeoutMs?: number;
};

const HOLDER = `${hostname()}:${process.pid}`;

class JobTimeout extends Error {}

/**
 * Takes the lease, or says somebody holds it. Without a control plane (an installation from before
 * workspaces, or a check suite) there is one scheduler per workspace and nothing to lease.
 */
async function takeLease(tenantId: string, job: string, holdMs: number): Promise<boolean> {
  if (!controlConfigured()) return true;
  const now = new Date();
  const until = new Date(now.getTime() + holdMs);
  // Inserted when new; otherwise taken over only once the last holder's lease has run out.
  const taken = await controlDb().$executeRaw`
    INSERT INTO "tenant_job_leases" ("tenantId", "job", "leasedUntil", "holder", "lastStartedAt")
    VALUES (${tenantId}, ${job}, ${until}, ${HOLDER}, ${now})
    ON CONFLICT ("tenantId", "job") DO UPDATE
      SET "leasedUntil" = EXCLUDED."leasedUntil", "holder" = EXCLUDED."holder", "lastStartedAt" = EXCLUDED."lastStartedAt"
      WHERE "tenant_job_leases"."leasedUntil" < ${now}`;
  return taken === 1;
}

async function releaseLease(tenantId: string, job: string, ok: boolean, error: string | null): Promise<void> {
  if (!controlConfigured()) return;
  const now = new Date();
  await controlDb()
    .tenantJobLease.updateMany({
      where: { tenantId, job, holder: HOLDER },
      data: { leasedUntil: now, lastFinishedAt: now, lastOk: ok, lastError: error ? error.slice(0, 500) : null },
    })
    .catch((err) => console.error(`[fanout] could not release ${job} for ${tenantId}`, err));
}

async function runOne<T>(job: string, tenant: Tenant, run: (tenant: Tenant) => Promise<T>, timeoutMs: number): Promise<JobOutcome<T>> {
  const base = { tenantId: tenant.id, slug: tenant.slug };
  // Held for twice the time limit: long enough to cover a run that overruns it, short enough that a
  // process killed mid-run does not keep the job from ever running again.
  if (!(await takeLease(tenant.id, job, timeoutMs * 2))) return { ...base, skipped: "already-running" };

  const started = Date.now();
  // Async, so a job that throws before its first await is a rejection like any other.
  const work = (async () => runAsTenant(tenant, () => run(tenant)))();
  // Released when the work really ends, whether or not the caller stopped waiting for it.
  work.then(
    () => releaseLease(tenant.id, job, true, null),
    (err: unknown) => releaseLease(tenant.id, job, false, err instanceof Error ? err.message : String(err)),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeout(`Still running after ${timeoutMs < 10_000 ? (timeoutMs / 1000).toFixed(1) : Math.round(timeoutMs / 1000)} s — left to finish on its own.`)), timeoutMs);
    timer.unref?.();
  });
  try {
    const value = await Promise.race([work, limit]);
    return { ...base, ok: true, value, ms: Date.now() - started };
  } catch (err) {
    console.error(`[fanout] ${job} failed for ${tenant.slug}`, err);
    return { ...base, ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function forEachTenant<T>(job: string, tenants: Tenant[], run: (tenant: Tenant) => Promise<T>, options: FanoutOptions = {}): Promise<JobOutcome<T>[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const outcomes: JobOutcome<T>[] = new Array(tenants.length);
  let next = 0;
  const lane = async () => {
    while (next < tenants.length) {
      const i = next++;
      outcomes[i] = await runOne(job, tenants[i], run, timeoutMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tenants.length) }, lane));
  return outcomes;
}

/**
 * Which workspaces a tick is for: the one whose address it was called on, or — on the platform's
 * own address — every active one. Anything else, none.
 */
export async function tickTargets(headers: Headers): Promise<{ scope: "workspace" | "platform"; tenants: Tenant[] }> {
  const host = requestHost(headers);
  if (!host || host === HOST_MISMATCH) return { scope: "platform", tenants: [] };
  const kind = classifyHost(host);
  const here = await tenantForKind(kind);
  if (here) return { scope: "workspace", tenants: here.status === "ACTIVE" ? [here] : [] };
  return { scope: "platform", tenants: kind.kind === "root" || kind.kind === "console" ? await activeTenants() : [] };
}
