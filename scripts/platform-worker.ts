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
 *
 * It also carries out Deskzo Automate's workflows (src/lib/automate/worker.ts): every pass, the
 * workspaces on the wake list that are due; every ten minutes, and with --once, every active one —
 * which catches a wake that was lost. A delay of minutes needs this to run as a long-lived process;
 * as a five-minute --once it still runs everything, just up to five minutes late.
 */
import "dotenv/config";
import { closeControlDb } from "../src/lib/platform/control-db";
import { withPlatformLease } from "../src/lib/platform/fanout";
import { fillWarmPool, runNextJob } from "../src/lib/platform/provisioning";
import { installLogLabels } from "../src/lib/tenancy/log-labels";
import { runAutomate } from "../src/lib/automate/worker";

// Each line it writes names the workspace it was working on.
installLogLabels();

const once = process.argv.includes("--once");
const POLL_MS = 2_000;
const POOL_EVERY_MS = 60_000;
const AUTOMATE_SWEEP_EVERY_MS = 10 * 60_000;

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

async function automate(sweepAll: boolean): Promise<void> {
  const turn = await runAutomate({ sweepAll }).catch((err) => {
    console.error("[worker] Automate's turn failed", err);
    return null;
  });
  if (!turn || turn.paused) return;
  for (const outcome of turn.outcomes) {
    if ("skipped" in outcome) continue;
    if (!outcome.ok) console.error(`[worker] automate ${outcome.slug}: ${outcome.error}`);
    else if (outcome.value.runs || outcome.value.turns) console.log(`[worker] automate ${outcome.slug}: ${outcome.value.runs} new run(s), ${outcome.value.turns} turn(s)`);
  }
}

async function main() {
  if (once) {
    await drainJobs();
    await topUpPool();
    await automate(true);
    return;
  }
  console.log("[worker] running — provisioning jobs, the warm pool and workflows");
  let lastPool = 0;
  let lastSweep = 0;
  for (;;) {
    await drainJobs().catch((err) => console.error("[worker] taking jobs failed", err));
    if (Date.now() - lastPool > POOL_EVERY_MS) {
      await topUpPool();
      lastPool = Date.now();
    }
    const sweep = Date.now() - lastSweep > AUTOMATE_SWEEP_EVERY_MS;
    await automate(sweep);
    if (sweep) lastSweep = Date.now();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
