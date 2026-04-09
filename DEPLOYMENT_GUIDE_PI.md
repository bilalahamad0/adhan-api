# Raspberry Pi 4 Deployment Guide for Adhan Caster

This guide will help you migrate and host the `adhan-api/audio-caster` on your Raspberry Pi 4 (IP: `192.168.1.PI_IP`).

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

Install `pm2` globally (no `sudo` needed with nvm):

```bash
npm install -g pm2
```

## 2. Transfer Code

You can either `git pull` if you have the repo cloned, or copy your modified local files to the Pi.

**Option A: Git Clone (Recommended if repo is public/accessible)**

```bash
cd ~
git clone https://github.com/bilalahamad0/adhan-api.git
cd adhan-api/audio-caster
```

**Option B: Copy from Mac (If you have local changes not pushed)**
From your **Mac terminal**, copy the entire repository to ensure the `images` directory (which `audio-caster` depends on) is included:

```bash
# Copy the whole adhan-api folder
scp -r /Users/<your-mac-user>/Documents/GitHub/adhan-api <pi-user>@192.168.1.PI_IP:~/adhan-api
```

## 3. Installation & Configuration

Navigate to the directory on the Pi:

```bash
cd ~/adhan-api/audio-caster
# OR if you copied it: cd ~/adhan-audio-caster
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

# Location
LOCATION_CITY=Sunnyvale
LOCATION_COUNTRY=US
LOCATION_METHOD=2
LOCATION_SCHOOL=1
TIMEZONE=America/Los_Angeles
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

Start the application with PM2 so it runs in the background and restarts automatically.

```bash
pm2 start boot.js --name adhan-caster
```

Save the process list so it survives reboots:

```bash
pm2 save
```

(Optional) Generate startup script to auto-boot PM2 on Pi restart:

```bash
pm2 startup
# Run the command it outputs!
```

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
