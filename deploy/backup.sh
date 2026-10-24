#!/usr/bin/env bash
# Take a consistent backup of the SQLite database using SQLite's online backup
# (safe while the app is running, unlike copying the file).
#
#   shopping-backup [label]
#
# Installed by deploy/setup.sh as /usr/local/bin/shopping-backup (root-owned),
# and run as the `shopping` user by the nightly timer and by deploy.sh.
# Writes gzip-compressed copies to $BACKUP_DIR and deletes ones older than
# $RETENTION_DAYS. Does nothing if there is no database yet (first deploy).
set -euo pipefail

db="${DB_PATH:-/var/lib/shopping/shopping.db}"
dir="${BACKUP_DIR:-/var/backups/shopping}"
days="${RETENTION_DAYS:-30}"
label="${1:-nightly}"

[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad label: $label" >&2; exit 1; }

if [[ ! -f "$db" ]]; then
  echo "No database at $db yet; nothing to back up."
  exit 0
fi

mkdir -p "$dir"
dest="$dir/shopping-$(date +%Y%m%d-%H%M%S)-$label.db"
# Never leave an uncompressed copy behind, whatever fails below.
trap 'rm -f "$dest"' EXIT

sqlite3 "$db" ".backup '$dest'"
sqlite3 "$dest" 'PRAGMA integrity_check;' | grep -qx ok || { echo "backup failed integrity check" >&2; exit 1; }
# -f: two backups with the same label in the same second overwrite each other.
gzip -f "$dest"
echo "Wrote $dest.gz"

find "$dir" -maxdepth 1 -name 'shopping-*.db.gz' -mtime +"$days" -delete
