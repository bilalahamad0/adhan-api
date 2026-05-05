#!/bin/bash
#
# Manual operator deploy script for Adhan Media Caster.
# NOTE: The auto-updater (BuildManager) is the source-of-truth CI path.
# This script is for manual intervention only (initial setup, recovery, etc.).
#

set -euo pipefail

# --- CONFIGURATION ---
REPO_ROOT="$HOME/adhan-api"
PROJECT_DIR="$REPO_ROOT/media-caster"
ENV_FILE="$PROJECT_DIR/.env"
BRANCH="main"

echo "Starting Adhan Media Caster manual deployment..."

# 1. Enter Repo
cd "$REPO_ROOT" || exit

# 2. Drift Report — show what the Pi changed locally before we overwrite
echo ""
echo "--- Drift Report (local changes on this device) ---"
git status --short -uall || true
echo "---------------------------------------------------"
echo ""

# 3. Normalize file mode tracking to prevent chmod-only false positives
git config --local core.fileMode false

# 4. Mirror GitHub exactly (fetch + hard reset replaces git pull to avoid merge conflicts)
echo "Fetching latest from origin/$BRANCH..."
git fetch origin "$BRANCH" --quiet
echo "Resetting working tree to match origin/$BRANCH..."
git reset --hard "origin/$BRANCH"

# 5. Handle .env Rescue
if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$REPO_ROOT/audio-caster/.env" ]; then
        echo "Rescuing .env from old audio-caster directory..."
        mv "$REPO_ROOT/audio-caster/.env" "$ENV_FILE"
    else
        echo "WARNING: .env file not found in media-caster! Ensure it exists."
    fi
fi

# 6. Install Dependencies
echo "Installing production dependencies..."
cd "$REPO_ROOT" && npm ci --omit=dev --no-audit --no-fund
cd "$PROJECT_DIR" && npm ci --omit=dev --no-audit --no-fund

# 7. Post-deploy drift check
echo ""
echo "--- Post-deploy drift check ---"
cd "$REPO_ROOT"
git status --short -uall || true
echo "-------------------------------"

# 8. Restart Services
echo "Restarting orchestration engine via PM2..."
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo "Deployment complete. Uptime check:"
pm2 status
