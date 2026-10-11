#!/usr/bin/env bash
# Install a profile from this repository; stop affected consumers before upgrade.
set -euo pipefail
umask 077
[[ $# -le 1 ]] || { echo 'usage: bash scripts/deploy.sh [profile]' >&2; exit 1; }
PROFILE="${1:-default}"
[[ "$PROFILE" =~ ^[a-zA-Z0-9_-]{1,32}$ ]] || { echo 'Invalid profile' >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
mkdir -p "$HOME/wechat-muse-bridge/bridge"
BASE="$(realpath -e "$HOME/wechat-muse-bridge/bridge")"
TARGET="$BASE"; UNIT=wechat-muse-bridge.service
if [[ "$PROFILE" != default ]]; then
  [[ ! -L "$BASE/profiles" && ! -L "$BASE/profiles/$PROFILE" ]] || { echo 'Redirected profile directory' >&2; exit 1; }
  TARGET="$BASE/profiles/$PROFILE"; UNIT="wechat-muse-bridge-$PROFILE.service"
fi
# Shared build/dependencies may be used by any profile. Refuse active consumers.
for pidfile in "$BASE/bridge.pid" "$BASE"/profiles/*/bridge.pid "$ROOT/bridge/bridge.pid"; do
  [[ -f "$pidfile" ]] || continue
  consumer_pid="$(cat "$pidfile")"
  if [[ "$consumer_pid" =~ ^[0-9]+$ ]] && kill -0 "$consumer_pid" 2>/dev/null; then
    echo 'Stop the consumer recorded in bridge.pid before deployment' >&2; exit 1
  fi
done
for cmdline in /proc/[0-9]*/cmdline; do
  while IFS= read -r arg; do
    if [[ "$arg" == "$BASE/bridge.js" || "$arg" == "$BASE/profiles/"*/bridge.js || "$arg" == "$ROOT/bridge/bridge.js" ]]; then
      echo 'Stop bridge consumers before changing runtime/dependencies' >&2; exit 1
    fi
  done < <(tr '\0' '\n' < "$cmdline" 2>/dev/null || true)
done
mkdir -p "$TARGET"/{media,logs,state}
TARGET="$(realpath -e "$TARGET")"
[[ "$PROFILE" == default || "$TARGET" == "$BASE/profiles/$PROFILE" ]] || { echo 'Profile escaped base directory' >&2; exit 1; }
for file in bridge.js package.json package-lock.json vendor config.json dist node_modules state media logs; do
  [[ ! -L "$TARGET/$file" ]] || { echo "Refusing symlink at $TARGET/$file" >&2; exit 1; }
done
cd "$ROOT/bridge"
npm ci --no-audit --no-fund
npm run build
"${NODE_BIN:-node}" --check "$ROOT/bridge/bridge.js"
if [[ "$(pwd -P)" != "$TARGET" ]]; then
  cp bridge.js package.json package-lock.json tsconfig.vendor.json "$TARGET/"
  mkdir -p "$TARGET/vendor" "$TARGET/dist"
  cp -a vendor/. "$TARGET/vendor/"
  cp -a dist/. "$TARGET/dist/"
  # Each profile owns its dependencies; no mutable link into another profile.
  (cd "$TARGET" && npm ci --no-audit --no-fund)
fi
if [[ ! -f "$TARGET/config.json" ]]; then cp config.example.json "$TARGET/config.json"; fi
chmod 600 "$TARGET/config.json"
chmod 700 "$TARGET" "$TARGET/state" "$TARGET/media" "$TARGET/logs"
sha256sum "$TARGET/bridge.js"
echo "Edit $TARGET/config.json; then node $ROOT/scripts/qr-login.mjs --profile $PROFILE"
echo "Edit $ROOT/wechat-muse-bridge.service for this user/profile, install as $UNIT, then start it."
