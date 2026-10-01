#!/usr/bin/env bash
# Makes .env from env.example, with every secret generated here. Once, before the first deploy.
#   ./make-env.sh
set -euo pipefail
cd "$(dirname "$0")"

if [ -e .env ]; then
  echo ".env already exists — leaving it alone. (Its PLATFORM_MASTER_KEY must never change.)" >&2
  exit 1
fi

b64() { openssl rand -base64 32 | tr -d '\n'; }
hex() { openssl rand -hex "$1"; }

sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(hex 24)|" \
  -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(b64)|" \
  -e "s|^PLATFORM_MASTER_KEY=.*|PLATFORM_MASTER_KEY=$(b64)|" \
  -e "s|^MARKETING_TICK_SECRET=.*|MARKETING_TICK_SECRET=$(hex 32)|" \
  -e "s|^BACKUP_TICK_SECRET=.*|BACKUP_TICK_SECRET=$(hex 32)|" \
  -e "s|^PLATFORM_TICK_SECRET=.*|PLATFORM_TICK_SECRET=$(hex 32)|" \
  env.example > .env
chmod 600 .env

cat <<'DONE'
Made .env, with its secrets generated.

Before deploying:
  1. Copy PLATFORM_MASTER_KEY out of .env to two safe places offline (a password manager, and
     paper in a sealed envelope). Without it no workspace can ever be read again.
  2. Set ACME_EMAIL, and the mail settings (PLATFORM_SMTP_URL, PLATFORM_SALES_EMAIL):
       nano .env
Then: ./deploy.sh
DONE
