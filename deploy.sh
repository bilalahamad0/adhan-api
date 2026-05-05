#!/bin/bash

# --- CONFIGURATION ---
REPO_ROOT="$HOME/adhan-api"
PROJECT_DIR="$REPO_ROOT/media-caster"
ENV_FILE="$PROJECT_DIR/.env"
BACKUP_DIR="$HOME/adhan-api-backups"

echo "🚀 Starting Adhan Media Caster Deployment..."

# 1. Enter Repo
cd "$REPO_ROOT" || exit

# 2. Safety Stash
# This protects local Pi-side tweaks (like your boot.js fix) from blocking the pull
echo "📦 Stashing local environmental changes..."
git stash

# 3. Update Codebase
echo "📥 Pulling latest changes from GitHub (main)..."
git pull origin main

# 4. Handle Directory Rename / .env Rescue
# If .env is missing in media-caster but exists in the old audio-caster, move it.
if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$REPO_ROOT/audio-caster/.env" ]; then
        echo "🛡️ Rescuing .env from old audio-caster directory..."
        mv "$REPO_ROOT/audio-caster/.env" "$ENV_FILE"
    else
        echo "⚠️ WARNING: .env file not found in media-caster! Ensure it exists."
    fi
fi

# 5. Install Dependencies
echo "🏗️ Installing production dependencies..."
cd "$PROJECT_DIR" || exit
npm install --omit=dev

# 6. Apply Local Tweaks (Optional)
# If you want to bring back those specific Pi tweaks after the pull
# echo "🔧 Re-applying local stashed changes..."
# git stash pop

# 7. Restart Services
echo "🔄 Restarting orchestration engine via PM2..."
cd "$REPO_ROOT"
# We use 'pm2 start' with ecosystem to ensure path re-indexing
pm2 delete all
pm2 start ecosystem.config.cjs
pm2 save

echo "✅ Deployment Complete! Uptime check:"
pm2 status
