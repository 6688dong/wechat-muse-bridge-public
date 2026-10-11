#!/usr/bin/env bash
# Create an independent family profile without touching the owner's login.
set -euo pipefail
[[ $# -eq 1 ]] || { echo 'usage: bash scripts/add-account.sh <name>' >&2; exit 1; }
PROFILE="$1"
[[ "$PROFILE" =~ ^[a-zA-Z0-9_-]{1,32}$ && "$PROFILE" != default ]] || { echo 'Invalid family profile name' >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TARGET="$HOME/wechat-muse-bridge/bridge/profiles/$PROFILE"
[[ ! -e "$TARGET" && ! -L "$TARGET" ]] || { echo 'Profile already exists; refusing overwrite' >&2; exit 1; }
bash "$ROOT/scripts/deploy.sh" "$PROFILE"
echo 'Create a NEW Muse conversation with muse-cli session-start and set weixin_session_id.'
echo 'Use the family member’s WeChat for this profile’s QR. Keep the owner’s credentials.'
echo 'Profiles share Muse credentials/permissions/billing; only conversations and directories are separated.'
