# Deskzo One on Coolify

For a server run by [Coolify](https://coolify.io): Coolify builds the repository's `Dockerfile`, and its proxy (Traefik)
handles HTTPS. Everything runs as one application container plus a PostgreSQL database. Coolify's Scheduled Tasks make
the timed calls and run the worker. (Without Coolify, [deploy-azure.md](deploy-azure.md) runs the same with Docker
Compose and Caddy.)

It goes in two phases:

1. **Live today:** the website, the console, the CMS, the partner portal and Deskzo's own workspace, each on its own
   address with its own certificate.
2. **Before customers sign up:** one wildcard certificate for `*.deskzo.com`, so every new workspace's address works
   the moment it is created. That needs DNS at a provider whose API Traefik can use: Cloudflare below.

## Phase 1 — live today

### 1. DNS (Openprovider, for now)

Keep the `@` A record to the server's IP. Add one more:

| Type | Name | Value |
|---|---|---|
| A | `*` | the same IP as `@` |

That makes `www`, `admin`, `cms`, `partners` and every workspace's address reach the server.

### 2. The database

In Coolify: **+ New → Database → PostgreSQL**. Set its image to `postgres:16-alpine`, and start it. On its page, copy
**Postgres URL (internal)**: `postgres://postgres:<password>@<host>:5432/postgres`. Note the password and the host. If the password has anything but letters and digits, URL-encode it where it goes into the URLs below.

In its **Custom PostgreSQL Configuration**, add `max_connections = 200`, then restart it. Each app container keeps up to 70 connections to workspaces (runbook §7), and the default of 100 leaves too little room beside it.

Turn on its **Backups** too (daily). Also enable **Azure Backup** on the VM, which keeps every database, including each
workspace's, with the uploads.

### 3. The application

On the Deskzo application:

- **General:**
  - **Build Pack:** Dockerfile.
  - **Ports Exposes:** `3000`.
  - **Domains:** `https://deskzo.com,https://www.deskzo.com,https://admin.deskzo.com,https://cms.deskzo.com,https://partners.deskzo.com,https://deskzo.deskzo.com`
- **Advanced:**
  - turn **off** *Inject Build Args to Dockerfile*, so no secret reaches the build;
  - leave the health check off, because the image has no curl or wget for one.
- **Persistent Storage:** add a volume named `deskzo-data` with destination path `/data`. Workspace backups, support attachments and the GeoIP file live there.
- **Post-deployment command:** `npm run tenants:migrate`. Each release migrates every database just after the new container starts. The migrations are written expand-then-contract, so the new code tolerates the old schema meanwhile. A new column on an existing table is not tolerated by itself: Prisma names every column in a query without a `select`, sign-in's among them. Until a later release, such a column goes in `NOT_YET_EVERYWHERE` in `src/lib/tenancy/clients.ts`, and the code that reads it is ready for it to be missing.
- **Environment Variables → Developer view.** Paste this, with the database's password and host from step 2 put in the four URLs:

```ini
PLATFORM_DOMAIN=deskzo.com
PLATFORM_ENV=production
DATABASE_URL=postgresql://postgres:<password>@<host>:5432/deskzo?schema=public
CONTROL_DATABASE_URL=postgresql://postgres:<password>@<host>:5432/deskzo_control?schema=public
REFERENCE_DATABASE_URL=postgresql://postgres:<password>@<host>:5432/deskzo_reference?schema=public
PLATFORM_PROVISIONER_URL=postgresql://postgres:<password>@<host>:5432/postgres
TRUST_PROXY=1
TRUST_PROXY_HOPS=1
INTERNAL_APP_URL=http://127.0.0.1:3000
TENANCY_DEFAULT_SLUG=deskzo
TENANCY_DEFAULT_NAME=Deskzo
PLATFORM_SMTP_URL=
PLATFORM_MAIL_FROM=Deskzo One <no-reply@deskzo.com>
PLATFORM_SALES_EMAIL=
DNS_RESOLVERS=1.1.1.1,8.8.8.8
```

Then add the secrets. In the application's **Terminal** (the container is already running from the first deploy), run:

```bash
sh deploy/make-secrets.sh
```

It prints five lines: `AUTH_SECRET`, `PLATFORM_MASTER_KEY` and the three tick secrets. Paste them into the Developer view as well, and **copy `PLATFORM_MASTER_KEY` to two safe places offline**: without it no workspace can ever be read again. Run it once only, because it prints new values every time.

Mail: Azure blocks port 25, so set `PLATFORM_SMTP_URL` to a provider on 587 or 465, e.g.
`smtp://user%40deskzo.com:password@smtp.office365.com:587`. An `@` in the user name is written `%40`.

Save, then **Redeploy**.

### 4. First run

In the application's **Terminal**:

```bash
sh deploy/first-run-in-container.sh you@deskzo.com "Your Name"
```

It does the following:
- makes the three databases;
- migrates them;
- registers Deskzo's own workspace at `deskzo.deskzo.com`;
- loads the product catalogue;
- makes you the console's owner.

It prints a setup link, which is also emailed once mail is set up. Open it to choose your password and turn on two-factor sign-in at https://admin.deskzo.com.

To make yourself the owner of your own workspace, type the password at the prompt, not into the command:

```bash
read -rs -p "Password for deskzo.deskzo.com: " ADMIN_PASSWORD && export ADMIN_PASSWORD && ADMIN_EMAIL=you@deskzo.com ADMIN_NAME="Your Name" npm run db:bootstrap; unset ADMIN_PASSWORD
```

### 5. Scheduled Tasks

On the application, under **Scheduled Tasks**, add four:

| Name | Command | Frequency |
|---|---|---|
| Marketing | `node deploy/scheduler.mjs once marketing` | `*/5 * * * *` |
| Backups | `node deploy/scheduler.mjs once backup` | `*/15 * * * *` |
| Platform | `node deploy/scheduler.mjs once platform` | `0 * * * *` |
| Worker | `node_modules/.bin/tsx scripts/platform-worker.ts --once` | `*/5 * * * *` |

Press **Execute Now** on each. The first three should log `200`. The worker sets up new workspaces and keeps the warm pool full. Signups don't wait for it, because the signup form starts one itself.

### 6. Check

- https://www.deskzo.com: the website. `deskzo.com` serves it too.
- https://admin.deskzo.com: the console.
- https://deskzo.deskzo.com: your workspace.

**Don't open signups yet.** A new customer's address, like `acme.deskzo.com`, has no certificate until phase 2.

## Phase 2 — a certificate for every workspace

Traefik can get a wildcard certificate only through Let's Encrypt's DNS challenge, by writing a TXT record through
your DNS provider's API. Openprovider's API is open to reseller accounts only, and would need your account's
username and password. So move deskzo.com's DNS to **Cloudflare**, which is free. The domain stays registered at
Openprovider.

1. **Cloudflare:** add the site `deskzo.com` (Free plan). Make sure there are two records, an A record for `@` and one for `*`, both to the server's IP. Both must be **DNS only, a grey cloud, not proxied**.
2. **Openprovider:** change deskzo.com's nameservers to the two Cloudflare gives you. Wait until Cloudflare says the site is active.
3. **Cloudflare API token:** go to My Profile → API Tokens → Create Token → **Edit zone DNS**. Under Zone Resources, include *Specific zone: deskzo.com*. Copy the token.
4. **Coolify proxy:** go to Servers → your server → Proxy → Configuration. In the `traefik` service:
   - under `environment`, add `- CF_DNS_API_TOKEN=<the token>`;
   - under `command`, remove the two `httpchallenge` lines and add:
     ```yaml
     - '--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare'
     - '--certificatesresolvers.letsencrypt.acme.dnschallenge.delaybeforecheck=0'
     ```
   Save, and **Restart Proxy**.
5. **The wildcard certificate:** go to Proxy → Dynamic Configurations and add `wildcard-deskzo-com.yaml`:
   ```yaml
   http:
     routers:
       wildcard-deskzo-com:
         rule: 'HostRegexp(`[a-z0-9-]+\.deskzo\.com`)'
         entryPoints:
           - https
         priority: 1
         service: wildcard-placeholder
         tls:
           certResolver: letsencrypt
           domains:
             - main: deskzo.com
               sans:
                 - '*.deskzo.com'
     services:
       wildcard-placeholder:
         loadBalancer:
           servers: []
   ```
   Watch Proxy → Logs until the certificate is issued.
6. **Every subdomain to the app.** On the application:
   - set **Domains** to just `https://deskzo.com` and save, so Coolify writes one pair of routes;
   - then turn off **Readonly labels**. In both lines that end in `.rule=…`, the http and the https one, replace `Host(`deskzo.com`)` with `(Host(`deskzo.com`) || HostRegexp(`[a-z0-9-]+\.deskzo\.com`))` and leave the rest of the line as it is;
   - **Redeploy**.

   If the site stops answering, **Reset Labels to Defaults** puts Coolify's own back.
7. **Check two addresses that aren't set up anywhere**, e.g. `https://nobody.deskzo.com`. It should show "No such workspace" over HTTPS with no warning. Then open signups.

Customers' own domains (Settings → Domain) need a certificate each, issued on demand. Traefik doesn't do that, so leave the console's **Offer custom domains** off on Coolify.

## Tickets by email

Every workspace's helpdesk gets an address, `<workspace>@tickets.deskzo.com`, and a company forwards its own
support mail there (Settings → Support email shows it the steps). Nothing changes on the company's domain. This is
set up once, here, for every workspace. It needs deskzo.com's DNS on Cloudflare (Phase 2, steps 1 and 2).

1. **Cloudflare → deskzo.com → Email → Email Routing.** Under *Settings*, add the subdomain `tickets.deskzo.com` and
   let Cloudflare add its MX and SPF records. deskzo.com's own mail is untouched.
2. **Make a secret** in the application's Terminal: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. **Cloudflare → Workers & Pages → Create → Worker.** Name it `deskzo-inbound-email`, replace its code with
   `deploy/cloudflare/inbound-email-worker.js`, and deploy. Under its *Settings → Variables and Secrets* add:
   - `DESKZO_INBOUND_URL` = `https://deskzo.com/api/platform/inbound-email` (text);
   - `DESKZO_INBOUND_SECRET` = the secret from step 2 (type *Secret*).
4. **Email Routing → Routing rules → Catch-all address** for `tickets.deskzo.com`: action *Send to a Worker*,
   destination `deskzo-inbound-email`. Enable it.
5. **On the Deskzo application → Environment Variables,** add, then **Redeploy**:

```ini
INBOUND_MAIL_DOMAIN=tickets.deskzo.com
INBOUND_MAIL_SECRET=<the secret from step 2>
```

6. **Check:** in Deskzo's own workspace, Settings → Support email now shows `deskzo@tickets.deskzo.com`. Send it an
   email from an address that is a contact: a ticket opens, and the acknowledgement arrives. From any other address,
   the email waits in Helpdesk → Support inbox. An address that is no workspace bounces.

Replies to customers go out through `PLATFORM_SMTP_URL` as "<Company> Support", from `PLATFORM_MAIL_FROM`'s address,
with Reply-To the workspace's helpdesk address, so the customer's answer comes back to the ticket.

## Releases

Push to `main`. If automatic deployment is on, Coolify builds and starts the new version, then runs the
post-deployment migrations. Otherwise press **Redeploy**. Watch the deployment log for `tenants:migrate`: a workspace
whose migration fails is held at the maintenance page, and the console's Migrations page says why (runbook §3).

## Not covered here

- **PgBouncer** (runbook §7): one app container keeps at most 70 database connections, inside the 200 set in step 2.
- **More app containers.** Run several only once PgBouncer is in front.
- The rest of the runbook's checklist (§8) before the first paying customer.
