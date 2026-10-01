# Deskzo One on an Azure VM

One Ubuntu VM runs everything, in Docker (`deploy/azure/`):

| Service | What |
|---|---|
| `caddy` | HTTPS for every address. Each certificate comes from Let's Encrypt the first time a name is visited, and only for names the app says are its own (`/api/platform/tls-ask`) |
| `app` | Every workspace, the website (`www.`), the console (`admin.`), the CMS (`cms.`) and the partner portal (`partners.`) |
| `worker` | Sets new workspaces up; keeps the warm pool full |
| `scheduler` | The three scheduled calls (runbook §1), made inside the server |
| `postgres` | PostgreSQL 16: the control plane, the reference data and one database per workspace |

What each part does, and what to do when something breaks, is the [runbook](runbook.md).

## 1. The VM

In the Azure portal, **Create a virtual machine**:

| Setting | Value |
|---|---|
| Region | **Central India** (customers' data stays in India) |
| Image | **Ubuntu Server 24.04 LTS**, x64 |
| Size | **Standard_B4ms** (4 vCPUs, 16 GiB) to start. Building the image needs about 8 GB of memory, so not smaller. Move to a D-series (D4as_v5) once there is steady traffic: B-series CPU is burstable |
| Authentication | SSH public key; user `azureuser` |
| OS disk | Premium SSD, **128 GiB** |
| Public IP | New, **Static** |
| Inbound ports | SSH (22) **from your own IP only**; HTTP (80) and HTTPS (443, TCP and UDP) from anywhere |
| Backup | **Enable Azure Backup**, daily. It keeps the whole disk — databases, backups, uploads — off the VM |

Note the VM's public IP address.

## 2. DNS for deskzo.com

Wherever deskzo.com's DNS is managed, two records, both to the VM's IP:

| Type | Name | Value |
|---|---|---|
| A | `@` | the VM's IP |
| A | `*` | the VM's IP |

The `*` record covers `www`, `admin`, `cms`, `partners` and every workspace (`acme.deskzo.com`). Remove any other `www` record. Wait until both answer before the first deploy, because certificates need them:

```bash
nslookup www.deskzo.com
```

```bash
nslookup anything.deskzo.com
```

## 3. Prepare the VM

```bash
ssh azureuser@<the VM's IP>
```

```bash
sudo git clone https://github.com/schauhan1992/deskzo.git /opt/deskzo && sudo chown -R $USER /opt/deskzo
```

```bash
sudo /opt/deskzo/deploy/azure/setup-vm.sh
```

That installs Docker, a swap file, the firewall and the nightly database dump. Then sign out and back in, so your user can run Docker.

## 4. Settings

```bash
cd /opt/deskzo/deploy/azure && ./make-env.sh
```

It writes `.env` with every secret generated. Then:

1. **Copy `PLATFORM_MASTER_KEY` from `.env` to two safe places offline** — a password manager, and paper in a sealed envelope. Without it no workspace can ever be read again (runbook §4).
2. Fill in the rest with `nano .env`:
   - `ACME_EMAIL` — where Let's Encrypt writes about certificates.
   - `PLATFORM_SMTP_URL` — the platform's mail: signup codes, setup links, billing reminders. Azure blocks port 25, so use a provider on 587 or 465: `smtp://user:password@smtp.office365.com:587` or `smtps://user:password@smtp.zoho.in:465`. An `@` in the user name is written `%40`.
   - `PLATFORM_SALES_EMAIL` — where the website's contact form is mailed.
   - `PLATFORM_CONSOLE_IP_ALLOWLIST` — your office's and home's addresses, so nobody else reaches the console's sign-in.

## 5. First deploy

```bash
./deploy.sh
```

The first build takes ten minutes or so. Then, once only:

```bash
./first-run.sh you@deskzo.com "Your Name"
```

That registers Deskzo's own workspace (`deskzo.deskzo.com`), loads the product catalogue and makes you the console's owner. It prints a setup link, and emails it too once mail is set up. Open it to choose your password and turn on two-factor sign-in at **https://admin.deskzo.com**.

The website is at **https://www.deskzo.com**; `deskzo.com` sends people there. The first visit to each address takes a few seconds while its certificate is fetched.

### Your own workspace's owner

Your password is typed into the prompt, not the command line, so it stays out of the shell's history:

```bash
read -rs -p "Password for deskzo.deskzo.com: " ADMIN_PASSWORD && export ADMIN_PASSWORD
```

```bash
docker compose run --rm -e ADMIN_EMAIL=you@deskzo.com -e ADMIN_NAME="Your Name" -e ADMIN_PASSWORD ops npm run db:bootstrap; unset ADMIN_PASSWORD
```

Then sign in at **https://deskzo.deskzo.com**.

## 6. Before the first customer

Work through the runbook's checklist (§8). On this setup:

- **The website:** invite the CMS's first admin with `docker compose run --rm ops npm run cms:user -- create --email … --name … --role ADMIN`. Publish the pages with `docker compose run --rm ops npm run site:seed-pages`.
- **Reference data:** load PIN codes and world places in the console → Reference data.
- **Billing:** enter the gateways' keys in the console → Billing, test mode first, and run one checkout end to end (runbook §2 for the webhooks).
- **Customers' own domains:** certificates for them are now automatic, so the console's **Offer custom domains** setting can go on.
- **Remove the temporary "Reset all data" button** from the code. `ENABLE_DATA_RESET` stays unset here.

## Every release

```bash
cd /opt/deskzo/deploy/azure && ./deploy.sh
```

It pulls `main`, builds the image, migrates every database before the new code serves (runbook §3), then restarts the services.

## Everyday

| To | Run, in `/opt/deskzo/deploy/azure` |
|---|---|
| Follow a service's log | `docker compose logs -f app` (or `worker`, `scheduler`, `caddy`) |
| See what is running | `docker compose ps` |
| Run a platform command | `docker compose run --rm ops npm run platform:tenant -- list` |
| Restart the app | `docker compose restart app` |
| Dump the databases now | `sudo ./backup.sh` (nightly at 02:30 anyway; in `/var/backups/deskzo`, 14 days) |

## Not in this setup yet

- **PgBouncer** (runbook §7). One app process uses at most 70 of PostgreSQL's 200 connections. Add PgBouncer before running more app processes.
- **Dumps off the VM.** Azure Backup keeps the disk. Copying `/var/backups/deskzo` to a storage account too, for example with `azcopy`, guards against losing the VM and its backups together.
- **More than one VM.** This is a single machine. The next step is Azure Database for PostgreSQL (Flexible Server): point the four database URLs in `docker-compose.yml` at it and drop the `postgres` service.
- **Very fast growth.** Let's Encrypt issues up to 50 new certificates a week for `deskzo.com` names, which means about 50 new workspaces a week. Past that, switch to one wildcard certificate (`*.deskzo.com`), which needs a Caddy build with your DNS provider's plugin.
