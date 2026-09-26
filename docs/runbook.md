# Wroffy ERP — operations and recovery runbook

For whoever runs the platform: what runs where, what to back up, how to release, and what to do when something breaks. Kept with the code so it changes with it.

## 1. What runs

| Part | What it is | How it runs |
|---|---|---|
| App server | `npm run build` then `npm start` — every workspace, the public site (`www.`) and the staff console (`admin.`) | Behind a reverse proxy doing TLS, with `TRUST_PROXY=1`; `NODE_ENV=production` |
| Platform worker | `npm run platform:worker` — sets new workspaces up, keeps the warm pool full | Long-lived under pm2 or systemd; restarts on failure |
| Schedulers | Plain HTTPS calls with a bearer secret | cron / systemd timers (below) |
| PostgreSQL 16 | One database per workspace, plus the control plane and the reference database | With continuous archiving (point-in-time recovery) |
| PgBouncer | Pools the app's connections to workspace databases | Transaction mode (§7) |

### Scheduled calls

| Every | Call | Secret |
|---|---|---|
| 5 minutes | `GET https://admin.<domain>/api/marketing/tick` — campaigns, lead scores, sales wins, for every workspace | `MARKETING_TICK_SECRET` |
| 15 minutes | `GET https://admin.<domain>/api/backup/tick` — each workspace's scheduled backups | `BACKUP_TICK_SECRET` |
| hour | `GET https://admin.<domain>/api/platform/tick` — trials, grace periods, billing holds, reminders; once a day the gateways read back and each workspace's use recorded | `PLATFORM_TICK_SECRET` |

Each with `Authorization: Bearer <secret>`. Unset, an endpoint refuses everything. A non-200 answer means some workspace failed — the body says which.

## 2. Configuration

Set in the server's environment (pm2 ecosystem file or systemd unit), never in the repository.

| Setting | Required | What |
|---|---|---|
| `DATABASE_URL` | yes | The installation's first workspace's database, and the server the provisioner uses in development |
| `CONTROL_DATABASE_URL` | yes | The control plane: workspaces, plans, billing, staff |
| `REFERENCE_DATABASE_URL` | yes | Shared reference data (PIN codes, world places) |
| `PLATFORM_MASTER_KEY` | yes — **back it up (§4)** | Seals every workspace's database address and key bundle, and the platform's secrets |
| `AUTH_SECRET` | yes | Kept for the first workspace's older sessions and links |
| `PLATFORM_DOMAIN`, `PLATFORM_PORT` | yes / no | Workspaces are `<slug>.<domain>`; `admin.` is the console, `www.` the public site |
| `TRUST_PROXY` | yes, `1` behind the proxy | Believe the proxy's forwarded host and address — and nothing else's. Without it no caller's address is known: IP rules match nobody, lockouts are per account only, and the activity log records no address |
| `TRUST_PROXY_HOPS` | with a chain of proxies (1) | How many proxies of ours append to X-Forwarded-For — 2 for a CDN in front of nginx; the caller is that many entries from the end |
| `PLATFORM_PROVISIONER_URL` | yes | A role with CREATEDB and CREATEROLE, on the maintenance database |
| `PLATFORM_WARM_POOL` | no (2) | Databases made ahead of signups |
| `PLATFORM_SMTP_URL`, `PLATFORM_MAIL_FROM` | yes | The platform's own mail (signup codes, billing reminders); unset, mail is written to `platform-outbox/` |
| `PLATFORM_CONSOLE_IP_ALLOWLIST` | recommended | CIDRs allowed to reach the console (needs `TRUST_PROXY=1`) |
| `MARKETING_TICK_SECRET`, `BACKUP_TICK_SECRET`, `PLATFORM_TICK_SECRET` | yes | §1 |
| `TENANCY_POOLER_URL` | yes with PgBouncer | e.g. `postgresql://127.0.0.1:6432` — the app's workspace queries go there |
| `TENANCY_MAX_CLIENTS` (35), `TENANCY_CONNECTION_LIMIT` (2), `TENANCY_IDLE_CONNECTION_S` (30) | tune | Workspace pools kept per process, connections each, and how long an unused connection stays open (§7) |
| `TENANCY_STATEMENT_TIMEOUT_MS` (30000), `TENANCY_LOCK_TIMEOUT_MS` (10000), `TENANCY_IDLE_IN_TRANSACTION_MS` (60000), `TENANCY_ROLE_CONNECTION_LIMIT` (20) | tune | Each workspace role's limits; after changing, `npm run platform:tenant -- limits` |
| `BACKUP_DIR` | no (`backups/`) | Where workspace backups are written; each workspace under `workspaces/<id>/` |
| `PDF_BROWSER_PATH`, `PDF_BROWSER_NO_SANDBOX` | for PDFs | A Chromium for printing documents |
| `ENABLE_DATA_RESET` | **never in production** | The temporary "reset all data" button — remove the button before launch (§8) |

The gateways' keys (Stripe, Razorpay) are **not** environment settings: an owner enters them in the console, under Billing, where they are sealed and never shown back.

## 3. Releasing

1. **Migrations first, code second.** Migrations are written expand-then-contract, so the running code keeps working on the new schema.
2. `npm run tenants:migrate` — the control plane, the reference database, the warm pool, then the first workspace (the canary), then the rest eight at a time. It stops for the rest if the canary fails.
3. A workspace whose migration fails is held at MIGRATING — its users see the maintenance page, its data is untouched. Console → Migrations shows why; fix, then **Retry** there.
4. Deploy the build; restart the app and the worker.
5. `npm run check:tenancy`, `check:module-guards` and the suites for what changed run before every release; `npm run pentest` before any release touching sign-in, tenancy or billing (§9).

Migrations lift a workspace role's time limits while they run and put them back after — a long backfill is not cut off at thirty seconds.

## 4. What to back up

| What | Why | How |
|---|---|---|
| `PLATFORM_MASTER_KEY` | Without it no workspace's database address or keys can be opened — every workspace, and every backup of one, is unreadable. | Offline, in two places (a password manager with a break-glass entry and a sealed paper copy). Never with the database backups. |
| The control plane | Holds every workspace's sealed address and key bundle, plans, subscriptions, staff. Losing it loses the keys to every workspace's backups. | Point-in-time recovery with the cluster, **and** a nightly `pg_dump` kept 30 days off the server. |
| Workspace databases | The customers' data. | Cluster point-in-time recovery (base backup + WAL archive), plus each workspace's own scheduled backups in `BACKUP_DIR` (sealed, per workspace), copied off the server. |
| `BACKUP_DIR` | The per-workspace archives a customer or staff restore from. | Synced off-site nightly. |
| The reference database | Shared PIN and place data. | Re-loadable from source (`db:reference`, `db:geonames`); a dump is quicker. |

Test a restore every quarter (§5.1 and §5.2) and write down how long it took.

## 5. Recovering

### 5.1 One workspace's data damaged (a bad import, a mistaken deletion)

1. Hold it: console → the workspace → Hold, with the reason.
2. Restore its latest good backup: its owner from Settings → Backups, or staff for an archive that is not platform-signed. For a point between backups, restore the cluster to that time on a spare server and copy that one database back.
3. Reopen it; tell the owner what was lost between the backup and the damage.

### 5.2 The database server lost

1. Stand up PostgreSQL 16; restore the cluster from the base backup and WAL to the latest point.
2. Check the control plane opens and lists every workspace: `npm run platform:tenant -- list`.
3. Start PgBouncer, the app, the worker; run the ticks once by hand.
4. `npm run check:tenancy`; sign in to two workspaces and the console.

### 5.3 The control plane lost, workspace databases intact

Restore it from its nightly dump or the cluster's recovery — it is the only record of each workspace's keys. Without either, the first workspace can be adopted again (`npm run platform:adopt`), but **no other workspace can be recovered**: their keys are gone. This is why §4 keeps the control plane in two places.

### 5.4 `PLATFORM_MASTER_KEY` lost

Nothing sealed can be opened. Restore it from its offline copies (§4). There is no other way back.

### 5.5 Setting up a workspace failed

Console → Provisioning shows the step and the error; **Try again** after fixing it (usually the provisioner's credentials or disk). The signup's owner is waiting on the progress page, which picks it up.

### 5.6 Billing webhooks failing

Console → Billing → "What the gateways said" shows each failure; the gateway retries for days. Check the webhook secret matches the gateway's dashboard. The daily reconcile reads every subscription back regardless, so nothing is lost if a webhook never arrives.

### 5.7 Staff locked out of the console

- A lost password: `npm run platform:staff -- link <email>` prints a new one-time link.
- A lost phone: `npm run platform:staff -- reset-2fa <email>`.
- No owner can get in at all: from the server, `npm run platform:staff -- reset-2fa <owner's email>` — they set up a new authenticator at their next sign-in. `two-factor off` lets everyone in on a password alone; if you use it to get in, put `two-factor required` back straight after.

### 5.8 A workspace overloading the server

Each workspace's role has its own limits: a statement stops at thirty seconds, a lock wait at ten, an idle transaction at a minute, and it opens at most twenty connections. If one workspace still crowds the others, hold it from the console and talk to its owner.

### 5.9 Suspected exposure of one workspace's data to another

1. Hold the workspaces involved (console → Hold, reason "security incident").
2. Preserve the logs: every line names its workspace (`[slug] …`), so the relevant lines can be extracted per workspace.
3. Establish scope: which records, which people, which window.
4. The customers are the controllers of their data: notify each affected workspace's owner without undue delay, and within the time the DPA promises (docs/privacy/data-processing-agreement.md), so they can meet their own duties under GDPR and the DPDP Act.
5. Fix, add a probe for it to `scripts/pentest.ts`, reopen.

## 6. Everyday operations from the server

| Task | Command |
|---|---|
| List workspaces | `npm run platform:tenant -- list` |
| Hold, reopen, close, purge | `npm run platform:tenant -- suspend <slug> --reason …` / `resume` / `deprovision` / `purge` |
| A workspace's plans; what it may use | `npm run platform:tenant -- plans <slug> <plan>[:qty] …` / `entitlements <slug>` |
| Re-apply every workspace role's limits | `npm run platform:tenant -- limits` |
| Invitations | `npm run platform:tenant -- invite [--plan <key>]` |
| Staff | `npm run platform:staff -- list / create / link / role / reset-2fa / deactivate / two-factor` |

## 7. Capacity: connections and PgBouncer

The app reaches every workspace database through one Prisma client (the Rust-free engine, over Prisma's pg driver adapter), which sends each query to its workspace's own small pool of connections (src/lib/tenancy/clients.ts). A workspace costs a pool — a few milliseconds to open, most of them waiting on the server — not a copy of the schema.

Every app process keeps up to `TENANCY_MAX_CLIENTS` workspace pools, each opening up to `TENANCY_CONNECTION_LIMIT` connections — and Postgres allows `max_connections` for everything. An evicted pool is ended as soon as the work on it ends, and a connection unused for `TENANCY_IDLE_CONNECTION_S` closes too, so in practice connections follow the work in progress; the product of the two settings is the worst case, and the one to size against.

- **The engine works on one core.** The Rust-free client compiles each query on the process's own thread, where the old engine used threads of its own. Measured on 2026-09-26 (20-core machine, one busy workspace, 32 requests at a time): a process topped out at about 345 of the load test's requests a second against the old engine's 690, for slightly less CPU per request. So run several app processes (pm2 cluster mode, one per core or two) and keep `TENANCY_MAX_CLIENTS × TENANCY_CONNECTION_LIMIT × processes` within the connection budget — or put PgBouncer in front, below.
- With more than one app process, routing each workspace to the same process (hash on the host at the load balancer) keeps its pool warm — useful, not essential.
- A query outside any workspace is refused; so is starting at all if Prisma's internals change where the client expects them (see the top of clients.ts) — after upgrading Prisma, run `npm run check:hardening` before anything else.

Run PgBouncer in transaction mode, so the server sees a bounded pool however many workspaces are busy:

```ini
; /etc/pgbouncer/pgbouncer.ini
[databases]
; Any database, as the connecting workspace role — each workspace keeps its own pool.
* = host=127.0.0.1 port=5432 auth_user=pgbouncer

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
auth_type = scram-sha-256
auth_user = pgbouncer
auth_dbname = postgres
auth_query = SELECT usename, passwd FROM pgbouncer.user_lookup($1)
pool_mode = transaction
default_pool_size = 3
max_db_connections = 10
max_client_conn = 5000
ignore_startup_parameters = extra_float_digits
```

```sql
-- In the postgres database, as a superuser: PgBouncer looks workspace roles' passwords up, and only theirs.
CREATE ROLE pgbouncer LOGIN PASSWORD '<in its own secret store>';
CREATE SCHEMA pgbouncer AUTHORIZATION pgbouncer;
CREATE FUNCTION pgbouncer.user_lookup(p_user text, OUT usename text, OUT passwd text) RETURNS record
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS
  $$ SELECT rolname::text, rolpassword::text FROM pg_authid WHERE rolname = p_user AND rolname ~ '^w_[0-9a-f]{12}$' $$;
REVOKE ALL ON FUNCTION pgbouncer.user_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.user_lookup(text) TO pgbouncer;
```

The lookup only answers for provisioned workspace roles (`w_` and twelve hex characters). A workspace adopted from the single install (tenant #1) keeps its original role: widen the pattern to name that role too, or list it in PgBouncer's `auth_file` — otherwise it cannot sign in through PgBouncer.

Then set `TENANCY_POOLER_URL=postgresql://127.0.0.1:6432`. Only the app's queries go through it; migrations, backups and provisioning keep connecting directly. Without PgBouncer, keep `TENANCY_MAX_CLIENTS × TENANCY_CONNECTION_LIMIT × app processes` under about 70% of `max_connections`. Re-run `npm run load:test` after any of these change.

## 8. Before the first paying customer

- [ ] `NODE_ENV=production`, TLS at the proxy, `TRUST_PROXY=1`.
- [ ] Remove the temporary "reset all data" button (Settings → Backups) and its code; `ENABLE_DATA_RESET` unset.
- [ ] `PLATFORM_MASTER_KEY` backed up offline, twice (§4). The control plane dumped nightly, off the server.
- [ ] Staff two-factor **required** (console → Staff); `PLATFORM_CONSOLE_IP_ALLOWLIST` set.
- [ ] PgBouncer in front of workspace databases (§7); the three schedulers running (§1); the worker under pm2.
- [ ] Gateways: live keys entered, webhooks set, one test-mode checkout run end to end first (docs: billing is proven only against fakes so far).
- [ ] `PLATFORM_SMTP_URL` set; a signup code and a billing reminder received.
- [ ] Privacy documents reviewed by counsel and published (docs/privacy).
- [ ] `npm run pentest` and `npm run load:test` on the production-like server; reports kept.

## 9. Regular checks

| When | What |
|---|---|
| Every release | The check suites; `npm run pentest` for anything touching sign-in, tenancy or billing |
| After changing capacity settings, and before a large onboarding | `npm run load:test` |
| Quarterly | A restore of one workspace and of the control plane, timed (§4) |
| Monthly | Console → Billing: failed webhooks; console → Migrations: anything behind; console → Provisioning: anything failed |
