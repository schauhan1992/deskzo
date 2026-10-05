# Deskzo One — operations and recovery runbook

For whoever runs the platform: what runs where, what to back up, how to release, and what to do when something breaks. Kept with the code so it changes with it.

## 1. What runs

| Part | What it is | How it runs |
|---|---|---|
| App server | `npm run build` then `npm start` — every workspace, the public site (`www.`), the staff console (`admin.`) and the website's CMS (`cms.`) | Behind a reverse proxy doing TLS, with `TRUST_PROXY=1`; `NODE_ENV=production` |
| Partner portal | `partners.<domain>` — resellers' and distributors' own portal (§12), with its own accounts; served by the same app server, from `src/app/platform-partners` | Nothing more to run: `partners.<domain>` in DNS and the proxy's certificate (§8) |
| Platform worker | `npm run platform:worker` — sets new workspaces up, keeps the warm pool full | Long-lived under pm2 or systemd; restarts on failure |
| Schedulers | Plain HTTPS calls with a bearer secret | cron / systemd timers (below) |
| PostgreSQL 16 | One database per workspace, plus the control plane and the reference database | With continuous archiving (point-in-time recovery) |
| PgBouncer | Pools the app's connections to workspace databases | Transaction mode (§7) |

On Coolify ([deploy-coolify.md](deploy-coolify.md)) the app is one container behind Coolify's Traefik, and the worker and the three calls below are Coolify Scheduled Tasks (`node deploy/scheduler.mjs once <name>`). With Docker Compose ([deploy-azure.md](deploy-azure.md)) each is a service in `deploy/azure/`, with Caddy as the reverse proxy. PgBouncer is not set up in either yet.

### Scheduled calls

| Every | Call | Secret |
|---|---|---|
| 5 minutes | `GET https://admin.<domain>/api/marketing/tick` — campaigns, lead scores, sales wins, for every workspace | `MARKETING_TICK_SECRET` |
| 15 minutes | `GET https://admin.<domain>/api/backup/tick` — each workspace's scheduled backups | `BACKUP_TICK_SECRET` |
| hour | `GET https://admin.<domain>/api/platform/tick` — trials, grace periods, billing holds, reminders; once a day the gateways read back and each workspace's use recorded | `PLATFORM_TICK_SECRET` |

Each with `Authorization: Bearer <secret>`. Unset, an endpoint refuses everything. A non-200 answer means some workspace failed — the body says which.

The hourly platform tick also does the partner programme's chores (§12), under a lease of their own, `partner-commissions` (twenty minutes), so two schedulers calling at once never do them twice: every hour it works out commission on invoices newly paid, refunded or credited; once a day it expires lapsed deal registrations and, from `partners.statementDay` (the 5th, India time) to the month's end, drafts last month's statements. Its answer includes `partners: { accrued, reversed, statements, expiredDeals, failed }`. A partner chore that fails is counted there and logged — it never fails the tick or the billing chores.

## 2. Configuration

Set in the server's environment (pm2 ecosystem file or systemd unit), never in the repository.

| Setting | Required | What |
|---|---|---|
| `DATABASE_URL` | yes | The installation's first workspace's database, and the server the provisioner uses in development |
| `CONTROL_DATABASE_URL` | yes | The control plane: workspaces, plans, billing, staff |
| `REFERENCE_DATABASE_URL` | yes | Shared reference data (PIN codes, world places) |
| `PLATFORM_MASTER_KEY` | yes — **back it up (§4)** | Seals every workspace's database address and key bundle, and the platform's secrets |
| `AUTH_SECRET` | yes | Kept for the first workspace's older sessions and links |
| `PLATFORM_DOMAIN`, `PLATFORM_PORT` | yes / no | Workspaces are `<slug>.<domain>`; `admin.` is the console, `www.` the public site, `cms.` the website's CMS (§10) |
| `TRUST_PROXY` | yes, `1` behind the proxy | Believe the proxy's forwarded host and address — and nothing else's. Without it no caller's address is known: IP rules match nobody, lockouts are per account only, and the activity log records no address |
| `TRUST_PROXY_HOPS` | with a chain of proxies (1) | How many proxies of ours append to X-Forwarded-For — 2 for a CDN in front of nginx; the caller is that many entries from the end |
| `PLATFORM_PROVISIONER_URL` | yes | A role with CREATEDB and CREATEROLE, on the maintenance database |
| `PLATFORM_WARM_POOL` | no (2) | Databases made ahead of signups |
| `PLATFORM_SMTP_URL`, `PLATFORM_MAIL_FROM` | no | The fallback for the platform's own mail while the console's Settings › Mail has no default account; with neither, mail is written to `platform-outbox/` |
| `PLATFORM_SALES_EMAIL` | yes, before launch | Where the public website's contact form is mailed (through `PLATFORM_SMTP_URL`; the visitor's address leads the message, as the mailer sets no reply-to). Unset, a contact request is **not mailed anywhere**: the visitor is still thanked and the server logs `[site] a contact request arrived, but PLATFORM_SALES_EMAIL is not set`. Every request is also kept in the CMS's leads inbox (§10), mailed or not. The address the site *shows* is separate — the CMS's site settings |
| `PLATFORM_CONSOLE_IP_ALLOWLIST` | recommended | CIDRs allowed to reach the console (needs `TRUST_PROXY=1`) |
| `MARKETING_TICK_SECRET`, `BACKUP_TICK_SECRET`, `PLATFORM_TICK_SECRET` | yes | §1 |
| `TENANCY_POOLER_URL` | yes with PgBouncer | e.g. `postgresql://127.0.0.1:6432` — the app's workspace queries go there |
| `TENANCY_MAX_CLIENTS` (35), `TENANCY_CONNECTION_LIMIT` (2), `TENANCY_IDLE_CONNECTION_S` (30) | tune | Workspace pools kept per process, connections each, and how long an unused connection stays open (§7) |
| `TENANCY_STATEMENT_TIMEOUT_MS` (30000), `TENANCY_LOCK_TIMEOUT_MS` (10000), `TENANCY_IDLE_IN_TRANSACTION_MS` (60000), `TENANCY_ROLE_CONNECTION_LIMIT` (20) | tune | Each workspace role's limits; after changing, `npm run platform:tenant -- limits` |
| `BACKUP_DIR` | no (`backups/`) | Where workspace backups are written; each workspace under `workspaces/<id>/` |
| `SUPPORT_DIR` | no (`storage/support` in the app's folder) | Contact Support's attachments and screen recordings (§11) — **back it up** (§4). Every app process must see the same folder: a file is uploaded to one and claimed when the request is sent, perhaps by another |
| `PDF_BROWSER_PATH`, `PDF_BROWSER_NO_SANDBOX` | for PDFs | A Chromium for printing documents |
| `ENABLE_DATA_RESET` | **never in production** | The temporary "reset all data" button — remove the button before launch (§8) |

The gateways' keys (Stripe, Razorpay) are **not** environment settings: an owner enters them in the console, under Billing, where they are sealed and never shown back.

**The gateways' webhooks.** Set each at the gateway's dashboard, to the address console → Billing → Gateway connections shows:

- **Stripe:** the events `checkout.session.completed`, `customer.subscription.*`, `invoice.*`, **`charge.refunded`** and **`credit_note.*`**, and the endpoint **pinned to API version `2024-06-20`** — the version the platform's own requests use. Webhooks arrive in the endpoint's version, not the requests': from `2025-03-31.basil` on, Stripe moved an invoice's subscription and a line's price elsewhere and dropped a charge's invoice, so on a newer version invoices come in with no subscription or plan lines (commission falls back to the subscription's plan) and refunds find no invoice at all.
- **Razorpay:** the events `subscription.*`, **`payment.refunded`** and **`refund.processed`**.

Without the refund and credit-note events, money that goes back to a customer is never taken back out of its partner's commission (§12).

**The partner programme's settings** (§12) are platform settings too, not environment settings: an owner changes them in the console → Partners → Programme settings, each change audited as `partner.settings` (`npm run partners -- two-factor` pins the first from the server).

| Setting | Unset | What |
|---|---|---|
| `partners.twoFactor` | required in production, optional elsewhere | The portal's two-factor policy |
| `partners.statementDay` | 5 (1–28) | The day of the month, India time, from which the tick drafts last month's statements |
| `partners.dealDays` | 90 (30–365) | How long an approved deal registration protects the company for its partner |
| `partners.refCookieDays` | 0 — off (0–90) | The referral cookie's lifetime in days. **Leave it off** until the public site has a consent mechanism (§12) |
| `partners.applications` | 1 — open | The public "Become a partner" form at `/partners` (and its sitemap entry). Applications are mailed to `PLATFORM_SALES_EMAIL` and kept in the console either way |
| `partners.directory` | 0 — off | The public partner directory at `/partners/find` |
| `partners.clawbackMonths` | 12 (1–60) | A refund more than this many months after a commission was paid out is not clawed back |
| `partners.twoPersonPayout` | 0 — off | On: whoever approved a statement cannot also mark it paid |

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
| `SUPPORT_DIR` | Support requests' attachments and screen recordings. The requests themselves are in the control plane; their files are only here. | Synced off-site nightly with `BACKUP_DIR`. |
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
| Website CMS accounts | `npm run cms:user -- list / create / link / role / reset-2fa / deactivate / two-factor` (§10) |
| Partners, and their portal accounts | `npm run partners -- list` / `user list <partner>` / `user create <partner> --email … --name … [--role ADMIN\|FINANCE\|SALES\|VIEWER]` / `user link <email>` / `user reset-2fa <email>` / `user deactivate <email>` (§12) |
| Workspaces to a partner, or back to direct | `npm run partners -- assign <partner-slug\|direct> <workspace-slug…> --reason "…" [--no-commission]` — from now, never backdated |
| The portal's two-factor; commission and statements now | `npm run partners -- two-factor [required\|optional]` / `accrue` / `statements` |

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
- [ ] `cms.<domain>` in DNS and the proxy's certificate; the first CMS admin invited; CMS two-factor **required** (CMS → Settings → Security, or `npm run cms:user -- two-factor required`); the placeholders (tagline, display domain, sales email) replaced and published.
- [ ] PgBouncer in front of workspace databases (§7); the three schedulers running (§1); the worker under pm2.
- [ ] Gateways: live keys entered, webhooks set, one test-mode checkout run end to end first (docs: billing is proven only against fakes so far).
- [ ] Settings › Mail: a default account that passes **Send test**; a signup code and a billing reminder received, and both in the Mail log.
- [ ] Contact Support (§11): console → Settings → Support has a real support address in place of the placeholder `support@yourdomain.com`, a mailbox somebody reads; the helpline and hours if there is one; `SUPPORT_DIR` on a disk that is backed up.
- [ ] Before the first partner (§12): `partners.<domain>` in DNS and the proxy's certificate; at Stripe, the endpoint pinned to API version `2024-06-20` and `charge.refunded` and `credit_note.*` among its events, at Razorpay `payment.refunded` and `refund.processed` (§2); the programme's settings looked at in the console → Partners (two-factor **required**, the statement day, deal protection, the clawback window, the two-person rule — and the referral cookie left off); `PLATFORM_SALES_EMAIL` set, as applications are mailed there; the first partner created with its terms, and its first admin invited (the partner's page → Invite partner admin, or `npm run partners -- user create`); the accountant's answers to the tax questions in §12.
- [ ] Privacy documents reviewed by counsel and published (docs/privacy).
- [ ] `npm run pentest` and `npm run load:test` on the production-like server; reports kept.

## 9. Regular checks

| When | What |
|---|---|
| Every release | The check suites; `npm run pentest` for anything touching sign-in, tenancy or billing |
| After changing capacity settings, and before a large onboarding | `npm run load:test` |
| Quarterly | A restore of one workspace and of the control plane, timed (§4) |
| Monthly | Console → Billing: failed webhooks; console → Migrations: anything behind; console → Provisioning: anything failed |
| Monthly, from the statement day | Console → Commissions: the flagged entries reviewed, the drafted statements approved and paid; console → Partners → Requests: applications, deals, changes and flagged attributions |

## 10. The website CMS

The public website's pages, blog, images, navigation and contact-form leads are managed in their own small app at `https://cms.<domain>` — not in the console, and with accounts of its own (`cms_users`): marketing people get a CMS account and never see the console or any customer's data. Its content lives in the control plane (`site_pages`, `site_page_versions`, `site_posts`, `site_media` — images, in the database — `site_settings`, `site_leads`, `cms_audit_log`), so the control plane's backup (§4) is the CMS's backup.

- **Roles.** ADMIN: everything, including CMS accounts and security. EDITOR: edits and publishes pages, posts, images, navigation and settings; works the leads. AUTHOR: drafts pages and posts and uploads images; publishes nothing and changes nobody else's posts. VIEWER: reads everything, leads included.
- **The first admin.** An owner, in the console → Website CMS → Invite a CMS admin; or on the server: `npm run cms:user -- create --email … --name … --role ADMIN`. Either emails (and shows once) a one-time link to choose a password. Nobody ever types a password for anybody; the last active admin cannot be demoted or switched off.
- **Two-factor** is the CMS's own setting: "required" (everybody enrols an authenticator at their next sign-in) or "optional" (only those who set one up are asked). Until an admin chooses it is required in production and optional elsewhere. Sessions: sixty minutes idle, twelve hours at most; failed sign-ins lock out per account and per known caller.
- **Locked out.** A lost password: `npm run cms:user -- link <email>`. A lost phone: `npm run cms:user -- reset-2fa <email>`. No admin can get in: `two-factor optional`, get in, put `required` back. The console's Website CMS page also sends a CMS admin a new link (emailed to them only).
- **Publishing.** Pages have a draft and a published copy; the site shows only what is published, and a built-in page (home, pricing, security, contact, sign-in, signup, terms, privacy) shows its default content until the CMS publishes one — it can be changed but never unpublished or deleted. Every publish is kept as a version. Posts are published now or scheduled: a scheduled post appears once its time has passed, with no job to run. The site caches published content for 45 seconds per process, so another server process may show the change up to 45 seconds later.
- **Previews** are links on the public site, `/preview/<token>`, signed with a key derived from `PLATFORM_MASTER_KEY`, for one draft as it was when the link was made, for fifteen minutes. Never indexed, never cached.
- **Images** are PNG, JPEG, WebP or GIF, told by their bytes (never SVG), at most 5 MB, served at `/media/<id>` with a year's caching. Uploads go through a server action, whose body Next caps at 1 MB unless `next.config.ts` sets `experimental.serverActions.bodySizeLimit` (6 MB covers the 5 MB limit and the form's overhead). An image cannot be deleted while a page, post or the settings use it, and nothing using it is published until it has alt text.
- **Leads** are kept from the contact form (with the caller's address only when `TRUST_PROXY` makes it known) and mailed to `PLATFORM_SALES_EMAIL` when set. Editors change their status and export them as CSV (audited).
- **The CMS host** answers no `/api` path — its work is server actions — and is never indexed or cached. `npm run check:cms` covers all of the above on a scratch control plane; `npm run pentest` probes CMS-1 to CMS-6.

## 11. Contact Support

Anyone signed in to a workspace can ask the platform for help with the **Contact Support** button at the bottom right of every page: a subject, the details, how critical it is, up to five files and, with their consent, a screen recording of up to five minutes. Requests are kept in the control plane (`support_requests`, `support_attachments`, `support_entries`) and worked in the console at `admin.<domain>/support` — owners, admins and support staff act on them, read-only staff read them. This is the platform's support desk; the helpline a workspace shows its own people (its Settings, under Helpline) is its admins' and is unrelated. The button is not shown to anybody viewing as someone else, or to platform staff inside a workspace on a support grant.

**Settings** — console → Settings → Support, changed by owners and admins, audited as `support.settings`:

| Setting | Unset | What |
|---|---|---|
| Contact Support in workspaces | on | Off hides the button in every workspace at once |
| Support email | `support@yourdomain.com` (a placeholder, shown with a warning) | Where each new request is announced, and the Reply-To of every mail to a requester |
| Helpline, hours | not shown | Shown in the dialog and in the acknowledgement mail |
| Screen recording | on | Off removes the Record button everywhere |
| Keep files after closing | 365 days (30–3650) | How long a closed request's files are kept (below) |

**Where the mail goes.** All of it goes through the platform's mailer — the account the console's Settings › Mail names for its type, else the default's, else `PLATFORM_SMTP_URL`, else into `platform-outbox/` — and every send is in the console's Mail log:

- each new request is announced to the support email, `[SR-1042][URGENT] {workspace}: {subject}`, with a link to it in the console;
- the person who sent it gets an acknowledgement with its number, Reply-To the support email;
- a staff reply from the console is emailed to them, `Re: [SR-1042] {subject}`, Reply-To the support email, and kept on the request's timeline — marked "Email failed" with the reason when the mail server refuses it.

There is no inbound mail: when a customer answers, the answer lands in the support mailbox, not the console. Somebody must read that mailbox, and paste anything that matters into the request as an internal note.

**Files.** Uploads are streamed to `SUPPORT_DIR` as soon as they are chosen, told apart by their bytes (images, PDF, office documents and zips, plain text; recordings only WebM or MP4; never SVG or HTML), 10 MB a file, 80 MB a recording, 150 MB waiting per person:

```text
SUPPORT_DIR/<workspace id>/staging/<upload id>(.json)          chosen, not yet sent — swept after a day
SUPPORT_DIR/<workspace id>/<request id>/<attachment id>          sent with a request
```

Staff open them only through `admin.<domain>/support-files/<id>` (owners, admins, support), which sends them with the type they were sniffed as, `nosniff` and a sandboxing policy; each opening is audited as `support.file.open`, once per person per file per ten minutes. Size the disk for recordings: a screen recording runs at about 1 MB a minute, so a five-minute one is 5–40 MB depending on what was on screen.

**Retention.** The hourly platform tick (§1) deletes uploads left in staging for a day, and the files of requests closed longer ago than the retention setting; each attachment is then marked as removed, and the request, its timeline and the list of what was attached stay. Its answer includes `support: { swept, purged, stuck }` — `stuck` counts files the disk would not let go of (held open, a permission), tried again next hour. A request reopened before then keeps its files; its retention starts again from its next close.

**Screen recording** needs the person to tick a consent box that lists what it collects: the recording, the browser's console errors and warnings while it ran, page-load timings, their IP address and device details, and sound only if they switch the microphone on. It is not offered where the console switched it off, or where the workspace's DLP deterrents apply to the person (as the workspace's DlpGuard decides it). Only the deterrents an admin chose refuse it: blocking copy, print and the like, or a screenshot limit of zero. A daily screenshot allowance (the default is two a day) does not, so a workspace nobody configured offers recording to everyone.

**Checks.** `npm run check:support` covers all of the above on a scratch control plane and a temporary `SUPPORT_DIR`; `npm run pentest` probes SUP-1 to SUP-5.

## 12. The partner programme

Resellers and distributors sell the platform and are paid commission on what their customers pay. They work in their own small app at `https://partners.<domain>` — the partner portal — with accounts of its own (`partner_users`): a partner's people never see the console, the CMS or anything inside any workspace. Staff run the programme from the console (Partners, Commissions, and the Partner panel on a workspace's page). Everything lives in the control plane (`partners`, `partner_terms`, `partner_users`, `partner_sessions`, `tenant_attributions`, `partner_referral_links`, `partner_deals`, `commission_entries`, `commission_invoice_states`, `partner_statements`, `partner_requests`, `partner_applications`, `partner_audit_log`), so the control plane's backup (§4) is the programme's backup.

- **Roles, the partner's side.** ADMIN: everything, including the partner's people and its activity log. FINANCE: commissions, statements, the CSVs, the payout details' mask and new payout details. SALES: invitation codes, referral links and deal registrations. VIEWER: reads the customers, codes, links and registrations. Every role sees the dashboard, the customers and the company profile; only ADMIN and FINANCE see any commission figure. A distributor also sees its resellers' totals and its own override on their customers.
- **Roles, the console's side.** Owners and admins create and edit partners, change their status, invite their first admin and decide applications, profile changes and new resellers. Owners, admins and billing staff see the money, set terms, decide deal registrations, move workspaces between partners, and review and adjust commission. Only **owners and billing staff** approve and pay statements, and reveal or set payout details: admins see the amounts and set terms, but cannot approve or pay. Support and read-only staff see the partners, without any money.
- **The first admin.** A partner is created in the console (Partners → New partner) with its terms, and starts as onboarding. Then the partner's page → Invite partner admin, or on the server `npm run partners -- user create <partner> --email … --name …`; either emails (and shows once) a one-time link to choose a password, valid for three days. Later people are invited by the partner's own admins, at most fifty active a partner; the last active admin cannot be demoted or switched off. Staff activate the partner once its terms are in force and it has an active admin — only then can it make codes, links and registrations.
- **Two-factor** is the portal's own setting, `partners.twoFactor`: "required" (everybody enrols an authenticator at their next sign-in) or "optional" (only those who set one up are asked). Until an owner chooses it is required in production and optional elsewhere; keep it required. Sessions: sixty minutes idle, twelve hours at most; failed sign-ins lock out per account and per known caller.
- **Locked out.** A lost password: `npm run partners -- user link <email>`. A lost phone: `npm run partners -- user reset-2fa <email>`. No admin of a partner can get in: `npm run partners -- two-factor optional`, get in, then `two-factor required` again. The partner's page in the console (its Users tab) also sends a new link or resets two-factor.
- **Attribution.** A workspace is credited to a partner when it signs up, by the first of: an approved deal registration for the email's domain (protected for `partners.dealDays`, 90 days, from approval); the partner's invitation code; the partner's referral code (from a `/signup?ref=` link, or typed in "Have a partner code?"); a territory default (exactly one active distributor whose terms set a territory rate for the signup's country). Only active partners' claims count. Other claims naming a different partner, and a signup from outside the winner's territories, are flagged for review (console → Partners → Requests → Attributions); a flag never changes who is credited. Staff move a workspace (its page → Change partner, with a reason of 10 to 500 characters), and `npm run partners -- assign` moves many — always from now, never backdated, with both partners' activity logs told (without the reason). A partner's own workspace is attributed with `--no-commission` and never earns. The workspace itself sees "Sold and supported by {partner}" on its Billing page, read-only.
- **The referral cookie is off** (`partners.refCookieDays` 0). When on, a visitor arriving with `?ref=` gets a `deskzo_ref` cookie so a later signup is credited; the site promises no tracking cookies and has no consent banner, so it stays off until one exists. Referral links still credit a signup made from the link itself — and while signup is by invitation, a link never opens signup without an invitation.
- **Commission, in plain words.** When a customer's invoice is paid at a gateway, the partner earns a share of what was paid before tax, at the rate its terms in force on that day give: a territory rate for a customer credited by territory; otherwise the plan's own rate, else the customer's country's rate, else the new-customer rate for the first months (twelve by default) from the customer's first payment and the renewal rate after, else the default rate. Terms are set by staff, never backdated, and a new partner's form starts from 20 % for the first 12 months, then 10 %, for as long as the customer stays (5 % override for a distributor) — nothing applies until staff save them. A distributor also earns its override rate on its resellers' customers, on top. Nothing is earned on the platform's own workspace, a workspace credited without commission, after the partner was terminated, without terms, or beyond the terms' duration. A suspended partner keeps earning; a terminated one stops at termination and is paid what it was owed. The tick works it out every hour; staff can run it now (Commissions → Run commissions now, or `npm run partners -- accrue`).
- **The monthly cycle.** From `partners.statementDay` (the 5th, India time) the tick drafts a statement per partner and currency for last month: the commission earned by the month's end that is on no statement yet, with any clawback of it. A total of nothing or less rolls forward to next month; nothing is converted between currencies. Staff can draft them any day (Commissions → Generate statements, or `npm run partners -- statements`), still for last month.
- **Approving and paying a statement.** An owner or billing staff member reviews the draft (Commissions → Statements), approves it — the partner's payout details must be on file; up to six tax lines, added or withheld, give the net payable — and the partner's admins and finance people are emailed. A GST- or VAT-registered partner then adds its own invoice number in the portal. Pay it outside the platform (a bank transfer), then **Mark paid** with the payment's reference and date. With `partners.twoPersonPayout` on, the person who approved it cannot mark it paid. A draft or approved statement can be voided (its entries go back to the next one); a paid one is final — correct it with an adjustment.
- **Payout details** are sealed, and shown to staff only as a mask; **Reveal payout** (owners and billing staff) shows them whole and is written to the platform's audit log and the partner's activity log. A partner never sees its own in full: to change them it submits new ones, which an owner or billing staff approve; every admin of the partner is emailed the new mask.
- **Clawbacks.** When an invoice is refunded, credited or voided after commission was earned on it, a negative entry takes the commission on the money that went back out of the next statement. The exception (`partners.clawbackMonths`, 12): once a commission has been paid out, a refund that comes more than that many months after the payment is not taken back — the console marks it "Refunded after the clawback window — not recovered". Unpaid commission is always taken back. This needs the gateways' refund and credit-note events (§2).
- **For the accountant.** Tax is not worked out here; staff enter tax lines on each statement. Ask the owner's accountant: in India, TDS on commission (section 194H) at the rate and threshold in force, on the partner's PAN, and higher without one; GST — a registered partner invoices its commission with GST on top, whether reverse charge applies to an unregistered one, and the right SAC code; partners abroad — paying a non-resident is an import of services (IGST under reverse charge) and may need withholding under section 195 or a tax treaty, with Forms 15CA/15CB; whether the statement or the partner's invoice is the document of record; statements kept eight years like billing records; each statement paid in its own currency. The console's statement page lists the same questions.
- **What partners see, and never see.** Their own profile, terms, payout mask and activity; the customers credited to them now — the workspace's name and address, country, status, billing standing, plans, what it pays each month (at list prices), its renewal date, and how it was credited — and, for ADMIN and FINANCE, the commission earned from each. Never: anything inside a workspace (no workspace database is opened for them, and there is no support entry), a customer's contact addresses, tax id or invoices, another partner's anything (a refused registration or a conflict never names the other partner), staff notes and reasons, or — for a distributor — its resellers' rates, entries, statements or people.
- **Applications.** The public "Become a partner" form (`/partners`) is open by default and limited per address, per caller and in all; each application is mailed to `PLATFORM_SALES_EMAIL` and kept in the console (Partners → Requests → Applications), where staff turn one into a partner. The public directory (`/partners/find`) lists only active partners who chose to be listed, and is off by default.
- **The portal host** answers no `/api` path — its work is server actions — and is never indexed or cached. `npm run check:partners` covers all of the above on a scratch control plane; `npm run pentest` probes PRT-1 to PRT-12.
