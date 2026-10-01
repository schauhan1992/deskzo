#!/usr/bin/env bash
# Once, on a new Ubuntu 24.04 VM, after cloning the repository to /opt/deskzo:
#   sudo /opt/deskzo/deploy/azure/setup-vm.sh
# Installs Docker, a swap file for the build, the firewall, and the nightly database dump.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run it with sudo." >&2; exit 1; }
user="${SUDO_USER:-root}"

echo "── Docker"
apt-get update
apt-get install -y docker.io docker-buildx docker-compose-v2 git ufw openssl
systemctl enable --now docker
usermod -aG docker "$user"

echo "── Swap: the image's build wants memory to spare"
if ! swapon --show | grep -q '^/swapfile'; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

echo "── Firewall: SSH, HTTP and HTTPS only (Azure's network security group must say the same)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "── Nightly database dump, 02:30, kept 14 days in /var/backups/deskzo"
install -d -m 700 /var/backups/deskzo
cat > /etc/cron.d/deskzo-backup <<'CRON'
30 2 * * * root /opt/deskzo/deploy/azure/backup.sh >> /var/log/deskzo-backup.log 2>&1
CRON

echo
echo "Done. Sign out and back in (so $user can run docker), then:"
echo "  cd /opt/deskzo/deploy/azure && ./make-env.sh"
