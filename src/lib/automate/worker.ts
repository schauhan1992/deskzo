import { forEachTenant, releaseLease, takeLease, type JobOutcome } from "@/lib/platform/fanout";
import { activeTenants, tenantById } from "@/lib/tenancy/registry";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";
import { tenantAfter } from "@/lib/tenancy/after";
import { nextDueAt, workTenant, type TenantWork } from "@/lib/automate/engine";
import { platformPausedForWorker } from "@/lib/automate/switches";
import { dueWakes, settleWake } from "@/lib/automate/wake";
import { pruneSent } from "@/lib/automate/sent";

/**
 * Deskzo Automate's turn in the platform worker (scripts/platform-worker.ts), every couple of seconds:
 *
 *   · nothing at all while the platform's kill switch is off;
 *   · the workspaces on the wake list that are due — or, on a sweep (every ten minutes, and whenever
 *     there is no list to read), every active workspace, which catches a wake that was lost;
 *   · each under its own lease ("automate"), four at a time, a minute at most, its failure its own;
 *   · each one's wake settled to its next due time afterwards.
 *
 * A wake for a workspace that is gone or not active is cleared.
 */

const JOB = "automate";
const TENANT_TIMEOUT_MS = 60_000;

export type AutomateTurn = { paused: boolean; workspaces: number; outcomes: JobOutcome<TenantWork>[] };

async function workAndSettle(tenant: Tenant, readVersion: number | null, budgetMs: number): Promise<TenantWork> {
  const work = await workTenant({ budgetMs });
  // Being restored: looked at again in a minute, when the restore has likely finished.
  const next = work.skipped === "restoring" ? new Date(Date.now() + 60_000) : work.skipped ? null : await nextDueAt();
  await settleWake(tenant.id, readVersion, next);
  return work;
}

export async function runAutomate(options: { sweepAll?: boolean; budgetMs?: number } = {}): Promise<AutomateTurn> {
  if (await platformPausedForWorker()) return { paused: true, workspaces: 0, outcomes: [] };
  const due = options.sweepAll ? null : await dueWakes();
  let tenants: Tenant[];
  const versions = new Map<string, number>();
  if (due === null) {
    tenants = await activeTenants();
    // On a sweep: records of outside steps older than any run may live.
    await pruneSent().catch((err) => console.error("[automate] could not prune sent steps", err instanceof Error ? err.message : err));
  } else {
    tenants = [];
    for (const wake of due) {
      const tenant = await tenantById(wake.tenantId);
      if (tenant?.status === "ACTIVE") {
        tenants.push(tenant);
        versions.set(tenant.id, wake.version);
      } else {
        await settleWake(wake.tenantId, wake.version, null);
      }
    }
  }
  const budgetMs = options.budgetMs ?? 20_000;
  const outcomes = await forEachTenant(JOB, tenants, (tenant) => workAndSettle(tenant, versions.get(tenant.id) ?? null, budgetMs), { concurrency: 4, timeoutMs: TENANT_TIMEOUT_MS });
  return { paused: false, workspaces: tenants.length, outcomes };
}

/**
 * Start on this workspace's due work once the response has gone — so a run somebody just started
 * moves within a second rather than at the worker's next pass. Skipped when the worker holds the
 * workspace already; the worker remains the guarantee.
 */
export async function nudgeAutomate(): Promise<void> {
  await tenantAfter(async () => {
    if (await platformPausedForWorker()) return;
    const tenant = await currentTenant();
    if (!(await takeLease(tenant.id, JOB, TENANT_TIMEOUT_MS * 2))) return;
    let ok = true;
    let error: string | null = null;
    try {
      await workAndSettle(tenant, null, 8_000);
    } catch (err) {
      ok = false;
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await releaseLease(tenant.id, JOB, ok, error);
    }
  });
}
