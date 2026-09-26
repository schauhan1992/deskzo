# Load test — 200 workspaces

Run 2026-09-26 17:20 UTC by `npm run load:test` (scripts/load-test.ts).

## Setup

- 200 workspaces, each its own database: copies of one made and migrated as provisioning makes them (19 MB, 200 companies, its owner); copied in 16 s.
- Traffic spread as real traffic is: four requests in five to the busiest fifth of the workspaces, the rest to any.
- Each request: who the person is, what they may see, a page of companies, a count; one in ten also writes.
- 6000 requests per scenario, 32 at a time, after an untimed warm-up, one app process (the tenancy layer in src/lib/tenancy, as the server runs it), on 20 CPUs, Node v24.16.0.
- PostgreSQL 16.14, max_connections 100, on the same machine.

## Results

| Scenario | Settings | Requests | Per second | Latency ms (p50 / p95 / p99 / max) | Failed | Peak connections to workspaces (of the most allowed) | Pools (peak kept / peak evicted, finishing / opened) | Memory MB (start → peak) |
|---|---|---|---|---|---|---|---|---|
| defaults | 35 workspace pools per process, 2 connections each, closed after 30 s unused — as shipped | 6000 | 95 | 368.1 / 569.3 / 650.6 / 785 | 0 | 46 of 70 (62 in all) | 35 / 0 / 2764 | 138 → 332 |
| few kept | 10 pools, 2 connections each | 6000 | 83 | 435.7 / 575.3 / 651.7 / 776 | 0 | 33 of 20 (50 in all) | 30 / 0 / 3425 | 137 → 324 |
| more kept | 50 pools, 2 connections each | 6000 | 96 | 240.9 / 699.2 / 803.5 / 1012 | 9 (0.1%) | 78 of 100 (95 in all) | 50 / 0 / 1847 | 138 → 450 |

Failures:

- more kept: 9 × remaining connection slots


## What it shows

- **Requests failed** in "more kept" (9) — see the failures above.
- **Connections follow the work, not the workspaces.** Peak connections to workspace databases, against the most the settings allow one process (pools kept × connections each): 46 of 70 for "defaults", 33 of 20 for "few kept", 78 of 100 for "more kept". An evicted pool is ended as soon as its last query ends (at most 0 evicted and still finishing at any moment; 0 left open once the work stopped), and a connection unused for TENANCY_IDLE_CONNECTION_S is closed. Above the most allowed only where every kept pool was busy at once: the cap gives way rather than end a pool with work on it, by at most the requests running (32 here).
- **Reopening is cheap.** Pools opened per 100 requests: 46.1 for "defaults", 57.1 for "few kept", 30.8 for "more kept". A workspace's first query on a new pool took 12 ms — of which the process's thread was busy 2.8 ms, the rest waiting on the server for a connection — against 1.4 ms on a warm one (median, measured alone); the fastest here at p95 was "defaults" (569.3 ms).
- **The process's thread.** Busy 100% of the time for "defaults", 100% of the time for "few kept", 100% of the time for "more kept", with timers up to 113 ms late. Opening pools, at their measured busy time, accounts for 12% of the run for "defaults", 12% of the run for "few kept", 8% of the run for "more kept"; the rest is compiling and answering the queries themselves.
- **Memory:** about 6.2 MB per open pool at most (the peak's growth over the pools open at the peak, evicted ones included).

## Found by this test

Three faults in how workspaces reached their databases, all found at 200 workspaces on 2026-09-26 and fixed in src/lib/tenancy/clients.ts:

1. **Evicted clients lingered.** An evicted client was closed two minutes later, whatever it was doing; with more busy workspaces than clients kept, thousands sat open at once with their connections and engines. The first run failed 98% of its requests ("remaining connection slots are reserved") and reached 14–20 GB. Now what is retired while work runs on it closes the moment that work ends, and a connection unused for half a minute closes.
2. **Busy clients were evicted.** With more workspaces in flight than clients kept, the least recently used client was often one a request was still using, and its next query opened a second client for the same workspace. The second run opened 9,379 clients for 6,000 requests, at 15 requests a second. Now eviction skips one with work running on it, and the process goes over the cap — by at most the work running at once — until it finishes.
3. **A client per workspace was the wrong unit.** With both fixed, the process still spent nearly all its time opening clients: each Prisma client parsed the whole schema on the process's one thread, about 45 ms during which every other request waited, and held about 29 MB — 57 requests a second at the defaults. Now one Prisma client serves every workspace (the Rust-free engine, through Prisma's pg driver adapter) and routes each query to its workspace's own pool; a workspace costs a pool. Sharing one client needed a guard: Prisma merges same-shaped lookups made in the same tick into one query, which would have answered one workspace from another's database — that merging is confined to one transaction's queries, and check:hardening proves the two workspaces apart.

This report is from the run after all three.

## Recommendations for production

1. TENANCY_MAX_CLIENTS is now pools kept, and pools are cheap to reopen: size it by connections (below), not by memory.
2. With more than one app process, routing each workspace to the same process (by host, at the load balancer) keeps its pool warm — useful, no longer essential.
3. Run PgBouncer in transaction mode in front of the workspace databases and set TENANCY_POOLER_URL (docs/runbook.md). Without it, keep TENANCY_MAX_CLIENTS × TENANCY_CONNECTION_LIMIT × app processes under about 70% of max_connections — or accept that the product is a worst case the idle timeout keeps you from.
4. Raise max_connections only with the memory to back it: every connection is a Postgres process.
5. Keep each workspace role's own cap (TENANCY_ROLE_CONNECTION_LIMIT, 20) so one busy workspace cannot take the server's connections from the rest.
6. Re-run this after changing any of those, and before a large onboarding.

Not covered here: the HTTP layer and page rendering (Next's own cost, the same with one workspace or many); PgBouncer itself (none on this machine); many app processes at once.
