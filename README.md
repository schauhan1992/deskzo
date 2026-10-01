# Deskzo One

The business suite for growing companies: sales, accounts, people and support in one workspace. A company signs up at
**deskzo.com**, gets a workspace at its own address (`acme.deskzo.com`), and switches on the products it needs: one, several,
or all of them as **Deskzo One**. Built India-first: GST invoicing, e-invoices and e-way bills, TDS, PF/ESI/PT payroll and
Ind AS 115, with the rest of the suite sold worldwide.

## Products

Every product is a set of modules (`src/lib/modules.ts`); `src/lib/products.ts` is the one place their names and contents
are written down. A workspace can hold several products at once, and they share one set of records.

| Product | What it runs |
|---|---|
| **Deskzo One** | Every Deskzo product in one workspace, on one set of records |
| **Deskzo CRM** | Leads, pipeline, calls, field visits, targets and incentives |
| **Deskzo Books** | GST invoicing, accounting, payables, receivables and expenses *(India)* |
| **Deskzo People** | HR, payroll, attendance, leave, recruitment and visitors *(India)* |
| **Deskzo Desk** | Helpdesk tickets with SLAs, a customer portal and feedback |
| **Deskzo Inventory** | Items and stock, orders, purchases and IT assets |
| **Deskzo Subscriptions** | Recurring orders, renewals, add-ons and AMCs |
| **Deskzo Projects** | Projects with milestones, billing stages, risks and tasks |
| **Deskzo Campaigns** | Email journeys, forms and events, with consent built in |
| **Deskzo Analytics** | Reports by any dimension, and the sales forecast |
| **Deskzo Vault** | Shared passwords and credentials, with owners and rotation |

Add-ons: **Revenue & Close** (Ind AS 115 revenue recognition and a month-end close, with Books, and included in Deskzo One),
**AI Copilot** (questions about your data, answered by the AI provider the workspace chooses), and **More people** (seats).

## How it is built

**One app, several addresses.** The proxy (`src/proxy.ts`) reads the host and serves:

| Address | What |
|---|---|
| `<slug>.<domain>` | A customer's workspace, or a custom domain of its own once verified by DNS |
| `<domain>`, `www.<domain>` | The public website and signup |
| `admin.<domain>` | The platform console, for Deskzo staff |
| `cms.<domain>` | The website's CMS, with its own accounts |
| `partners.<domain>` | The partner portal |

**A database per workspace.** Signup takes a database from a warm pool (or creates one), migrates it and makes the
customer its owner. Each workspace has its own database, its own login role and its own encryption keys; one Prisma client
routes every query to the right database for the request (`src/lib/tenancy`).

**Two shared databases.** The **control plane** (`prisma/control`) holds which workspaces exist, plans and billing, staff,
the website CMS and the partner programme, and no customer business data. The **reference database** (`prisma/reference`)
holds PIN codes and world places that every workspace reads.

**What a workspace may use** is worked out from its plans (one per product, or Deskzo One), written on its control-plane
row, and checked on every page and every server action. Billing runs through Stripe worldwide and Razorpay in India.

## Stack

Next.js 16 (App Router, server actions) · React 19 · TypeScript · Prisma 6 · PostgreSQL 16 · Tailwind CSS 4 · Auth.js ·
Zod. No component library: the UI kit is in `src/components/ui`.

## Running it locally

You need Node.js 20.9 or later and Docker.

```bash
npm install
npm run db:generate          # the three Prisma clients
npm run docker:up            # Postgres 16 on :5432 (user and password: deskzo)
docker exec deskzo-postgres createdb -U deskzo deskzo_control
docker exec deskzo-postgres createdb -U deskzo deskzo_reference
cp .env.example .env
```

In `.env`, set `AUTH_SECRET` and `PLATFORM_MASTER_KEY`, each to a fresh 32-byte value:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then build the databases and register the first workspace:

```bash
npx prisma migrate deploy    # the first workspace's database (DATABASE_URL)
npm run control:migrate      # the control plane
npm run reference:migrate    # the reference database
npm run platform:adopt       # registers the first workspace (TENANCY_DEFAULT_SLUG, "deskzo")
npm run platform:plans -- products   # the product catalogue: Deskzo One, each product, the add-ons
npm run dev
```

Accounts are made from the command line. Staff and CMS accounts get a one-time link to choose their own password (emailed,
and printed); the first owner sets theirs through an environment variable, so clear it from your shell history after.

| For | Command |
|---|---|
| The first workspace's owner | `npm run db:bootstrap` with `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `ADMIN_NAME` set |
| Platform staff (the console) | `npm run platform:staff -- create --email … --name … --role OWNER` |
| The website CMS | `npm run cms:user -- create --email … --name … --role ADMIN` |

Locally, `PLATFORM_DOMAIN` is `localhost`: the workspace is at http://deskzo.localhost:3000, the console at
http://admin.localhost:3000, the CMS at http://cms.localhost:3000 and the website at http://localhost:3000. Platform mail
(signup codes, setup links) is written to `platform-outbox/` until `PLATFORM_SMTP_URL` is set.

Optional: `npm run site:seed-pages` publishes the website's pages, and `npm run db:reference` loads India's PIN codes.

## Deploying

Production runs on one Azure VM in Docker: Caddy for HTTPS (a certificate for each address, issued automatically),
the app, the worker, the scheduler and PostgreSQL. The `Dockerfile` builds the image, `deploy/azure/` holds the rest,
and [docs/deploy-azure.md](docs/deploy-azure.md) is the step-by-step guide, from creating the VM to every later release.

## Everyday commands

| Command | What |
|---|---|
| `npm run dev` | The app, with every address above |
| `npm run tenants:migrate` | Migrations for the control plane, the reference database, the warm pool and every workspace, canary first |
| `npm run platform:worker` | Sets up new workspaces and runs background jobs (keep it running beside the app) |
| `npm run platform:tenant -- …` | List, hold, reopen or close workspaces; their plans and entitlements; invitations |
| `npm run build:check` | A production build beside the dev server |
| `npm run check:<suite>` | One of the check suites (below) |
| `npm run pentest` | The cross-workspace attack suite; its report is `docs/reports/pentest.md` |

## Checks

There is no unit-test runner; behaviour is proved by about 110 **check suites** in `scripts/check-*.ts`, each run with
`npm run check:<name>`. They drive the real actions against the database with stubbed sessions, create their own fixtures
under a unique prefix and clean them up, never call an outside service, and render pages to assert on the HTML.
`npm run pentest` attacks the tenancy boundary: one workspace's credentials, cookies, files and URLs against another's.

Before a change is committed: `npx tsc --noEmit`, ESLint on the files touched, the suites for what changed, and
`npm run build:check`. Formatting is by hand (there is no Prettier).

## Repository

| Path | What |
|---|---|
| `src/app/(dashboard)` | The workspace app |
| `src/app/platform-site`, `platform-console`, `platform-cms` | The website, the staff console, the CMS |
| `src/actions` | Server actions, each checking the session, the plan and the permission |
| `src/lib` | Domain logic: `tenancy`, `platform`, `billing`, `authz`, `ledger`, `seo`, `cms`… |
| `src/lib/products.ts`, `src/lib/modules.ts` | What is sold, and the modules it is made of |
| `prisma/` | The workspace schema and migrations; `prisma/control`, `prisma/reference` for the other two |
| `scripts/` | Platform commands, the check suites, the website's content and seed |
| `Dockerfile`, `deploy/azure/` | The image, and the VM's services, settings and scripts |
| `docs/deploy-azure.md` | Setting production up on an Azure VM, and releasing |
| `docs/runbook.md` | Running it in production: configuration, releasing, backups, recovery |
| `docs/ROADMAP.md` | How the product was built, phase by phase |
