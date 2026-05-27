#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

DEPLOY_DIR="${PI_WEB_DEPLOY_DIR:-/home/alone/.local/share/pi-web-fork}"
SERVICE_NAME="${PI_WEB_SERVICE_NAME:-pi-web.service}"

if [[ "$DEPLOY_DIR" == "$REPO_DIR" ]]; then
  echo "Refusing to deploy into the source directory: $DEPLOY_DIR" >&2
  exit 1
fi

mkdir -p "$DEPLOY_DIR"

echo "Syncing source:"
echo "  from: $REPO_DIR/"
echo "  to:   $DEPLOY_DIR/"

rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude .next \
  --exclude volumes \
  --exclude tsconfig.tsbuildinfo \
  "$REPO_DIR/" \
  "$DEPLOY_DIR/"

cd "$DEPLOY_DIR"

echo "Installing dependencies in $DEPLOY_DIR"
npm ci

echo "Building production app in $DEPLOY_DIR"
npm run build

echo "Restarting systemd user service: $SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"

echo "Service status:"
systemctl --user --no-pager --full status "$SERVICE_NAME"
