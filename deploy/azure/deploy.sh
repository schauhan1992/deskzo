#!/usr/bin/env bash
# Every release, the first included:
#   the latest code → the image → the migrations (before the new code serves) → every service.
#   ./deploy.sh              from GitHub's main
#   ./deploy.sh --no-pull    what is checked out now
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "No .env here — run ./make-env.sh first." >&2; exit 1; }
grep -q '^ACME_EMAIL=.\+' .env || { echo "Set ACME_EMAIL in .env first." >&2; exit 1; }

if [ "${1:-}" != "--no-pull" ]; then
  git -C ../.. pull --ff-only
fi

echo "── Building the image"
docker compose build app

echo "── The database"
docker compose up -d --wait postgres

echo "── Migrations: control plane, reference data, warm pool, then every workspace (runbook §3)"
docker compose run --rm ops npm run tenants:migrate

echo "── Starting"
docker compose up -d --remove-orphans app worker scheduler caddy

docker image prune -f >/dev/null
docker compose ps
