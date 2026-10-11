#!/usr/bin/env bash
# Restore this profile's code only. Keep the service stopped if validation fails.
set -euo pipefail
[[ $# -le 2 ]] || { echo 'usage: bash scripts/rollback.sh [profile] [backup-file]' >&2; exit 1; }
PROFILE="${1:-default}"; BACKUP="${2:-}"
[[ "$PROFILE" =~ ^[a-zA-Z0-9_-]{1,32}$ ]] || { echo 'Invalid profile' >&2; exit 1; }
BASE="$(realpath -e "$HOME/wechat-muse-bridge/bridge")"
DIR="$BASE"; UNIT=wechat-muse-bridge.service
if [[ "$PROFILE" != default ]]; then DIR="$BASE/profiles/$PROFILE"; UNIT="wechat-muse-bridge-$PROFILE.service"; fi
DIR="$(realpath -e "$DIR")"
[[ "$PROFILE" == default || "$DIR" == "$BASE/profiles/$PROFILE" ]] || { echo 'Redirected profile path' >&2; exit 1; }
EXPECTED_BACKUPS="$HOME/wechat-muse-bridge/backups/$PROFILE"
BACKUP_DIR="$(realpath -e "$EXPECTED_BACKUPS")"
[[ "$BACKUP_DIR" == "$(realpath -e "$HOME/wechat-muse-bridge")/backups/$PROFILE" ]] || { echo 'Redirected backup directory' >&2; exit 1; }
if [[ -z "$BACKUP" ]]; then
  shopt -s nullglob
  for candidate in "$BACKUP_DIR"/bridge.js.backup-*; do
    [[ -f "$candidate" ]] || continue
    if [[ -z "$BACKUP" || "$candidate" -nt "$BACKUP" ]]; then BACKUP="$candidate"; fi
  done
fi
[[ -n "$BACKUP" && -f "$BACKUP" ]] || { echo 'No profile backup found' >&2; exit 1; }
BACKUP="$(realpath -e "$BACKUP")"
[[ "$BACKUP" == "$BACKUP_DIR/"* ]] || { echo 'Backup is outside this profile' >&2; exit 1; }
[[ ! -L "$DIR/bridge.js" ]] || { echo 'Refusing a redirected runtime file' >&2; exit 1; }
STAGED="$(mktemp "$DIR/.rollback-XXXXXX.mjs")"
trap 'rm -f -- "$STAGED"' EXIT
cp -- "$BACKUP" "$STAGED"
"${NODE_BIN:-node}" --check "$STAGED"
sha256sum "$STAGED"
sudo systemctl stop "$UNIT"
mv -f -- "$STAGED" "$DIR/bridge.js"
sudo systemctl start "$UNIT"
sudo systemctl is-active "$UNIT"
echo 'Code restored. Verify one consumer and perform a fresh WeChat receipt test.'
