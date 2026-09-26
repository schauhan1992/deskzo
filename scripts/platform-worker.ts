/**
 * The platform worker: sets new workspaces up, and keeps databases ready for the next ones.
 *
 *   npm run platform:worker              keep going — under pm2 or systemd in production
 *   npm run platform:worker -- --once    do what is due now, then stop
 *
 * Takes provisioning jobs as they arrive (src/lib/platform/provisioning.ts), one at a time per
 * worker; several workers can run, and SKIP LOCKED gives each job to exactly one. Between jobs it
 * keeps the warm pool topped up (PLATFORM_WARM_POOL, default 2), under a lease so two workers do
 * not both make the same database.
 *
 * The signup form also starts one with --once as it queues a job, so a signup completes even where
 * nobody has set a worker up yet — the long-running one simply finds nothing left to do.
 */
import "dotenv/config";
import { closeControlDb } from "../src/lib/platform/control-db";
import { withPlatformLease } from "../src/lib/platform/fanout";
import { fillWarmPool, runNextJob } from "../src/lib/platform/provisioning";
import { installLogLabels } from "../src/lib/tenancy/log-labels";

// Each line it writes names the workspace it was working on.
installLogLabels();

const once = process.argv.includes("--once");
const POLL_MS = 2_000;
const POOL_EVERY_MS = 60_000;

async function drainJobs(): Promise<number> {
  let done = 0;
  for (;;) {
    const result = await runNextJob();
    if (!result) return done;
    done += 1;
    console.log(`[worker] job ${result.jobId}: ${result.ok ? "done" : `failed — ${result.error}`}`);
  }
}

async function topUpPool(): Promise<void> {
  const outcome = await withPlatformLease("warm-pool", 30 * 60_000, () => fillWarmPool()).catch((err) => {
    console.error("[worker] the warm pool could not be topped up", err);
    return { ran: false as const };
  });
  if (outcome.ran && (outcome.value.made || outcome.value.migrated)) {
    console.log(`[worker] warm pool: ${outcome.value.made} made, ${outcome.value.migrated} brought up to date`);
  }
}

async function main() {
  if (once) {
    await drainJobs();
    await topUpPool();
    return;
  }
  console.log("[worker] running — provisioning jobs and the warm pool");
  let lastPool = 0;
  for (;;) {
    await drainJobs().catch((err) => console.error("[worker] taking jobs failed", err));
    if (Date.now() - lastPool > POOL_EVERY_MS) {
      await topUpPool();
      lastPool = Date.now();
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
