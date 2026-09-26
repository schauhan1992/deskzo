# Load test — 200 workspaces

Run 2026-09-26 08:19 UTC by `npm run load:test` (scripts/load-test.ts).

## Setup

- 200 workspaces, each its own database: copies of one made and migrated as provisioning makes them (19 MB, 200 companies, its owner); copied in 19 s.
- Traffic spread as real traffic is: four requests in five to the busiest fifth of the workspaces, the rest to any.
- Each request: who the person is, what they may see, a page of companies, a count; one in ten also writes.
- 6000 requests per scenario, 32 at a time, one app process (the tenancy layer in src/lib/tenancy, as the server runs it), on 20 CPUs, Node v24.16.0.
- PostgreSQL 16.14, max_connections 100, on the same machine.

## Results

| Scenario | Settings | Requests | Per second | Latency ms (p50 / p95 / p99 / max) | Failed | Peak connections to workspaces (of the most allowed) | Clients (peak kept / peak evicted, finishing / opened) | Memory MB (start → peak) |
|---|---|---|---|---|---|---|---|---|
| defaults | 35 workspace clients per process, 2 connections each, closed after 30 s unused — as shipped | 6000 | 57 | 533.0 / 945.4 / 1155.9 / 1410 | 0 | 56 of 70 (70 in all) | 35 / 0 / 2639 | 223 → 1232 |
| more kept | 50 clients, 2 connections each | 6000 | 92 | 316.9 / 613.1 / 865.7 / 1772 | 0 | 80 of 100 (94 in all) | 50 / 0 / 1462 | 205 → 1292 |
| all kept | every workspace kept, 1 connection each, closed after 5 s unused | 6000 | 233 | 124.7 / 321.1 / 620.9 / 1615 | 1323 (22.1%) | 83 of 250 (97 in all) | 200 / 0 / 200 | 205 → 1867 |

Failures:

- all kept: 1283 × remaining connection slots
- all kept: 40 × too many clients


## What it shows

- **Requests failed** in "all kept" (1323) — see the failures above.
- **Connections follow the work, not the workspaces.** Peak connections to workspace databases, against the most the settings allow one process (clients kept × connections each): 56 of 70 for "defaults", 80 of 100 for "more kept", 83 of 250 for "all kept". An evicted client closes as soon as its last query ends (at most 0 evicted and still finishing at any moment; 0 left open once the work stopped), and a pool connection unused for TENANCY_IDLE_CONNECTION_S is closed.
- **Reopening is what costs.** Clients opened per 100 requests: 44.0 for "defaults", 24.4 for "more kept", 3.3 for "all kept". Each reopening is a new client — its engine, its copy of the schema, a connection — and its first query took 47 ms against 1.4 ms on a warm one (median, measured alone); the fastest here at p95 was "all kept" (321.1 ms). Keep TENANCY_MAX_CLIENTS above the number of workspaces busy at once.
- **Opening a client stops the process.** A client's first query parses the whole schema on the process's one thread, which was busy 100% of the time for "defaults", 100% of the time for "more kept", 100% of the time for "all kept", with timers up to 287 ms late. The opens alone, at their measured cost, account for about all of the run for "defaults", about all of the run for "more kept", 36% of the run for "all kept": while one opens, every other request waits.
- **Memory:** about 29 MB per open client at most (the peak's growth over the clients open at the peak, evicted ones included).

## Found by this test

Two faults in how workspace clients were kept, both found at 200 workspaces on 2026-09-26 and fixed in src/lib/tenancy/clients.ts:

1. **Evicted clients lingered.** An evicted client was closed two minutes later, whatever it was doing; with more busy workspaces than clients kept, thousands sat open at once with their connections and engines. The first run failed 98% of its requests ("remaining connection slots are reserved") and reached 14–20 GB. Now a client retired while work runs on it closes the moment that work ends (counted through `db`), a client handed out whole (getTenantDb) keeps the two-minute hold, and a pool connection unused for half a minute closes.
2. **Busy clients were evicted.** With more workspaces in flight than clients kept, the least recently used client was often one a request was still using, and its next query opened a second client for the same workspace. The second run opened 9,379 clients for 6,000 requests, at 15 requests a second. Now eviction skips a client with work running on it, and the process goes over the cap — by at most the queries running at once — until they finish.

This report is from the run after both fixes.

## Recommendations for production

1. Size TENANCY_MAX_CLIENTS to the workspaces busy on a process within a few minutes, so a client is rarely opened — reopening is what slows everything, and a kept client costs only memory (above).
2. Route each workspace to the same app process (by host, at the load balancer) once there is more than one: each process then keeps clients for its own share, not for every workspace.
3. Run PgBouncer in transaction mode in front of the workspace databases and set TENANCY_POOLER_URL (docs/runbook.md). Without it, keep TENANCY_MAX_CLIENTS × TENANCY_CONNECTION_LIMIT × app processes under about 70% of max_connections — or accept that the product is a worst case the idle timeout keeps you from.
4. Raise max_connections only with the memory to back it: every connection is a Postgres process.
5. Keep each workspace role's own cap (TENANCY_ROLE_CONNECTION_LIMIT, 20) so one busy workspace cannot take the server's connections from the rest.
6. Re-run this after changing any of those, and before a large onboarding.

The lasting fix for the cost of opening a client is one Prisma engine for every workspace, sending each query to its workspace's own small pool (Prisma's pg driver adapter): nothing to parse per workspace, a few kilobytes per pool. That needs a new dependency (@prisma/adapter-pg), so it is not made here.

Not covered here: the HTTP layer and page rendering (Next's own cost, the same with one workspace or many); PgBouncer itself (none on this machine); many app processes at once.
