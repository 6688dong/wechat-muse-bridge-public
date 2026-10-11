#!/usr/bin/env bash
# Read-only local evidence. A human WeChat receipt is also required.
set -euo pipefail
if [[ $# -eq 1 ]]; then PROFILE=default; MARKER="$1"
elif [[ $# -eq 2 ]]; then PROFILE="$1"; MARKER="$2"
else echo 'usage: bash scripts/verify.sh [profile] <marker>' >&2; exit 1; fi
[[ "$PROFILE" =~ ^[a-zA-Z0-9_-]{1,32}$ ]] || { echo 'Invalid profile' >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BASE="$HOME/wechat-muse-bridge/bridge"
DIR="$BASE"; UNIT=wechat-muse-bridge.service
if [[ "$PROFILE" != default ]]; then DIR="$BASE/profiles/$PROFILE"; UNIT="wechat-muse-bridge-$PROFILE.service"; fi
BASE="$(realpath -e "$BASE")"; DIR="$(realpath -e "$DIR")"
if [[ "$PROFILE" != default && "$DIR" != "$BASE/profiles/$PROFILE" ]]; then
  echo 'Profile path must not redirect to another directory' >&2; exit 1
fi
echo "Profile: $PROFILE"
sha256sum "$DIR/bridge.js"
systemctl is-active "$UNIT" || true
echo 'Consumer candidates (verify exactly one for this profile):'
for cmdline in /proc/[0-9]*/cmdline; do
  if tr '\0' '\n' < "$cmdline" 2>/dev/null | grep -Fxq -- "$DIR/bridge.js"; then
    echo "${cmdline%/cmdline}"
  fi
done
"${NODE_BIN:-node}" "$ROOT/scripts/verify-record.mjs" "$DIR/tasks.db" "$MARKER"
echo 'Acceptance also requires the actual reply received in WeChat and the reviewed deployed hash.'
