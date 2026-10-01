#!/bin/sh
# Prints a fresh set of the platform's secrets, as KEY=value lines to paste into a hosting panel's
# environment variables (Coolify: Environment Variables → Developer view). Once, for a new server:
# running it again prints different values, and PLATFORM_MASTER_KEY must never change once in use.
#   sh deploy/make-secrets.sh
set -eu
b64() { openssl rand -base64 32 | tr -d '\n'; }
hex() { openssl rand -hex "$1"; }
cat <<EOF
AUTH_SECRET=$(b64)
PLATFORM_MASTER_KEY=$(b64)
MARKETING_TICK_SECRET=$(hex 32)
BACKUP_TICK_SECRET=$(hex 32)
PLATFORM_TICK_SECRET=$(hex 32)
EOF
echo "Copy PLATFORM_MASTER_KEY to two safe places offline before using it — without it no workspace can be read again." >&2
