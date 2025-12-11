const schedule = require('node-schedule');
const axios = require('axios');
const fs = require('fs');
const { DateTime } = require('luxon');
const ChromecastAPI = require('chromecast-api');
const path = require('path');
const express = require('express');
const os = require('os');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);
require('dotenv').config();

// --- CONFIGURATION ---
const CONFIG = {
    location: {
        city: process.env.LOCATION_CITY || 'Sunnyvale',
        country: process.env.LOCATION_COUNTRY || 'US',
        method: parseInt(process.env.LOCATION_METHOD || 2), // ISNA
        school: parseInt(process.env.LOCATION_SCHOOL || 1)  // Hanafi
    },
    device: {
        name: process.env.DEVICE_NAME || 'Google Display',
        targetVolume: 0.5 // "Set volume level to 5" (0.5 out of 1.0)
    },
    audio: {
        // Active Selections
        fajrSource: "https://raw.githubusercontent.com/AalianKhan/adhans/master/adhan_fajr.mp3",
        regularSource: "https://www.islamcan.com/audio/adhan/azan1.mp3",

        // Available Options (Swappable)
        options: {
            fajr: "https://raw.githubusercontent.com/AalianKhan/adhans/master/adhan_fajr.mp3", // "Assalatu Khairum Minan Naum"
            mecca_1: "https://www.islamcan.com/audio/adhan/azan1.mp3", // Makkah (Standard)
            mecca_2: "https://www.islamcan.com/audio/adhan/azan3.mp3", // Makkah (Alternative)
            generic_1: "https://www.islamcan.com/audio/adhan/azan4.mp3", // Generic / Soft
            generic_2: "https://www.islamcan.com/audio/adhan/azan5.mp3", // Generic / Echo
            generic_3: "https://www.islamcan.com/audio/adhan/azan6.mp3", // Generic / Melodic
            generic_4: "https://www.islamcan.com/audio/adhan/azan7.mp3", // Generic / Deep
        }
    },
    timezone: process.env.TIMEZONE || 'America/Los_Angeles',
    serverPort: parseInt(process.env.SERVER_PORT || 3001) // Dedicated port for serving audio
};

const SCHEDULE_FILE = path.join(__dirname, 'annual_schedule.json');
const AUDIO_DIR = path.join(__dirname, 'audio_cache');

// --- UTILS ---
function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

// --- PRE-FLIGHT: AUDIO CACHE ---
async function ensureAudioCache() {
    if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);

    // Downloads: Map active sources + all options to local files
    const downloads = [
        { name: 'fajr.mp3', url: CONFIG.audio.fajrSource },
        { name: 'adhan.mp3', url: CONFIG.audio.regularSource },
    ];

    // Also cache all options for easy swapping
    Object.keys(CONFIG.audio.options).forEach(key => {
        downloads.push({ name: `${key}.mp3`, url: CONFIG.audio.options[key] });
    });

    for (const file of downloads) {
        const filePath = path.join(AUDIO_DIR, file.name);
        if (!fs.existsSync(filePath)) {
            log(`⬇️  Downloading ${file.name} to cache...`);
            try {
                const response = await axios.get(file.url, { responseType: 'stream' });
                await pipeline(response.data, fs.createWriteStream(filePath));
                log(`✅ Downloaded ${file.name}`);
            } catch (err) {
                log(`❌ Failed to download ${file.name}: ${err.message}`);
            }
        }
    }
}

// --- STATIC SERVER ---
const app = express();
app.use('/audio', express.static(AUDIO_DIR));
app.listen(CONFIG.serverPort, () => {
    log(`🔊 Local Audio Server running at http://${getLocalIp()}:${CONFIG.serverPort}/audio/`);
});


// --- CASTING ENGINE WITH VOLUME CONTROL & TV SYNC ---
function executePreFlightAndCast(prayerName, audioFileName) {
    log(`🚀 TRIGGER: ${prayerName} Time! Starting Pre-flight sequence...`);

    // 1. Verify Audio Exists
    const filePath = path.join(AUDIO_DIR, audioFileName);
    if (!fs.existsSync(filePath)) {
        log(`❌ Pre-flight Fail: Audio file ${audioFileName} missing. Attempting emergency download...`);
        ensureAudioCache();
        return;
    }

    // 2. Construct Local LAN URL
    const localIp = getLocalIp();
    const castUrl = `http://${localIp}:${CONFIG.serverPort}/audio/${audioFileName}`;
    log(`📡 Prepared Audio Stream: ${castUrl}`);

    // Track devices
    let adhanDevice = null;
    let tvDevice = null;

    // --- ADB TV CONTROL (Android Debug Bridge) ---
    const TV_IP = process.env.TV_IP || '127.0.0.1';
    const { exec } = require('child_process');

    function adbCommand(cmd) {
        return new Promise((resolve) => {
            exec(`adb ${cmd}`, { timeout: 5000 }, (error, stdout, stderr) => {
                if (error) {
                    log(`⚠️ ADB Error (${cmd}): ${error.message}`);
                    resolve(null);
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    // Constants for TV media state
    const MEDIA_PLAYING = 'PLAYING';
    const MEDIA_PAUSED = 'PAUSED';
    const MEDIA_STOPPED = 'STOPPED';

    async function checkTvMediaState() {
        try {
            // 1. Primary Check: Media Sessions
            // Native apps (YouTube, Netflix, Spotify) usually register here.
            const sessionOutput = await adbCommand('shell dumpsys media_session');

            // Check for specific states
            if (sessionOutput.includes('state=3') || sessionOutput.includes('state=Playing')) {
                return MEDIA_PLAYING;
            }
            // Explicitly check for Paused. If paused, we don't want to mute.
            if (sessionOutput.includes('state=2') || sessionOutput.includes('state=Paused')) {
                return MEDIA_PAUSED;
            }

            // 2. Fallback Check: Raw Audio Output (for IPTV / niche apps)
            // We parse "dumpsys audio" to find active players, ignoring system sounds.
            const audioOutput = await adbCommand('shell dumpsys audio');

            // We look for the "players:" section in PlaybackActivityMonitor
            // And ensure we ignore the "Audio event log:" section (history).
            const playersSection = audioOutput.split('Audio event log:')[0];

            // Regex to find active media players:
            // Must have 'usage=USAGE_MEDIA' or 'usage=USAGE_GAME' AND 'state:started'
            // This avoids matching system sounds (USAGE_ASSISTANCE_SONIFICATION).
            const hasActiveMedia = playersSection.split('\n').some(line => {
                const match = (line.includes('usage=USAGE_MEDIA') || line.includes('usage=USAGE_GAME')) &&
                    line.includes('state:started');
                return match;
            });

            if (hasActiveMedia) {
                console.log("🔊 Detected active raw audio stream (USAGE_MEDIA).");
                return MEDIA_PLAYING;
            }

            return MEDIA_STOPPED;
        } catch (err) {
            console.error("⚠️ Error checking TV state:", err.message);
            return MEDIA_STOPPED; // Fail safe: Assume nothing is playing.
        }
    }

    // --- EXECUTION FLOW ---

    let tvWasInterrupted = false;
    let tvWasMuted = false;

    // Global Resume Helper
    const resumeTvSafely = async () => {
        if (tvWasMuted) {
            log(`🔊  Unmuting TV (ADB Key 164)...`);
            tvWasMuted = false;
            tvWasInterrupted = false;
            await adbCommand(`shell input keyevent 164`); // MUTE (Toggle)
        } else if (tvWasInterrupted) {
            log(`▶️  Resuming TV (ADB Key 126)...`);
            tvWasInterrupted = false;
            await adbCommand(`shell input keyevent 126`); // PLAY
        }
    };

    process.on('uncaughtException', async (err) => {
        log(`💥 Uncaught Exception: ${err.message}`);
        await resumeTvSafely();
        process.exit(1);
    });

    // Helper: Find Speaker with Timeout
    function findAdhanSpeaker(client, name) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                client.removeListener('device', onDevice);
                reject(new Error(`Speaker '${name}' not found within 10s`));
            }, 10000);

            const onDevice = (device) => {
                if (device.friendlyName.includes(name) || device.friendlyName === name) {
                    clearTimeout(timeout);
                    client.removeListener('device', onDevice);
                    resolve(device);
                }
            };
            client.on('device', onDevice);
        });
    }

    // Helper: Play Adhan & Monitor
    function playAdhanSequence(device, client) {
        log(`✅ Connected to Adhan Speaker: ${device.friendlyName}`);

        device.getVolume((err, volume) => {
            const originalVolume = (volume && !err) ? volume.level : 0.5;
            log(`🔊 Speaker Volume: ${Math.round(originalVolume * 100)}%. Target: ${CONFIG.device.targetVolume * 100}%.`);

            // CLEANUP (Idempotent)
            let isCleanedUp = false;
            const cleanup = () => {
                if (isCleanedUp) return;
                isCleanedUp = true;
                log(`🔄 Playback Ended/Stopped. restoring...`);
                resumeTvSafely(); // 1. Resume TV

                try {
                    device.setVolume(originalVolume, (err) => { // 2. Restore Volume
                        if (!err) log(`✅ Volume Restored.`);
                        log(`🏁 All Done. Disconnecting.`);
                        try { client.destroy(); } catch (e) { }
                        // Exit Process if Testing (Clean Exit)
                        if (process.argv.includes('--test')) {
                            setTimeout(() => process.exit(0), 500);
                        }
                    });
                } catch (e) {
                    log(`⚠️ Volume Restore Failed: ${e.message}`);
                    if (process.argv.includes('--test')) process.exit(0);
                }
            };

            const safetyTimer = setTimeout(() => {
                log(`⏰ Safety Timeout Reached.`);
                cleanup();
            }, 300000);

            device.on('close', () => {
                log(`⚠️ Device Connection Closed.`);
                cleanup();
            });

            device.setVolume(CONFIG.device.targetVolume, (err) => {
                var media = { url: castUrl, contentType: 'audio/mp3' };
                device.play(media, function (err) {
                    if (err) {
                        log(`❌ Playback Error: ${err.message}`);
                        cleanup();
                    } else {
                        log(`🎶 Playback Started. Monitoring status...`);

                        // Monitor Loop
                        let lastStatusTime = Date.now();
                        const checkInterval = setInterval(() => {
                            if (isCleanedUp) {
                                clearInterval(checkInterval);
                                clearTimeout(safetyTimer);
                                return;
                            }

                            // Watchdog: Tighter timeout (2.5s) for faster reaction
                            if (Date.now() - lastStatusTime > 2500) {
                                log(`⚠️ Monitor Watchdog Timeout. Assuming Stopped.`);
                                clearInterval(checkInterval);
                                clearTimeout(safetyTimer);
                                cleanup();
                                return;
                            }

                            try {
                                device.getStatus((err, status) => {
                                    lastStatusTime = Date.now();
                                    if (status) log(`🔍 Monitor Status: ${status.playerState}`);

                                    if (err) {
                                        log(`⚠️ Monitor Error: ${err.message}`);
                                        clearInterval(checkInterval);
                                        clearTimeout(safetyTimer);
                                        cleanup();
                                        return;
                                    }
                                    // If IDLE or PAUSED -> CLEANUP
                                    if (!status || status.playerState === 'IDLE' || status.playerState === 'PAUSED') {
                                        log(`⏹️  Status is ${status ? status.playerState : 'Unknown'}. Adhan Finished/Stopped.`);
                                        clearInterval(checkInterval);
                                        clearTimeout(safetyTimer);
                                        cleanup();
                                    }
                                });
                            } catch (e) {
                                log(`💥 Monitor Exception: ${e.message}`);
                                cleanup();
                            }
                        }, 500); // Check every 500ms
                    }
                });
            });
        });
    }

    // MAIN EXECUTION
    const client = new ChromecastAPI();

    // Step 1: Find Speaker
    findAdhanSpeaker(client, CONFIG.device.name)
        .then(async (device) => {
            // Step 2: Found! Now Check TV
            // Step 2: Found! Now Check TV
            try {
                const tvState = await checkTvMediaState();

                if (tvState === MEDIA_PLAYING) {
                    log(`📺 TV is PLAYING. Sending PAUSE (ADB Key 127)...`);
                    tvWasInterrupted = true;
                    await adbCommand(`shell input keyevent 127`);

                    // Verification / Fallback (Wait 1s)
                    await new Promise(r => setTimeout(r, 1000));
                    const newState = await checkTvMediaState();

                    if (newState === MEDIA_PLAYING) {
                        log(`⚠️ Pause ineffective. Sending MUTE (ADB Key 164)...`);
                        tvWasMuted = true;
                        // tvWasInterrupted remains true to track "we did something"
                        await adbCommand(`shell input keyevent 164`);
                    }
                } else {
                    log(`ℹ️  TV State is ${tvState}. No action.`);
                }
            } catch (tvErr) {
                log(`⚠️ TV Check Skipped/Failed: ${tvErr.message}`);
            }

            // Step 3: Play Adhan
            playAdhanSequence(device, client);
        })
        .catch((err) => {
            log(`❌ Pre-flight Aborted: ${err.message}`);
            client.destroy();
            if (process.argv.includes('--test')) process.exit(1);
        });
}

// --- SCHEDULER ENGINE ---
async function scheduleToday() {
    log("📅 Loading Schedule...");

    // Per User Request: "Don't download once a day, download once a year".
    // We assume annual_schedule.json exists (or we fetch it once).

    let annualData;

    if (fs.existsSync(SCHEDULE_FILE)) {
        try {
            annualData = JSON.parse(fs.readFileSync(SCHEDULE_FILE));
        } catch (e) { log("⚠️ Local schedule corrupt."); }
    }

    const currentYear = DateTime.now().setZone(CONFIG.timezone).toFormat('yyyy');

    // Fetch if missing
    if (!annualData || annualData.year !== currentYear) {
        log(`🔄 Initialzing Annual Data for ${currentYear}...`);
        try {
            const url = `http://api.aladhan.com/v1/calendarByCity/${currentYear}?city=${CONFIG.location.city}&country=${CONFIG.location.country}&method=${CONFIG.location.method}&annual=true`;
            const response = await axios.get(url);
            annualData = { year: currentYear, data: response.data.data };
            fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(annualData, null, 2));
            log("💾 Annual Data Downloaded & Saved.");
        } catch (error) {
            log("❌ Fetch Error. Cannot Schedule.");
            return;
        }
    }

    // Pre-flight: Ensure Audio is ready
    await ensureAudioCache();

    // Get Today's Times
    const today = DateTime.now().setZone(CONFIG.timezone);
    const month = today.month.toString();
    const day = today.day.toString(); // 1-31

    const monthData = annualData.data[month];
    if (!monthData) return log("❌ Calendar Error: Month missing.");

    // Find today (Data array is roughly days, but robust find is safer)
    const todayEntry = monthData.find(d => parseInt(d.date.gregorian.day) === today.day);
    if (!todayEntry) return log("❌ Calendar Error: Day missing.");

    const timings = todayEntry.timings;
    log(`✅ Today's Prayer Times (${todayEntry.date.readable}):`);

    const prayers = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

    prayers.forEach(prayer => {
        let timeStr = timings[prayer].split(' ')[0];
        const [hours, minutes] = timeStr.split(':');
        const scheduleTime = today.set({ hour: parseInt(hours), minute: parseInt(minutes), second: 0 });

        if (scheduleTime < DateTime.now().setZone(CONFIG.timezone)) {
            return; // Passed
        }

        const audioFile = prayer === 'Fajr' ? 'fajr.mp3' : 'adhan.mp3';

        schedule.scheduleJob(scheduleTime.toJSDate(), function () {
            executePreFlightAndCast(prayer, audioFile);
        });

        log(`   - ${prayer}: ${timeStr}`);
    });
}

// --- STARTUP ---
log(`🚀 Adhan System v2.0 Starting...`);
scheduleToday();

// Daily Refresh at 1 AM
schedule.scheduleJob('0 1 * * *', scheduleToday);

// --- TEST MODE ---
if (process.argv.includes('--test')) {
    log("🧪 TEST TRIGGERED");
    const isFajr = process.argv.includes('--fajr');
    const testAudio = isFajr ? "fajr.mp3" : "adhan.mp3";
    const testName = isFajr ? "TEST_FAJR" : "TEST_PRAYER";

    setTimeout(async () => {
        await ensureAudioCache(); // Make sure we have files
        executePreFlightAndCast(testName, testAudio);
    }, 2000);
}
