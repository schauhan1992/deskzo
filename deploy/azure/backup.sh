#!/usr/bin/env bash
# Nightly (setup-vm.sh puts it in /etc/cron.d): a dump of the control plane and of every workspace's
# database, into /var/backups/deskzo/<date>/, kept 14 days. The reference database is left out — it is
# reloaded from its sources (runbook §4). These dumps are on the VM: Azure Backup of the VM, or a copy
# to storage elsewhere, is what keeps them if the VM itself is lost.
set -euo pipefail
cd "$(dirname "$0")"

dest="/var/backups/deskzo/$(date +%F)"
install -d -m 700 "$dest"
psql() { docker compose exec -T postgres psql -U deskzo -d postgres -Atc "$1"; }

for db in $(psql "select datname from pg_database where not datistemplate and datname not in ('postgres', 'deskzo_reference') order by 1"); do
  docker compose exec -T postgres pg_dump -U deskzo -Fc "$db" > "$dest/$db.dump"
done
docker compose exec -T postgres pg_dumpall -U deskzo --globals-only > "$dest/roles.sql"

find /var/backups/deskzo -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
echo "$(date -Is) dumped $(ls "$dest" | wc -l) files to $dest"
