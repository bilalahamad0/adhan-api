# Project Plan & Requirements: Adhan Automation System

## Project Overview

The **Adhan Automation System** is an end-to-end solution to manage Islamic prayer times and automate Adhan audio playback on Google Nest Hub devices. It consists of a cloud-based API for scheduling and a local relay for home automation control.

## System Architecture

1.  **Adhan API (Vercel)**:
    -   Fetches prayer times from Aladhan API.
    -   Updates **Google Calendar** daily with prayer events.
2.  **Google Calendar**:
    -   Acts as the central schedule / source of truth.
3.  **Google Apps Script (Cloud)**:
    -   Runs on a time-based trigger (e.g., every 5 minutes).
    -   Checks for upcoming "Adhan" events in the calendar.
    -   Sends a Webhook to the local Assistant Relay.
4.  **Assistant Relay (Local Server)**:
    -   Receives the Webhook request.
    -   Authenticates with Google Assistant via OAuth.
    -   **Crucial Step**: It sends a command to the Google Assistant Cloud to execute an action on a *specific* target device.
    -   Example Command: *"Play [Adhan MP3] on [Google Nest Hub]"*.
5.  **Google Nest Hub / Display**:
    -   Receives the instruction from Google Cloud.
    -   Plays the audio.
    -   *Note: The audio does NOT play on the Mac Mini running the relay.*

## Architecture Rationale: Why is the Relay needed?

The **Assistant Relay** is a required component because **Google does not provide a direct Cloud API to play media on Nest Hubs**.
-   **Why not Vercel/GAS directly?**: Security restrictions prevent random cloud servers from broadcasting to your home devices. Control requires either:
    1.  **Local Network Access**: (e.g., Cast Protocol) – Requires a device on your WiFi (Mac Mini).
    2.  **Assistant SDK**: (What Relay uses) – Requires a persistent Node.js server to authenticate and "speak" to the Assistant. Vercel and Google Apps Script are "Serverless" (ephemeral) and cannot maintain this persistent connection or runtime environment.

**Alternative**: You *can* host the Assistant Relay on a Cloud Server (e.g., Heroku, DigitalOcean, Google Cloud Run) to remove the Mac Mini dependency, but you still need "A Server" running the Relay software somewhere.

## Component Status

### 1. Adhan API (Vercel)
-   **Status**: ✅ Implemented
-   **Path**: `/api/`
-   **Functionality**: Fetches times and syncs to Google Calendar.
-   **Next Steps**:
    -   [ ] Remove hardcoded credentials (`.json` key).
    -   [ ] Parameterize City/Country/Timezone.

### 2. Google Apps Script
-   **Status**: ✅ Drafted (See `scripts/triggerAdhan.js`)
-   **Functionality**: Scans calendar and calls webhook.
-   **Critical Setup Note**: Since this runs in the Google Cloud, it cannot directly access `localhost`.
    -   **Solution**: Use a tunneling service (like **Ngrok**) or a static public IP to expose the Assistant Relay port (3000) to the internet.

### 3. Assistant Relay
-   **Status**: 🚧 External Setup Required
-   **Hosting**: Local Machine / Raspberry Pi.
-   **Requirement**: Must be running 24/7.
-   **Setup**:
    -   Clone `kluucreations/assistant-relay`.
    -   Configure OAuth Credentials (`credentials.json`).
    -   Start server (`npm start`).

## Roadmap

### 🚨 Critical Security & Config

1.  **Secret Management**:
    -   Do not commit `fit-sanctum-....json` or `credentials.json` to GitHub.
    -   Use Environment Variables for `GOOGLE_SERVICE_KEY`.

2.  **Network Accessibility**:
    -   Ensure the Google Apps Script can reach the Assistant Relay.
    -   If using **Ngrok**, update the webhook URL in the GAS script dynamically or use a reserved domain.

### 🚀 Enhancements

1.  **Dynamic Audio Selection**:
    -   The script currently distinguishes between "Fajr" and other prayers for different audio files. 
    -   Ensure MP3 URLs are publicly accessible and high availability.

2.  **User Configuration**:
    -   Allow configuring the Target Device Name (e.g., "Living Room speaker") via a variable or properties service in GAS.

## Deployment Checklist

1.  **Deploy Adhan API**: Push to Vercel, set CRON job.
2.  **Setup Assistant Relay**: Run locally, authenticate with Google.
3.  **Deploy GAS**: Copy `scripts/triggerAdhan.js` to `script.google.com`, set Triggers.
4.  **Connect**: Update GAS with the Public URL of the Assistant Relay.
