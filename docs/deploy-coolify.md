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

### 0. The Azure VM and Coolify

In the Azure portal, **Create a virtual machine**:

| Setting | Value |
|---|---|
| Region | **Central India** (customers' data stays in India) |
| Image | **Ubuntu Server 24.04 LTS**, x64 |
| Size | **Standard_B4ms** (4 vCPUs, 16 GiB) at least. Coolify builds the image on this same machine while the app, PostgreSQL and Coolify keep running, and the build alone peaks at 5–6 GB of memory |
| OS disk | Premium SSD, **128 GiB**. Each release's image is about 2.5 GB, and Coolify keeps earlier ones for rollback |
| Public IP | New, **Static** |
| Backup | **Enable Azure Backup**, daily |

In the VM's **Networking** (its network security group), allow inbound:

| Port | From | What |
|---|---|---|
| 22 | your own IP only | SSH |
| 80, 443 | anywhere | the website, the console and every workspace, through Coolify's proxy |
| 8000, 6001, 6002 | your own IP only | Coolify's dashboard, its live updates, and its **Terminal**, which steps 3 and 4 use |

Then install Coolify:

```bash
ssh azureuser@<the VM's IP>
```

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

Open `http://<the VM's IP>:8000` straight away and register: the first account made becomes Coolify's owner. Then
**+ New → Project**, and in it **+ New → Private Repository (with GitHub App)**: connect GitHub, choose this repository
and the branch `main`. That is the Deskzo application of step 3.

Once Coolify's own dashboard has a domain of its own (Settings → Instance's Domain), ports 8000, 6001 and 6002 can be
closed: the dashboard and its Terminal then come through 443.

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
- **Persistent Storage:** add a volume named `deskzo-data` with destination path `/data`. Workspace backups, support attachments, the GeoIP file and the web access log (`/data/logs`, runbook §14) live there.
- **Post-deployment command:** `npm run tenants:migrate`. Each release migrates every database just after the new container starts. The migrations are written expand-then-contract, so the new code tolerates the old schema meanwhile. A new column on an existing table is not tolerated by itself: Prisma names every column in a query without a `select`, sign-in's among them. Until a later release, such a column goes in `NOT_YET_EVERYWHERE` in `src/lib/tenancy/clients.ts`, and the code that reads it is ready for it to be missing. On the deploys before the first run (step 4) it fails, because the databases don't exist yet: that is expected. Coolify only logs a failing post-deployment command and still calls the deployment a success, so after every release read its log (Releases, below).
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
TRUST_PROXY_CLOUDFLARE=1
INTERNAL_APP_URL=http://127.0.0.1:3000
TENANCY_DEFAULT_SLUG=deskzo
TENANCY_DEFAULT_NAME=Deskzo
PLATFORM_SMTP_URL=
PLATFORM_MAIL_FROM=Deskzo One <no-reply@deskzo.com>
PLATFORM_SALES_EMAIL=
DNS_RESOLVERS=1.1.1.1,8.8.8.8
DESKZO_WORKER=in-app
```

`TRUST_PROXY_CLOUDFLARE=1` is for deskzo.com's records proxied by Cloudflare (an orange cloud). Traefik then sees every
visitor as a Cloudflare address, so lockouts would lock out everybody behind the same Cloudflare location together and
IP rules would never match. With it, Deskzo takes the visitor's own address from Cloudflare's `CF-Connecting-IP` — but
only on a request that came from one of Cloudflare's own addresses, so a request sent straight to the server's IP can't
make one up. Check it after a release: sign in, and Settings › Security's activity log should show your own address, not
a 104.x or 172.6x one.

`DESKZO_WEB_PROCESSES=2` (optional; one when unset) runs two copies of the web app in the container, so one slow page doesn't hold every other request — what they keep in memory is kept in step between them. See docs/runbook.md §7.1 before raising it.

`DESKZO_WORKER=in-app` runs the platform worker inside the application's container, beside the web app, for as long as the container runs: it sets new workspaces up, keeps the warm pool full and carries out Automate's workflows every couple of seconds. If it stops it is started again five seconds later, without touching the web app (deploy/start.mjs). It is in the same container rather than a second Coolify application so that it shares `/data`, where a workspace's restore lock lives: the worker must see it to leave a workspace alone while it is restored.

Then add the secrets. In the application's **Terminal** (the container is already running from the first deploy), run:

```bash
sh deploy/make-secrets.sh
```

It prints five lines: `AUTH_SECRET`, `PLATFORM_MASTER_KEY` and the three tick secrets. Paste them into the Developer view as well, and **copy `PLATFORM_MASTER_KEY` to two safe places offline**: without it no workspace can ever be read again. Run it once only, because it prints new values every time.

Mail: set it up in the console once it is running — **Settings › Mail**. Add an account (Microsoft 365 by OAuth,
Amazon SES, Elastic Email, SendGrid, Brevo, Mailgun, Postmark or any SMTP server), press **Send test**, then
choose it as the default and, if you like, a different account for each type of mail (Account & security,
Billing, Support, Alerts). Every send is in the console's **Mail log**. Azure blocks port 25: every provider
there uses 587, 465 or 2525. `PLATFORM_SMTP_URL` (e.g. `smtps://user%40deskzo.com:password@smtp.example.com:465`)
is only the fallback while Settings › Mail has no default account, and can be left empty.

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

To make yourself the owner of your own workspace, type the password at the prompt, not into the command. The Terminal
may open `sh`, which can't read a password without showing it, so this runs in `bash`, and the password goes when it
ends:

```bash
bash -c 'read -rs -p "Password for deskzo.deskzo.com: " ADMIN_PASSWORD && echo && export ADMIN_PASSWORD && ADMIN_EMAIL=you@deskzo.com ADMIN_NAME="Your Name" npm run db:bootstrap'
```

### 5. Scheduled Tasks

On the application, under **Scheduled Tasks**, add three:

| Name | Command | Frequency |
|---|---|---|
| Marketing | `node deploy/scheduler.mjs once marketing` | `*/5 * * * *` |
| Backups | `node deploy/scheduler.mjs once backup` | `*/15 * * * *` |
| Platform | `node deploy/scheduler.mjs once platform` | `0 * * * *` |


Press **Execute Now** on each; each should log `200`. The platform worker isn't one of them: it runs all the time inside the application (`DESKZO_WORKER=in-app`, step 3). Look for `[worker]` lines in the application's logs after a deploy. Signups don't wait for it, because the signup form starts one itself.

An installation set up before 18 Oct 2026 has a fourth Scheduled Task, **Worker** (`node_modules/.bin/tsx scripts/platform-worker.ts --once`, every five minutes). Add `DESKZO_WORKER=in-app` to the application's variables, redeploy, check the worker's lines in the logs, then delete that task: two workers do no harm (each workspace is worked under a lease), but one is enough.

### 6. Check

- https://www.deskzo.com: the website. `deskzo.com` serves it too.
- https://admin.deskzo.com: the console.
- https://deskzo.deskzo.com: your workspace.

**Don't open signups yet.** A new customer's address, like `acme.deskzo.com`, has no certificate until phase 2.

### 7. Backups off the server, and the clock

Everything above keeps backups and logs on this one VM. In the console, **Settings › Backups & logs**: an Azure storage account in Central India (a container, and a SAS token on it with read, add, create, write, delete and list), **Check connection**, **Save** — runbook §4.1. Turn on soft delete and versioning for blobs in the storage account, so a deletion can be undone. The platform worker copies the backups within the hour, and the control plane's dump and the logs that night; the first restore drill runs the next early morning (or press **Run a drill**). Put the storage account's address and a second, read-only SAS token in the break-glass entry with `PLATFORM_MASTER_KEY`.

On the VM, point chrony at India's time servers (runbook §14.2) — CERT-In asks for it, and the same page shows how far off the clock is.

## Phase 2 — a certificate for every workspace

Traefik can get a wildcard certificate only through Let's Encrypt's DNS challenge, by writing a TXT record through
your DNS provider's API. Openprovider's API is open to reseller accounts only, and would need your account's
username and password. So move deskzo.com's DNS to **Cloudflare**, which is free. The domain stays registered at
Openprovider.

1. **Cloudflare:** add the site `deskzo.com` (Free plan). Make sure there are two records, an A record for `@` and one for `*`, both to the server's IP. Both must be **DNS only, a grey cloud, not proxied**, for now. Customers' own domains (below) need the `*` record proxied later.
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

## Customers' own domains

A workspace can be reached at an address of its own, like `erp.acme.com`, as well as `acme.deskzo.com` (Settings ›
Domain). Its owner adds two records at their DNS provider: a TXT record that proves the domain is theirs, and a CNAME
to `acme.deskzo.com`.

deskzo.com's records are proxied by Cloudflare, so Cloudflare answers every request for those addresses. It refuses
an address on a domain outside Cloudflare with **Error 1001** until that address is a *custom hostname* of the
deskzo.com zone, which is also what gives it an HTTPS certificate. Once Cloudflare is connected in the console, Deskzo
does that itself: it adds the address to Cloudflare as soon as its records check out, puts it live when Cloudflare has
issued its certificate, and removes it from Cloudflare when it is removed from the workspace. Cloudflare charges
nothing for the first 100 addresses, then $0.10 a month for each.

Set it up once:

1. **Cloudflare → deskzo.com → DNS.** The `*` record must be **proxied** (an orange cloud): Cloudflare only serves a
   custom hostname that points at a proxied name. Add an A record named `origin` to the server's IP, also proxied.
2. **SSL/TLS → Custom Hostnames.** Enable Cloudflare for SaaS. Set the **Fallback Origin** to `origin.deskzo.com` and
   wait until it says Active.
3. **SSL/TLS → Overview.** If the mode is **Full (strict)**, Cloudflare would refuse the server's certificate for a
   customer's address with Error 526, since the server holds certificates only for deskzo.com. Under **Rules →
   Configuration Rules**, create a rule: *Custom filter expression*, field **Hostname**, operator **does not contain**,
   value `deskzo.com`; then **SSL → Full**. deskzo.com's own addresses stay on Full (strict).
4. **An API token:** My Profile → API Tokens → Create Token → **Create Custom Token**. Permissions: **Zone → SSL and
   Certificates → Edit**. Zone Resources: **Include → Specific zone → deskzo.com**. Copy the token, which Cloudflare
   shows once.
5. **Coolify: every address to the app.** Traefik only hands the app the addresses its rules name. On the application,
   with **Readonly labels** off, find the line ending `.service=…` in the `https` router's labels and note the name
   after the `=`. Then add these five lines, with that name in the last one, and **Redeploy**:
   ```
   traefik.http.routers.deskzo-own-domains.rule=HostRegexp(`.+`)
   traefik.http.routers.deskzo-own-domains.entryPoints=https
   traefik.http.routers.deskzo-own-domains.priority=1
   traefik.http.routers.deskzo-own-domains.tls=true
   traefik.http.routers.deskzo-own-domains.service=<the name>
   ```
   Priority 1 means it only catches addresses no other rule on the server names, so other applications on this
   server are untouched. The app itself answers an address it doesn't know with "No such workspace".
6. **Console → Settings → Custom domains → Cloudflare for SaaS.** Add the **zone id** (deskzo.com's Overview page,
   under API) and the **API token**, then press **Check connection**. It should say the addresses are served through
   `origin.deskzo.com`.
7. When it does, switch on **Offer custom domains to workspaces**, if you want owners to add their own. Staff can add
   one from a workspace's page either way.

An address that was added before Cloudflare was connected goes onto Cloudflare at its next check, so press **Check
now** on it. A certificate usually comes within a few minutes, and the page says "HTTPS certificate being issued"
meanwhile. A domain whose CAA records name other certificate authorities gets no certificate until it allows
Cloudflare's.

With the proxy on, Cloudflare's own limits apply to every address: an upload of at most 100 MB, and an answer within
100 seconds.

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
4. **On the Deskzo application → Environment Variables,** add, then **Redeploy**:

```ini
INBOUND_MAIL_DOMAIN=tickets.deskzo.com
INBOUND_MAIL_SECRET=<the secret from step 2>
```

5. **One routing rule per workspace.** Cloudflare allows a catch-all only on the apex domain, not on
   `tickets.deskzo.com`, so each helpdesk address needs its own rule (owner, 15 Oct 2026: kept to one address per
   workspace rather than a separate tickets domain). For each workspace that uses support email: **Email Routing →
   Routing rules → Custom addresses → Create address**, address `<workspace>@tickets.deskzo.com` with the
   workspace's own name typed in place of `<workspace>` — `wroffy` for wroffy.deskzo.com, the address its Settings →
   Support email shows — action *Send to a Worker*, destination `deskzo-inbound-email`. Without the rule,
   Cloudflare itself bounces the email with "550 5.1.1 Address does not exist", and it never reaches Deskzo.
   Cloudflare allows 200 rules per domain. Past that, a separate domain for tickets (its apex catch-all to the same
   worker, and `INBOUND_MAIL_DOMAIN` set to it) or one address with Cloudflare's plus-addressing is needed.
   Seen on 15 Oct 2026: deskzo.com's own *Catch-all* rule, set to Drop, also dropped mail to
   `tickets.deskzo.com` addresses with no rule of their own. Set to *Send to a Worker* → `deskzo-inbound-email`
   instead, it may serve every workspace with no rule each — and it never sees deskzo.com's own mail, whose MX is
   Microsoft 365. Try it with one test email to a workspace without a rule before relying on it.
6. **Check:** in Deskzo's own workspace, Settings → Support email now shows `deskzo@tickets.deskzo.com`. Add its
   rule (step 5), then send it an email from an address that is a contact: a ticket opens, and the acknowledgement
   arrives. From any other address, the email waits in Helpdesk → Support inbox. An address with a rule but no
   workspace behind it bounces with Deskzo's "No helpdesk answers at this address."

### Where replies go out from

Every reply and acknowledgement goes out as "<Company> Support". Each workspace chooses the mail that sends it
under Settings → Support email (src/lib/support-mail/reply-from.ts):

- **Deskzo's mail** (the default): the account Settings › Mail names for **Support** mail, else the default's.
  - From that account's address, with Reply-To the workspace's helpdesk address, so the customer's answer comes back
    to the ticket.
  - Or from the helpdesk address itself, `wroffy@tickets.deskzo.com`, once the console's **Helpdesk replies** switch
    (Settings › Mail) is on — see below.
- **The company's mail server**: Settings › Mail & messaging's transactional route in the workspace — the one
  documents use. From the support address the company gives (`support@wroffy.com`). Answers go to the helpdesk
  address until an email forwarded from that address has arrived, then to the address itself. When the server isn't
  set up, or refuses a reply, the reply goes through Deskzo's mail and the ticket says why.

**Sending from the helpdesk address**, as Zendesk and Freshdesk do, needs the Support account's mail service allowed
to send for `tickets.deskzo.com`. Microsoft 365 can't; Amazon SES, SendGrid, Mailgun, Brevo, Postmark and Elastic
Email can, once the domain is verified with them:

1. In the service, add `tickets.deskzo.com` as a sending domain (in SES, a verified `deskzo.com` covers it too).
   Add the DKIM records it gives you in Cloudflare, as *DNS only*.
2. `tickets.deskzo.com` already has Cloudflare's SPF record (`v=spf1 include:_spf.mx.cloudflare.net ~all`). Add the
   service's include to that same record — one SPF record per name, never two.
3. Once the service shows the domain as verified, turn on **Settings › Mail → Helpdesk replies** in the console and
   send a reply from a test ticket. If the service still refuses the address, that reply goes from the account's own
   address and its ticket says so.

## Releases

Push to `main`. If automatic deployment is on, Coolify builds and starts the new version, then runs the
post-deployment migrations. Otherwise press **Redeploy**. Watch the deployment log for `tenants:migrate`: a workspace
whose migration fails is held at the maintenance page, and the console's Migrations page says why (runbook §3).

A release that adds to a page published from the website CMS can't change that page by itself: the CMS's copy is
what the site shows. Such a release comes with a script, run once in the application's **Terminal** after it deploys —
each does nothing when there is nothing to do, and leaves alone a page with changes someone hasn't published yet:

- `npm run site:home-products` — the product strip on the home page (24 Oct 2026).

## Not covered here

- **PgBouncer** (runbook §7): one app container keeps at most 70 database connections, inside the 200 set in step 2.
- **More app containers.** Run several only once PgBouncer is in front.
- The rest of the runbook's checklist (§8) before the first paying customer.
