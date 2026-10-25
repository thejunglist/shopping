#!/usr/bin/env bash
# Deploy a release bundle on the home server. Runs as the `runner` user on the
# self-hosted GitHub Actions runner.
#
#   deploy/deploy.sh <version> <bundle.tar.gz>
#
# Steps: back up the database, unpack the release, install production
# dependencies, switch the `current` symlink, restart the service, and check
# /healthz reports the new version. If the check fails, switch back to the
# previous release and exit non-zero so the pipeline fails.
#
# Database migrations run when the service starts, so a bad migration shows up
# as a failed health check. Migrations are forward-only: rolling back the code
# does not undo schema changes. Keep migrations backward compatible, or restore
# the pre-deploy backup (see docs/deployment.md).
set -euo pipefail

version="${1:?usage: deploy.sh <version> <bundle.tar.gz>}"
bundle="${2:?usage: deploy.sh <version> <bundle.tar.gz>}"

root="${DEPLOY_ROOT:-/opt/shopping}"
port="${PORT:-3000}"
keep="${KEEP_RELEASES:-5}"
release="$root/releases/$version"

[[ "$version" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad version: $version" >&2; exit 1; }
[[ -f "$bundle" ]] || { echo "bundle not found: $bundle" >&2; exit 1; }

# The release that is live now, if any. Not `readlink -f` on its own: for a path
# that does not exist yet (the first deploy) it prints the path and succeeds, which
# made the old rollback "restore" a release called "current".
previous=""
if [[ -L "$root/current" ]]; then
  previous="$(readlink -f "$root/current")"
fi
# Redeploying the release that is already live: there is nothing older to fall back to.
if [[ "$previous" == "$release" ]]; then previous=""; fi

echo "==> Backing up the database"
sudo -n -u shopping /usr/local/bin/shopping-backup "pre-deploy-$version"

echo "==> Unpacking $version"
rm -rf "$release"
mkdir -p "$release"
tar -xzf "$bundle" -C "$release"
# The `shopping` service user must be able to enter this directory. Bundles built
# by older versions of bundle.sh carried mode 700 for it, so set it explicitly.
chmod 755 "$release"

echo "==> Installing production dependencies"
# --ignore-scripts: better-sqlite3 ships prebuilt binaries for linux x64/arm64,
# and without this flag npm tries to compile it with node-gyp anyway. It also
# means no dependency can run an install script on the server.
(cd "$release/server" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

switch_to() {
  # Atomic: create the new link beside the old one, then rename over it.
  ln -sfn "$1" "$root/current.new"
  mv -Tf "$root/current.new" "$root/current"
  sudo -n /usr/bin/systemctl restart shopping
}

# Show why a release did not come up. `systemctl status` needs no privileges; the
# journal is read through the one sudo rule in deploy/sudoers-shopping-deploy.
diagnose() {
  echo "---- systemctl status shopping" >&2
  systemctl status shopping --no-pager --lines=0 >&2 2>&1 || true
  echo "---- journalctl -u shopping (last 40 lines)" >&2
  sudo -n /usr/bin/journalctl -u shopping -n 40 --no-pager >&2 2>&1 \
    || echo "(could not read the journal here; on the server run: journalctl -u shopping -n 50)" >&2
}

healthy() {
  local body
  for _ in $(seq 1 30); do
    body="$(curl -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null || true)"
    if grep -q "\"version\":\"$1\"" <<<"$body"; then
      echo "$body"
      return 0
    fi
    sleep 1
  done
  return 1
}

echo "==> Switching to $version"
switch_to "$release"

echo "==> Checking /healthz"
if ! healthy "$version"; then
  echo "Health check failed for $version" >&2
  diagnose
  if [[ -n "$previous" && -d "$previous" ]]; then
    echo "==> Rolling back to $(basename "$previous")" >&2
    switch_to "$previous"
    if healthy "$(basename "$previous")"; then
      echo "Rolled back. The failed release is kept at $release for inspection." >&2
    else
      echo "Rollback health check also failed. Manual intervention needed." >&2
    fi
  else
    # First deploy: nothing to go back to. Drop the link so the next deploy
    # starts clean instead of treating this broken release as the previous one.
    rm -f "$root/current"
    echo "No previous release to roll back to. The failed release is kept at $release for inspection." >&2
  fi
  exit 1
fi

echo "==> Pruning old releases (keeping $keep)"
# Newest first; never delete the live release.
live="$(readlink -f "$root/current")"
ls -1dt "$root"/releases/*/ | tail -n +"$((keep + 1))" | while read -r old; do
  old="${old%/}"
  [[ "$(readlink -f "$old")" == "$live" ]] && continue
  rm -rf "$old"
done

echo "==> Deployed $version"
