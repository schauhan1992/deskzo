# Load test — Deskzo Automate

Run 2026-10-18 05:25 UTC by `npm run load:automate` (scripts/load-automate.ts), on 20 CPUs, Node v24.16.0, one process running both the load and the platform worker's loop.

## The target

The plan's acceptance for Phase 8: the run backlog stays under a minute at 10× the busiest pilot's volume. There is no pilot yet, so the stand-in agreed on 18 Oct 2026 is the target: **50 workflows and 20,000 steps a day in each workspace, 10 workspaces at once**.

## Setup

- 10 workspaces, each its own database (copies of one migrated as provisioning makes it), each with an owner and 50 workflows: 30 started by a task being made (each listening for its own title), 15 hourly schedules (all due at the start), 5 started by hand (one every 10 seconds). Every run is a condition and two notifications — 2 steps.
- **Steady:** 2 steps a second in every workspace for 3 minutes — 1,72,800 a day each, **8.6× the target** — 3,418 steps in all.
- **Burst:** 1,000 tasks made at once in each of 3 workspaces (an import), 6,000 steps.
- The worker: `runAutomate()` then a second's pause, as scripts/platform-worker.ts runs it — four workspaces at a time, five runs at once in each, following the wake list.

## Results

| | Runs | Waited before a worker took it up (p50 / p95 / max) | Event to finished (p50 / p95 / max) | Oldest work due, at worst | Verdict |
|---|---|---|---|---|---|
| Steady | 1709 | 4.4 / 12.6 / 17.9 s | 5.0 / 13.2 / 18.7 s | 16.6 s | under a minute |
| Burst | 3000 | 150.1 / 216.4 / 226.2 s | 150.3 / 216.9 / 226.5 s | 126.6 s | OVER a minute |

- Runs in all: 5,173 (0 failed); steps done: 10,346. Left undone when the test stopped: 0 after the steady load, 0 after the burst.
- The burst's 3,000 tasks took 12.3 s to make, and everything was done 239.3 s after the first.
- Worker passes: 44. Connections to the workspaces' databases, at most: 31. Memory: 343 → 531 MB. Event loop delay p99: 34 ms.
- Steady phase 05:26:21–05:29:22 UTC; burst 05:29:26–05:33:25 UTC.

## What it shows

- **The plan's acceptance holds.** At 8.6× the stand-in target, in ten workspaces at once, nothing waited more than 18 seconds for a worker, and the oldest work due was never more than 17 seconds old. The backlog stays well under a minute.
- **An import is a different matter.** A thousand records arriving at once in one workspace — a CSV of leads, say, each starting a workflow — took about four minutes to work through, and the last runs waited nearly that long. It never failed and nothing was lost; it was only slow.
- **Why.** A run here takes about 450 ms from start to finish, of which its two steps are about 90 ms (43 ms each, p95 79 ms). The rest is the engine's own bookkeeping per run: reading and decrypting its context, a checkpoint after each step, counting the step against the plan, recording each step. And a workspace's runs are carried out one after another: the worker claims five at a time, but advances them in turn, so a workspace finishes about 4 runs a second, and three busy workspaces about 12.5 between them.
- **What would make imports quicker,** in order of effect: advancing a workspace's five claimed runs together instead of in turn (the database already allows it — five is the limit the engine names); then trimming the per-run bookkeeping (one checkpoint per turn instead of per step, the plan's limits read once per turn). Neither is needed for the acceptance above.
- **Connections and memory** stayed modest: at most 31 connections to the ten workspaces' databases, and the process grew from 343 to 531 MB while working through 5,173 runs. The event loop's p99 delay was 34 ms.
