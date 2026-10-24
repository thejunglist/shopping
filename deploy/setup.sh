#!/usr/bin/env bash
# One-time setup for the Debian/Ubuntu LXC container. Run as root, from a
# checkout of this repository:
#
#   sudo bash deploy/setup.sh
#
# Safe to re-run (for example after changing backup.sh or the unit files).
# It does NOT install the GitHub runner or Tailscale; see docs/deployment.md.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# sqlite3 is the CLI used by the backup script. (No compiler needed: the
# better-sqlite3 prebuilt binaries cover linux x64 and arm64 on glibc.)
apt-get install -y -qq curl ca-certificates git sqlite3

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1)" != "v22" ]]; then
  echo "==> Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

echo "==> Creating users"
# Service user: runs the app, owns the database and backups. No login.
id shopping >/dev/null 2>&1 || useradd --system --home-dir /var/lib/shopping --shell /usr/sbin/nologin shopping
# Deploy user: runs the GitHub Actions runner. Can write releases, nothing more.
id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash runner

echo "==> Creating directories"
install -d -o runner -g runner -m 755 /opt/shopping /opt/shopping/releases
install -d -o shopping -g shopping -m 750 /var/lib/shopping /var/backups/shopping

echo "==> Installing backup script and systemd units"
# Root-owned, so the runner user cannot change what it is allowed to run as `shopping`.
install -o root -g root -m 755 "$here/backup.sh" /usr/local/bin/shopping-backup
install -m 644 "$here/shopping.service" "$here/shopping-backup.service" "$here/shopping-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable shopping.service shopping-backup.timer
systemctl start shopping-backup.timer

echo "==> Installing sudoers rule"
tmp="$(mktemp)"
cp "$here/sudoers-shopping-deploy" "$tmp"
visudo -cf "$tmp"
install -o root -g root -m 440 "$tmp" /etc/sudoers.d/shopping-deploy
rm -f "$tmp"

cat <<'EOF'

Done. Next steps (see docs/deployment.md):
  1. Install and register the GitHub Actions runner as the `runner` user,
     with the label `shopping`.
  2. Install Tailscale and run: tailscale serve --bg 3000
  3. Push to main; the pipeline does the first deploy.
EOF
