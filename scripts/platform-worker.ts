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
 *
 * And, while it keeps going, the off-site work (src/lib/offsite/chores.ts): backups copied off the
 * server every hour, the control plane dumped and the logs archived every night, a restore drill every
 * week. Beside the rest, never in its way — a sync takes minutes, the provisioning jobs can't wait for
 * it. Not with --once: the signup form starts one of those, and a signup isn't the moment to copy
 * backups (`npm run offsite` runs them by hand).
 */
import "dotenv/config";
import { closeControlDb } from "../src/lib/platform/control-db";
import { withPlatformLease } from "../src/lib/platform/fanout";
import { fillWarmPool, runNextJob } from "../src/lib/platform/provisioning";
import { installLogLabels } from "../src/lib/tenancy/log-labels";
import { runAutomate } from "../src/lib/automate/worker";
import { runDueChores } from "../src/lib/offsite/chores";

// Each line it writes names the workspace it was working on.
installLogLabels();

const once = process.argv.includes("--once");
const POLL_MS = 2_000;
const POOL_EVERY_MS = 60_000;
const AUTOMATE_SWEEP_EVERY_MS = 10 * 60_000;
const OFFSITE_EVERY_MS = 30_000;

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

let offsite: Promise<void> | null = null;
let offsiteFailure = { message: "", at: 0 };

/** Starts the off-site chores that are due, unless the last lot is still going. Never awaited by the loop. */
function offsiteTurn(): void {
  if (offsite) return;
  offsite = runDueChores()
    .then((outcomes) => {
      for (const o of outcomes) {
        if (o.ran) console.log(`[worker] off-site ${o.chore}: ${o.ok ? o.summary : `failed — ${o.summary} ${o.error ?? ""}`.trim()}`);
      }
    })
    .catch((err: unknown) => {
      // The same failure every 30 seconds (the release's migration not run yet, say) is said once an hour.
      const message = err instanceof Error ? err.message : String(err);
      if (message !== offsiteFailure.message || Date.now() - offsiteFailure.at > 3_600_000) {
        console.error("[worker] the off-site work could not start", err);
        offsiteFailure = { message, at: Date.now() };
      }
    })
    .finally(() => {
      offsite = null;
    });
}

async function main() {
  if (once) {
    await drainJobs();
    await topUpPool();
    await automate(true);
    return;
  }
  console.log("[worker] running — provisioning jobs, the warm pool, workflows and off-site backups");
  let lastPool = 0;
  let lastSweep = 0;
  let lastOffsite = 0;
  for (;;) {
    if (Date.now() - lastOffsite > OFFSITE_EVERY_MS) {
      offsiteTurn();
      lastOffsite = Date.now();
    }
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
