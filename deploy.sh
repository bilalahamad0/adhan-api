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
# pm2 is a global install, not a repo dependency, so nothing in package.json
# keeps it current. Bump this on purpose; see "Managing pm2" in DEPLOYMENT_GUIDE_PI.md.
PM2_VERSION="7.0.4"

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

# 8. Check pm2 against PM2_VERSION: the global install, and the daemon that
# systemd actually runs. Warn only: upgrading restarts every app, so it is an
# operator step outside a prayer window, not a deploy step. Read files and
# systemd state only. Any pm2 command, even `pm2 --version`, starts a daemon
# when none is reachable, and that daemon would live outside the unit.
PM2_UNIT="pm2-$(whoami)"
PM2_PATH="$(command -v pm2 || true)"
PM2_INSTALLED="unknown"
if [ -n "$PM2_PATH" ]; then
    PM2_INSTALLED="$(node -p "require('$(dirname "$(readlink -f "$PM2_PATH")")/../package.json').version" 2>/dev/null || echo unknown)"
fi
PM2_SUPERVISED="yes"
if command -v systemctl >/dev/null; then
    # Read the pid file the unit itself tracks, and point step 9's pm2 commands at
    # the unit's PM2_HOME even if this shell's differs.
    PM2_PIDFILE="$(systemctl show -p PIDFile --value "$PM2_UNIT" 2>/dev/null || true)"
    PM2_PIDFILE="${PM2_PIDFILE:-${PM2_HOME:-$HOME/.pm2}/pm2.pid}"
    PM2_UNIT_HOME="$(dirname "$PM2_PIDFILE")"
    if [ -n "${PM2_HOME:-}" ] && [ "$PM2_HOME" != "$PM2_UNIT_HOME" ]; then
        echo "NOTE: this shell's PM2_HOME ($PM2_HOME) is not $PM2_UNIT's; using $PM2_UNIT_HOME."
    fi
    export PM2_HOME="$PM2_UNIT_HOME"
    # Hands the apps from a daemon outside systemd back to the unit. It is the same
    # line as in DEPLOYMENT_GUIDE_PI.md, and it is printed unexpanded so the operator's
    # shell fills it in. systemd-run keeps it going if the SSH session drops midway.
    PM2_HANDBACK='U=pm2-$(whoami); D=~/.pm2/dump.pm2; sudo systemd-run --unit=pm2-handback --collect --wait /bin/sh -c "cp -p $D $D.keep && systemctl stop $U; runuser -u $(whoami) -- env HOME='"'"'$HOME'"'"' PATH='"'"'$PATH'"'"' PM2_HOME='"'"'$HOME/.pm2'"'"' pm2 kill; cp -p $D.keep $D && systemctl start $U"'
    PM2_PID="$(cat "$PM2_PIDFILE" 2>/dev/null || true)"
    PM2_DAEMON=""
    if [ -n "$PM2_PID" ] && systemctl is-active --quiet "$PM2_UNIT" \
        && [ "$PM2_PID" = "$(systemctl show -p MainPID --value "$PM2_UNIT")" ]; then
        # The daemon's process title is "PM2 v<version>: God Daemon (<PM2_HOME>)".
        PM2_DAEMON="$(ps -o args= -p "$PM2_PID" | sed -n 's/^PM2 v\([^:]*\): God Daemon.*/\1/p' || true)"
        PM2_DAEMON="${PM2_DAEMON:-unknown}"
    fi
    if ! systemctl cat "$PM2_UNIT" >/dev/null 2>&1; then
        PM2_SUPERVISED="no"
        echo ""
        echo "WARNING: there is no systemd unit $PM2_UNIT, so pm2 will not come back after a reboot."
        echo "After this deploy, run 'pm2 startup' and the command it prints, then hand the apps"
        echo "to the new unit (this deploy's 'pm2 save' already recorded them):"
        echo "  $PM2_HANDBACK"
        echo ""
    elif [ -z "$PM2_DAEMON" ]; then
        PM2_SUPERVISED="no"
        echo ""
        echo "WARNING: $PM2_UNIT is not running the pm2 daemon (the unit is inactive, or its"
        echo "MainPID is not the pid in $PM2_PIDFILE). The pm2 commands below will use, or"
        echo "start, a daemon outside systemd. After this deploy, hand the apps back to the unit:"
        echo "  $PM2_HANDBACK"
        echo ""
    elif [ "$PM2_DAEMON" = "unknown" ]; then
        echo ""
        echo "WARNING: could not read the pm2 daemon's version from pid $PM2_PID's process title."
        echo ""
    elif [ "$PM2_INSTALLED" = "$PM2_VERSION" ] && [ "$PM2_DAEMON" != "$PM2_INSTALLED" ]; then
        # Only when the install is at the pin: otherwise the upgrade below restarts it anyway.
        echo ""
        echo "WARNING: the pm2 daemon still runs $PM2_DAEMON, but $PM2_INSTALLED is installed."
        echo "Restart it outside a prayer window (all apps restart):"
        echo "  pm2 save && sudo systemctl restart $PM2_UNIT"
        echo "Until then pm2 prints 'In-memory PM2 is out-of-date, do: pm2 update'. Don't: see"
        echo "\"Managing pm2\" in DEPLOYMENT_GUIDE_PI.md."
        echo ""
    fi
fi
if [ "$PM2_INSTALLED" != "$PM2_VERSION" ]; then
    echo ""
    echo "WARNING: global pm2 is $PM2_INSTALLED but deploy.sh pins $PM2_VERSION."
    if [ "$PM2_SUPERVISED" = "no" ]; then
        echo "First hand the apps back to $PM2_UNIT as above. Then, outside a prayer window:"
    else
        echo "Upgrade outside a prayer window (all apps restart):"
    fi
    echo "  npm install -g pm2@$PM2_VERSION && pm2 save && sudo systemctl restart $PM2_UNIT"
    echo "Use systemctl, not 'pm2 update': see \"Managing pm2\" in DEPLOYMENT_GUIDE_PI.md."
    echo ""
fi

# 9. Restart Services
echo "Restarting orchestration engine via PM2..."
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

echo "Deployment complete. Uptime check:"
pm2 status
