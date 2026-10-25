#!/usr/bin/env bash
# Build a release tarball from an already-built checkout.
#
#   deploy/bundle.sh <version> [output.tar.gz]
#
# Layout inside the tarball (it becomes /opt/shopping/releases/<version>/):
#   server/   src, migrations, scripts, package.json, package-lock.json (no node_modules)
#   public/   the built frontend (web/dist)
#   VERSION   the version string, reported by /healthz
#
# node_modules is deliberately not bundled: better-sqlite3 is a native module,
# so deploy.sh runs `npm ci --omit=dev --ignore-scripts` on the machine that
# will run it, which picks the prebuilt binary matching that OS and CPU.
set -euo pipefail

version="${1:?usage: bundle.sh <version> [output.tar.gz]}"
out="${2:-release.tar.gz}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -f "$root/web/dist/index.html" ]]; then
  echo "web/dist is missing: run 'npm run build' first" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/server" "$stage/public"
cp -r "$root/server/src" "$root/server/migrations" "$root/server/scripts" "$stage/server/"
cp "$root/server/package.json" "$root/server/package-lock.json" "$stage/server/"
cp -r "$root/web/dist/." "$stage/public/"
printf '%s\n' "$version" > "$stage/VERSION"

# mktemp -d creates the directory as 0700 and tar records that for ".", so
# extracting the bundle as the runner user would leave the release directory
# unreadable by the `shopping` service user. Make it traversable first.
chmod 755 "$stage"
tar -C "$stage" -czf "$out" .
echo "wrote $out (version $version)"
