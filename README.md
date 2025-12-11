# Adhan Caster Agent

An automated Adhan invocation system that casts the call to prayer to Google Nest/Cast devices and intelligently coordinates with your Android TV (Sony Bravia).

## Features

*   **Smart Casting**: Plays Adhan audio on Google Cast devices at prayer times.
*   **TV Coordination**: Automatically Pauses (or Mutes) your TV during the Adhan and resumes/unmutes afterwards.
*   **Idle Detection**: Intelligently detects if the TV is actually playing media to avoid interrupting idle/off states.
*   **Custom Audio**:
    *   **Fajr**: Dedicated "Assalatu Khairum" audio.
    *   **Regular**: Standard Makkah Adhan.
    *   Swappable audio library (Makkah, Madinah, Generic, etc.).
*   **Resiliency**: Auto-retry logic, watchdog timers for playback monitoring, and network recovery.

## Prerequisites

*   **Node.js**: v18 or higher.
*   **ADB (Android Debug Bridge)**: Must be installed and available in `$PATH`.
*   **Network**: Server, Google Speaker, and TV must be on the same local network.

## Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/bilalahamad0/adhan-api.git
    cd adhan-api/audio-caster
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Configure Environment:
    Copy the example config and edit it with your details.
    ```bash
    cp .env.example .env
    nano .env
    ```

    **Required Variables (.env):**
    ```properties
    TV_IP=10.0.0.80             # IP Address of your Android TV
    DEVICE_NAME=Google Display  # Name of your Cast Speaker
    LOCATION_CITY=Sunnyvale     # Your City
    LOCATION_COUNTRY=US         # Your Country code
    TIMEZONE=America/Los_Angeles
    ```

4.  Authorize ADB (First Run):
    On your server terminal, run:
    ```bash
    adb connect <TV_IP>
    ```
    *Accept the debug prompt on your TV screen.*

## Usage

### Run Manually
```bash
node scheduler.js
```

### Run with PM2 (Production)
```bash
npm install -g pm2
pm2 start scheduler.js --name adhan-scheduler
pm2 save
```

### Test Mode
Simulate a prayer trigger immediately (without waiting for schedule):
```bash
node scheduler.js --test
# Or for Fajr specific audio:
node scheduler.js --test --fajr
```
