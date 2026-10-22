# Raspberry Pi 4 Deployment Guide for Adhan Caster

This guide will help you migrate and host the `adhan-api/media-caster` on your Raspberry Pi 4 (IP: `192.168.1.PI_IP`).

## 1. Prerequisites (Run on Raspberry Pi)

First, SSH into your Raspberry Pi:

```bash
ssh <your-user>@192.168.1.PI_IP
```

Install the required system packages (`ffmpeg` for video generation, `adb` for TV control):

```bash
sudo apt update
sudo apt install -y ffmpeg adb
```

Ensure Node.js (v18+) is installed. Since we are using a Raspberry Pi, the best way is using `nvm` (Node Version Manager) for the current user (avoid using `sudo` for node).

**Run these commands exactly as the pi-user (e.g., `bilalahamad`):**

1.  Install NVM:
    ```bash
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    ```
2.  Activate NVM (or close and reopen terminal):
    ```bash
    source ~/.bashrc
    ```
3.  Install Node.js 18:
    ```bash
    nvm install 18
    nvm use 18
    nvm alias default 18
    ```
4.  Verify installation:
    ```bash
    node -v
    # Should say v18.x.x
    ```

Install `pm2` globally at the version pinned as `PM2_VERSION` in `deploy.sh` (no `sudo` needed with nvm). See [Managing pm2](#managing-pm2) for why it is not a repo dependency:

```bash
npm install -g pm2@7.0.4
```

## 2. Transfer Code (Production Artifact Method)

Instead of cloning the raw developer repository (which includes test suites and configurations you don't need on production hardware), you should use the pre-packaged build process.

**From your Mac terminal:**
First, build the production artifact (this strips tests and compresses the codebase):
```bash
npm run build:prod
```

Then, securely copy the artifact to your Raspberry Pi:
```bash
scp adhan-api-production.tar.gz <pi-user>@192.168.1.PI_IP:~/
```

Next, SSH into your Pi manually (so your bash profile loads NVM correctly) and unpack it:
```bash
ssh <pi-user>@192.168.1.PI_IP
```

Once logged in to the Pi, run:
```bash
mkdir -p ~/adhan-api
tar -xzf ~/adhan-api-production.tar.gz -C ~/adhan-api
cd ~/adhan-api/media-caster
npm install --omit=dev
```

## 3. Installation & Configuration

Navigate to the directory on the Pi:

```bash
cd ~/adhan-api/media-caster
# OR if you copied it: cd ~/adhan-media-caster
```

**CRITICAL IF COPIED FROM MAC:**
Since you copied files from your Mac, the helper libraries (like `canvas`) are built for Mac, not Pi. You MUST delete them and reinstall:

```bash
rm -rf node_modules package-lock.json
npm install
```

Create/Edit the `.env` file:

```bash
cp .env.example .env
nano .env
```

**Crucial Configuration**:
Make sure your `.env` looks like this (adjust values for your home):

```properties
# Network Configuration
HOST_IP=192.168.1.PI_IP         <-- IMPORTANT: Set this to your Pi's IP
SERVER_PORT=3001

# Target Devices
TV_IP=192.168.1.TV_IP            <-- Your Android TV IP
DEVICE_NAME=Google Display <-- Exact name of your Nest Hub

# Location: sent to Aladhan as-is. Keep identical to the Adhan Focus
# extension's location so both show the same prayer times.
LOCATION_CITY=Sunnyvale
LOCATION_STATE=California
LOCATION_COUNTRY="United States"
LOCATION_METHOD=2
LOCATION_SCHOOL=0
TIMEZONE=America/Los_Angeles
# Optional: today's times are re-checked 45 min before every prayer and once
# every morning at this time (24h HH:MM in TIMEZONE). Default 08:00. The morning
# check skips itself within 50 min before a prayer and for 10 min after one.
# PRAYER_MORNING_REFRESH=08:00
```

## 4. ADB Connection (One-Time Setup)

You need to authorize the Pi to talk to your Android TV.

1.  Make sure your TV is on.
2.  Run:
    ```bash
    adb connect <TV_IP>
    ```
    _(Replace `<TV_IP>` with your TV's actual IP, e.g., 192.168.1.TV_IP)_
3.  **Look at your TV screen**: A popup will appear asking to allow debugging. Select **"Always allow from this computer"** and click **Allow**.
4.  Verify connection:
    ```bash
    adb devices
    # Should show: <TV_IP>:5555 device
    ```

## 5. PM2 Setup (Run in Background)

The easiest way to manage all services (Adhan Caster and ADB Keeper) is using the ecosystem file.

### Option A: Recommended (Ecosystem Method)
From the project root (`~/adhan-api`):
```bash
pm2 start ecosystem.config.cjs
```

### Option B: Manual (Individual Service Method)
If you need to manage services individually:
```bash
# Start Adhan Caster
cd ~/adhan-api/media-caster
pm2 start boot.js --name adhan-caster

# Start ADB Keeper
pm2 start adb_keepalive.js --name adb-keeper
```

### Save State
Regardless of the method used, save the process list so it survives reboots:

```bash
pm2 save
```

(Optional) Generate startup script to auto-boot PM2 on Pi restart:

```bash
pm2 startup
# Run the command it outputs!
```

### Managing pm2

pm2 is a **global** install (`~/.nvm/versions/node/<version>/lib/node_modules/pm2`), run by the systemd unit `pm2-<user>.service` that `pm2 startup` creates. It is deliberately **not** in either `package.json`. Nothing in the repo starts or `require`s pm2, and npm ignores `overrides` for global installs. A repo copy only produced lockfile alerts for a pm2 that never ran, and its overrides never reached the daemon.

`PM2_VERSION` in `deploy.sh` is the pinned version, and `deploy.sh` warns when the global pm2 differs. To upgrade, run the steps below outside a prayer window, because all apps restart. Re-running the same steps at the same version is also how you pick up patched releases of pm2's own dependencies: a global install re-resolves them every time.

```bash
npm install -g pm2@7.0.4            # keep in step with PM2_VERSION
pm2 save
sudo systemctl restart pm2-$(whoami)
```

Use `systemctl restart`, not `pm2 update`. `pm2 update` relaunches the daemon from your SSH shell, outside the systemd unit, so systemd loses track of it. Between the install and the restart, pm2 prints `In-memory PM2 is out-of-date, do: pm2 update`. Ignore that message.

**Check the daemon through systemd, not with `pm2 --version`.** `pm2 --version` prints the version of the CLI on disk, not of the daemon that is running. Like every pm2 command, it also starts a daemon when none is reachable, so if the unit failed to start, it creates one outside systemd. This line runs `pm2 ls` only once systemd is running the daemon:

```bash
U=pm2-$(whoami); P=$(cat ~/.pm2/pm2.pid 2>/dev/null); systemctl is-active --quiet $U && [ "$(systemctl show -p MainPID --value $U)" = "$P" ] && ps -o args= -p "$P" && pm2 ls || echo "pm2 is not running under $U: don't run pm2 commands"
```

Expect `PM2 v7.0.4: God Daemon (...)` and every app online. `deploy.sh` runs the same check and warns if the unit isn't running the daemon, or if the daemon's version differs from the installed one.

If a pm2 command has already started a daemon outside systemd, hand the apps back to the unit. This applies when the unit was down during `deploy.sh`, or after `pm2 update`.
- The dump is copied first, because a stop that falls back to SIGTERM rewrites it.
- `systemd-run` keeps the sequence going if the SSH session drops midway.
- `deploy.sh` prints this same line when it needs it.

```bash
U=pm2-$(whoami); D=~/.pm2/dump.pm2; sudo systemd-run --unit=pm2-handback --collect --wait /bin/sh -c "cp -p $D $D.keep && systemctl stop $U; runuser -u $(whoami) -- env HOME='$HOME' PATH='$PATH' PM2_HOME='$HOME/.pm2' pm2 kill; cp -p $D.keep $D && systemctl start $U"
```

The unit hardcodes the nvm Node path. After switching Node versions, run `pm2 unstartup`, then `pm2 startup` and the command it prints, then `pm2 save`. Before bumping `PM2_VERSION`, check `npm view pm2@<version> engines` against the Pi's Node. To see the advisories a global install of that version will carry, audit it the way npm resolves a global install, with no overrides:

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null && npm install --package-lock-only pm2@<version> && npm audit
```

pm2 7.0.4 carries three advisories. None of them is reachable here:

- `braces`, via the `chokidar` 3.6.0 that pm2 pins. It only parses `watch` / `ignore_watch` patterns, and every app runs with `watch: false`.
- `js-yaml` 4.3.1. It only parses `.yml` / `.yaml` ecosystem files, and ours is `ecosystem.config.cjs`.
- `basic-ftp` 5.x. It is only reachable through the pm2.io agent's proxy support, and pm2.io is not linked (no `pm2 link`).

#### Upgrading with a rollback

The upgrade steps above install over the live copy. If the new version won't start, rolling back then means downloading the old one while the apps are down. The safer way, used for 6.0.14 → 7.0.4, keeps the old copy next to the new one.

Pick a time outside a prayer window, when nothing is deploying: `pgrep -af 'bin/pm2 |npm (ci|install)'` should print nothing, and the systemd check above should show the daemon. Then:

```bash
V=7.0.4; U=pm2-$(whoami); G=$(npm root -g)     # e.g. ~/.nvm/versions/node/v18.20.8/lib/node_modules
# 1. Stage the new version. Production is untouched.
npm install -g --prefix ~/pm2-$V-stage pm2@$V --no-audit --no-fund
# 2. Save the process list and keep a copy of it.
pm2 save && cp -p ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.before-upgrade
# 3. Swap the directories, but only if the stage exists and no old ~/pm2-previous is in the way.
#    The bin links are relative, so they follow.
[ -d "$G/pm2" ] && [ -f ~/pm2-$V-stage/lib/node_modules/pm2/package.json ] && [ ! -e ~/pm2-previous ] \
  && mv -T "$G/pm2" ~/pm2-previous && mv -T ~/pm2-$V-stage/lib/node_modules/pm2 "$G/pm2" && echo swapped
# 4. The new CLI must reach the old daemon, because ExecStop takes the same path.
#    Expect every app online, well under 5 s. When V differs from the running version, also
#    expect the "In-memory PM2 is out-of-date" banner naming the old one.
time pm2 ls
```

If step 3 didn't print `swapped`, stop and look. If step 4 fails or hangs, swap back. Nothing has restarted yet:

```bash
{ [ ! -e "$G/pm2" ] || mv -T "$G/pm2" ~/pm2-$V-stage/lib/node_modules/pm2; } && mv -T ~/pm2-previous "$G/pm2"
```

Otherwise, restart under systemd. `systemd-run` runs the stop and start as a unit of its own, so closing the terminal halfway can't leave the apps stopped. A stop that falls back to SIGTERM rewrites the dump, so the saved copy is restored in between:

```bash
sudo systemd-run --unit=pm2-swap --collect --wait /bin/sh -c "systemctl stop $U && { cmp -s $HOME/.pm2/dump.pm2 $HOME/.pm2/dump.pm2.before-upgrade || cp -p $HOME/.pm2/dump.pm2.before-upgrade $HOME/.pm2/dump.pm2; } && systemctl start $U"
```

Then run the systemd check above. You can roll back as long as `~/pm2-previous` exists. Run the rollback as your user in a login shell, so nvm puts `npm` on PATH. It refuses to touch anything if `~/pm2-previous` or `G` is missing:

```bash
U=pm2-$(whoami); G=$(npm root -g); F=~/pm2-failed-$(date +%Y%m%d-%H%M)
if [ -d "$G" ] && [ -d ~/pm2-previous ]; then
  sudo systemd-run --unit=pm2-rollback --collect --wait /bin/sh -c "systemctl stop $U; { [ ! -e $G/pm2 ] || mv -T $G/pm2 $F; } && mv -T $HOME/pm2-previous $G/pm2 && cp -p $HOME/.pm2/dump.pm2.before-upgrade $HOME/.pm2/dump.pm2; systemctl reset-failed $U; systemctl start $U"
else echo "Not rolling back: no ~/pm2-previous, or npm is not on PATH (G='$G')"; fi
```

Once the next 02:00 auto-update and a prayer cast have run cleanly, clean up:
- Delete `~/pm2-previous`, the empty `~/pm2-<version>-stage` and `~/.pm2/dump.pm2.before-upgrade`.
- After a rollback, also delete `~/pm2-failed-*`.

### After updating code (`git pull`, tarball, or `scp`)

Node does not hot-reload your changes. Until you restart the process, the Pi keeps running the **old** `boot.js` and services (including Firestore sync and any new HTTP routes).

```bash
pm2 restart adhan-caster --update-env
```

Restart `adb-keeper` only if you changed `adb_keepalive.js`. To restart everything:

```bash
pm2 restart all --update-env
```

**Operations dashboard:** After deploying caster changes that affect Firestore, push metrics once from the Pi (still on port `3001` unless you changed `SERVER_PORT`):

```bash
curl -sS -X POST "http://localhost:3001/api/metrics/sync"
```

You should see JSON like `"status":"synced"` and `"prayersScheduled":5` when today’s row in `~/.adhan-data/annual_schedule.json` resolves all five prayers.

## 6. Verification

Check the logs to ensure everything is working:

```bash
pm2 logs adhan-caster
```

You should see:

> `🚀 Adhan System v2.0 Starting...`
> `✅ Today's Prayer Times...`
> `🔊 Local Audio Server running at http://<PI_IP>:3001/audio/`

## Troubleshooting

- **Wrong IP**: If the cast URL shows `127.0.0.1` or wrong IP, ensure `HOST_IP=192.168.1.PI_IP` is set in `.env`.
- **Audio not playing**: Check `pm2 logs`. Ensure the Google Display is on the same network.
- **TV not pausing / ADB Error**:
  - If logs say `adb: device unauthorized`:
    1.  On your TV, go to **Settings > system > Developer Options > Revoke USB debugging authorizations**.
    2.  On Pi: `adb kill-server` then `adb connect 192.168.1.TV_IP`.
    3.  **Watch TV Screen immediately** and click "Always Allow".
  - Ensure `adb devices` shows `device` (not `unauthorized`).

## 6.5 Migration: Tarball → Git-pull (one-time, enables auto-updater)

The auto-updater (`pm2 process: auto-updater`) needs a real `.git` directory
on the Pi so it can `git fetch origin main`. The legacy tarball deploy
strips `.git`, so a one-time migration is required. After this, every push
to `origin/main` is picked up automatically at the next T−20min or 02:00.

```bash
ssh <pi-user>@192.168.1.PI_IP
cd ~

# 1. Backup current deploy
mv adhan-api adhan-api.legacy

# 2. Fresh clone (preserves .git)
git clone https://github.com/bilalahamad0/adhan-api.git
cd adhan-api

# 3. Restore Pi-only files (never in git)
cp ../adhan-api.legacy/media-caster/.env media-caster/.env
cp -r ../adhan-api.legacy/media-caster/audio media-caster/audio
mkdir -p ~/.adhan-data
cp ../adhan-api.legacy/.adhan-data/* ~/.adhan-data/ 2>/dev/null || true

# 4. Install
npm install
cd media-caster && npm install --omit=dev && cd ..

# 5. Reload PM2 (now includes auto-updater)
pm2 reload ecosystem.config.cjs
pm2 save

# 6. Verify the auto-updater is alive and saw today's prayers
pm2 logs auto-updater --lines 30
# Expected: "auto-updater started", "scheduled pre-Fajr update check at 04:43", etc.

# 7. After 1 successful auto-update, drop the legacy dir
# rm -rf ~/adhan-api.legacy
```

### Manual update trigger
```bash
npm run update:now              # respects T−5min prayer-window guard
npm run update:now -- --force   # bypass guard (use only outside prayer windows)
npm run update:now -- --dry-run # smoke test the candidate, no swap
```

### Schedule
- T−20min before each of the 5 prayers (catches same-day hotfixes).
- 02:00 daily (catches anything missed; well after midnight `scheduleToday`).
- Both paths share `BuildManager.attemptUpdate()` and a single in-process
  mutex; the daily check skips with `update-already-in-progress` if a per-
  prayer cycle is somehow still running at 02:00.

### What gets gated
Every update must pass `boot.js --smoke` on a `git worktree` of the new SHA
(separate `node_modules`, separate port `3099`, `SMOKE_DRY_RUN=1`). On
failure, the live build is untouched and `meta/build.lastFailure` updates
on Firestore — the dashboard banner appears within seconds.

### Rollback
The previous SHA is in `~/.adhan-data/build-info.json` as `previousSha`:
```bash
cd ~/adhan-api
PREV=$(jq -r .previousSha ~/.adhan-data/build-info.json)
git checkout $PREV && npm ci --omit=dev && pm2 reload all
```

### Privacy
`meta/build` only ever contains: version label, short SHA, deployedAt,
priority, last successful smoke summary, and last failure (stage +
failed-check names only — no values, no error messages, no commit
messages). The privacy linter (a smoke check) refuses to publish any
payload containing an env value longer than 4 chars.

## 7. Running a Test

To verify the audio and casting works immediately without waiting for prayer time:

1.  **Stop the background service** (so it doesn't conflict):

    ```bash
    pm2 stop adhan-caster
    ```

2.  **Run a manual test**:

    ```bash
    # Test standard Adhan (simulates Isha)
    node scheduler.js --test

    # OR Test Fajr Adhan
    node scheduler.js --test --fajr
    ```

3.  **Watch the output**:
    - It should generate a video.
    - It should cast to your Google Hub.
    - It should pause your TV (if configured).

4.  **Restart the service** when done:
    ```bash
    pm2 start adhan-caster
    ```
