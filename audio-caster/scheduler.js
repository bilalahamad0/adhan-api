const schedule = require('node-schedule');
const axios = require('axios');
require('events').EventEmitter.defaultMaxListeners = 25; // Suppress Warning
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

const DEBUG = process.argv.includes('--debug');
function debugLog(msg) {
    if (DEBUG) console.log(`🐞 [DEBUG] ${msg}`);
}

const ffmpeg = require('fluent-ffmpeg');

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
        targetVolume: 0.6 // Level 6 (Range 0.0-1.0)
    },
    audio: {
        // Active Selections
        fajrCurrent: "fajr", // references options key
        regularCurrent: "generic_3", // references options key

        // Available Options (Source Map)
        options: {
            fajr: "https://raw.githubusercontent.com/AalianKhan/adhans/master/adhan_fajr.mp3",
            mecca_1: "https://www.islamcan.com/audio/adhan/azan1.mp3",
            mecca_2: "https://www.islamcan.com/audio/adhan/azan3.mp3",
            generic_1: "https://www.islamcan.com/audio/adhan/azan4.mp3",
            generic_2: "https://www.islamcan.com/audio/adhan/azan5.mp3",
            generic_3: "https://www.islamcan.com/audio/adhan/azan6.mp3",
            generic_4: "https://www.islamcan.com/audio/adhan/azan7.mp3",
        }
    },
    timezone: process.env.TIMEZONE || 'America/Los_Angeles',
    serverPort: parseInt(process.env.SERVER_PORT || 3001) // Dedicated port for serving audio
};

const SCHEDULE_FILE = path.join(__dirname, 'annual_schedule.json');
const AUDIO_DIR = path.join(__dirname, 'audio_cache');
const IMAGES_DIR = path.join(__dirname, '../images');

// --- UTILS ---
function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function getLocalIp() {
    // 1. Force retrieval from Env Variable (Best for Pi/Docker/Static setups)
    if (process.env.HOST_IP) {
        return process.env.HOST_IP;
    }

    // 2. Auto-detect (Fallback)
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

    // Downloads: Only download the named options.
    // 'adhan.mp3' is no longer a physical file, but a logical selection.
    const downloads = [];

    // Cache all options
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

const VisualGenerator = require('./visual_generator');
const visualGen = new VisualGenerator(CONFIG);

// --- STATIC SERVER ---
const app = express();
app.use('/audio', express.static(AUDIO_DIR));
app.use('/images', express.static(IMAGES_DIR));

// Dynamic Dashboard Endpoint
app.get('/dashboard/:prayer', async (req, res) => {
    try {
        const prayerName = req.params.prayer;
        // Basic fallback time if manually triggered, otherwise use actual
        // Ideally we pass context, but for now we generate "Current Time" type view
        const today = DateTime.now().setZone(CONFIG.timezone);
        const buffer = await visualGen.generateDashboard(
            prayerName.charAt(0).toUpperCase() + prayerName.slice(1),
            today.toFormat('h:mm a'),
            null // Hijri date will be enhanced later via Aladhan data integration
        );
        res.set('Content-Type', 'image/jpeg');
        res.send(buffer);
    } catch (e) {
        console.error("Dashboard Error:", e);
        res.status(500).send("Error generating dashboard");
    }
});

// --- VIDEO GENERATOR (Pre-flight) ---
function generateVideoFile(prayerName, audioFileName, prayerTime) {
    return new Promise(async (resolve, reject) => {
        const audioPath = path.join(AUDIO_DIR, audioFileName);
        const outputVideoPath = path.join(IMAGES_DIR, 'generated', `${prayerName.toLowerCase()}.mp4`);

        // 1. Generate Image
        const imgPath = path.join(IMAGES_DIR, 'generated', 'current_dashboard.jpg');
        // Ensure dir exists
        if (!fs.existsSync(path.dirname(imgPath))) fs.mkdirSync(path.dirname(imgPath), { recursive: true });

        const today = DateTime.now().setZone(CONFIG.timezone);
        // Use Scheduled Time for Display, or fallback to Now (e.g. Test Mode)
        const displayTime = prayerTime ? prayerTime.toFormat('h:mm a') : today.toFormat('h:mm a');

        // Hijri/Holiday Context
        let hijriDate = null;
        let holidays = [];
        try {
            if (fs.existsSync(SCHEDULE_FILE)) {
                const annualData = JSON.parse(fs.readFileSync(SCHEDULE_FILE));
                const m = today.month.toString();
                const d = today.day;
                if (annualData.data && annualData.data[m] && annualData.data[m][d - 1]) {
                    const h = annualData.data[m][d - 1].date.hijri;
                    hijriDate = `${h.day} ${h.month.en} ${h.year}`;
                    holidays = h.holidays || [];
                }
            }
        } catch (e) { console.error(e); }

        const isFriday = today.weekday === 5;

        try {
            const imgBuffer = await visualGen.generateDashboard(
                prayerName.charAt(0).toUpperCase() + prayerName.slice(1),
                displayTime,
                hijriDate,
                { holidays, isFriday }
            );
            fs.writeFileSync(imgPath, imgBuffer);
        } catch (e) {
            return reject(e);
        }

        // 2. Encode Video
        log(`🎬 Encoding ${prayerName} video (this takes ~60s)...`);

        ffmpeg()
            .input(imgPath)
            .inputOptions(['-loop 1']) // Correct way to loop image indefinitely
            .input(audioPath)
            .videoCodec('libx264')
            .audioCodec('aac')
            .audioFrequency(44100)
            .outputOptions([
                '-pix_fmt yuv420p',
                '-preset ultrafast', // Faster encoding for Pi
                '-profile:v baseline', // Max compatibility for Cast
                '-level 3.0',
                '-r 10', // 10 FPS (Sufficient for static image, saves CPU)
                '-movflags +faststart',
                '-shortest'
            ])
            .save(outputVideoPath) // Save to disk
            .on('end', () => {
                const stats = fs.statSync(outputVideoPath);
                log(`✅ Video Ready: ${outputVideoPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                resolve(outputVideoPath);
            })
            .on('error', (err) => {
                log(`❌ Encoding Error: ${err.message}`);
                reject(err);
            });
    });
}

app.listen(CONFIG.serverPort, () => {
    log(`🔊 Local Audio Server running at http://${getLocalIp()}:${CONFIG.serverPort}/audio/`);
});



// --- CASTING ENGINE WITH VOLUME CONTROL & TV SYNC ---
async function executePreFlightAndCast(prayerName, audioFileName, targetTimeObj) {
    log(`🚀 TRIGGER: ${prayerName} Time! Starting sequence...`);

    // 1. Pre-Generate Video (The Heavy Lift - takes ~1 min)
    // We do this BEFORE messing with the TV or Speaker
    try {
        await generateVideoFile(prayerName, audioFileName, targetTimeObj);
    } catch (e) {
        log(`❌ Video Generation Failed: ${e.message}`);
        return; // Abort
    }

    // 1b. Precision Wait
    // If we finished generation early (during the buffer), wait for the exact second.
    if (targetTimeObj) {
        const delay = targetTimeObj.toMillis() - Date.now();
        if (delay > 0) {
            log(`⏳ Video Ready. Waiting ${Math.round(delay / 1000)}s for precise prayer time...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    const localIp = getLocalIp();
    // Static File URL (Instant Playback)
    const castUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/${prayerName.toLowerCase()}.mp4?t=${Date.now()}`;
    log(`📡 Ready to Cast: ${castUrl}`);

    // Track devices
    let adhanDevice = null;
    let tvDevice = null;

    // --- ADB TV CONTROL (Android Debug Bridge) ---
    const TV_IP = process.env.TV_IP || '127.0.0.1';
    const { exec } = require('child_process');

    function adbCommand(cmd, retry = true) {
        return new Promise((resolve) => {
            exec(`adb ${cmd}`, { timeout: 5000 }, (error, stdout, stderr) => {
                if (error || (stdout && stdout.includes('offline'))) {
                    // Retry once if offline
                    if (retry && (error?.message.includes('offline') || stdout.includes('offline'))) {
                        log(`⚠️ ADB Device Offline. Reconnecting...`);
                        exec(`adb disconnect ${TV_IP} && adb connect ${TV_IP}`, { timeout: 5000 }, () => {
                            // Retry the original command without recursion loop
                            setTimeout(() => resolve(adbCommand(cmd, false)), 1000);
                        });
                        return;
                    }

                    if (error && error.message.includes('unauthorized')) {
                        log(`⚠️ ADB Authorization Missing! Please check TV screen.`);
                    }
                    // log(`⚠️ ADB Error (${cmd}): ${error ? error.message : stdout}`);
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
            const sessionOutput = await adbCommand('shell dumpsys media_session');
            if (sessionOutput && (sessionOutput.includes('state=3') || sessionOutput.includes('state=Playing'))) return MEDIA_PLAYING;
            if (sessionOutput && (sessionOutput.includes('state=2') || sessionOutput.includes('state=Paused'))) return MEDIA_PAUSED;

            const audioOutput = await adbCommand('shell dumpsys audio');
            const playersSection = audioOutput ? audioOutput.split('Audio event log:')[0] : '';
            const hasActiveMedia = playersSection.split('\n').some(line => {
                return (line.includes('usage=USAGE_MEDIA') || line.includes('usage=USAGE_GAME')) && line.includes('state:started');
            });

            if (hasActiveMedia) return MEDIA_PLAYING;
            return MEDIA_STOPPED;
        } catch (err) {
            return MEDIA_STOPPED;
        }
    }

    let tvWasInterrupted = false;
    let tvWasMuted = false;

    const resumeTvSafely = async () => {
        if (tvWasMuted) {
            log(`🔊  Unmuting TV...`);
            tvWasMuted = false;
            tvWasInterrupted = false;
            await adbCommand('shell input keyevent 164');
            return;
        }
        if (tvWasInterrupted) {
            log(`▶️  Resuming TV...`);
            tvWasInterrupted = false;
            await adbCommand('shell input keyevent 126');
        }
    };

    // 2. Control TV (Pause/Mute) - Just before casting
    const tvState = await checkTvMediaState();
    if (tvState === MEDIA_PLAYING) {
        log(`📺 TV is PLAYING. Sending PAUSE...`);
        await adbCommand('shell input keyevent 127');
        await new Promise(r => setTimeout(r, 1000));
        const newState = await checkTvMediaState();
        if (newState === MEDIA_PLAYING) {
            log(`⚠️ TV ignored PAUSE. Muting...`);
            await adbCommand('shell input keyevent 164');
            tvWasMuted = true;
        } else {
            tvWasInterrupted = true;
        }
    }

    // 3. Connect & Cast
    findAdhanSpeaker();

    function findAdhanSpeaker() {
        const Client = new ChromecastAPI();
        let isCleanedUp = false;
        let safetyTimer = null;

        const cleanup = () => {
            if (isCleanedUp) return;
            isCleanedUp = true;
            log(`🔄 Playback Ended. Restoring...`);
            resumeTvSafely();

            try {
                if (adhanDevice) {
                    // Suppress 'disconnect' error on already closed socket
                    try { adhanDevice.close(); } catch (e) { }
                }
            } catch (e) { console.error("Error closing device:", e.message); }

            if (safetyTimer) clearTimeout(safetyTimer);

            try {
                if (Client) Client.destroy();
            } catch (e) { console.error("Error destroying client:", e.message); }

            // If running in TEST mode, exit process to prevent hang
            if (process.argv.includes('--test')) {
                log("🧪 Test Complete. Exiting.");
                setTimeout(() => process.exit(0), 1000);
            }
        };

        debugLog('Scanning for devices...');
        const client = Client.on('device', function (device) {
            debugLog(`Found device: ${device.friendlyName} (${device.host})`);
            if (device.friendlyName === CONFIG.device.name) {
                // Prevent duplicate handling if device is discovered multiple times (IPv4/IPv6/mDNS)
                if (adhanDevice) {
                    debugLog(`Skipping duplicate discovery for ${device.friendlyName}`);
                    return;
                }

                adhanDevice = device;
                // Fix MaxListeners warning (just in case)
                device.setMaxListeners(20);

                // Handle manual disconnects (e.g. user stops casting via voice/app)
                device.on('close', () => {
                    log(`⚠️ Device Connection Closed externally.`);
                    cleanup();
                });

                log(`✅ Connected to Adhan Speaker: ${device.friendlyName}`);

                device.setVolume(CONFIG.device.targetVolume, (err) => {
                    const dashboardUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/current_dashboard.jpg?t=${Date.now()}`;

                    var media = {
                        url: castUrl,
                        contentType: 'video/mp4',
                        metadata: {
                            type: 1,
                            metadataType: 0,
                            title: `${prayerName} Adhan`,
                            images: [{ url: dashboardUrl }]
                        }
                    };
                    device.play(media, function (err) {
                        if (err) {
                            log(`❌ Playback Error: ${err.message}`);
                            cleanup();
                        } else {
                            log(`🎶 Playback Started!`);
                            // Safety Timer (Max 15 mins)
                            // Safety Timer (Max 10 mins)
                            safetyTimer = setTimeout(cleanup, 600000);

                            // Monitor via Events (No Polling = No Leaks)
                            let lastStatusTime = Date.now();
                            let lastState = '';
                            let lastStateChangeTime = Date.now();

                            const statusHandler = (status) => {
                                lastStatusTime = Date.now(); // Update heartbeat

                                if (status && status.playerState !== lastState) {
                                    log(`📊 Device Status: ${status.playerState}`);
                                    debugLog(`Full Status: ${JSON.stringify(status)}`);
                                    lastState = status.playerState;
                                    lastStateChangeTime = Date.now();
                                }

                                if (!status || status.playerState === 'IDLE') {
                                    log(`⏹️  Adhan Finished (IDLE).`);
                                    cleanup();
                                }
                            };

                            device.on('status', statusHandler);

                            // Explicit 'finished' event from library
                            device.on('finished', () => {
                                log(`⏹️  Adhan Finished (Event).`);
                                cleanup();
                            });

                            // Active Polling Loop (Serialized to prevent Listener Leaks)
                            // We MUST poll because 'status' events often stop firing automatically for Cast devices.
                            let pollingActive = true;
                            let consecutiveFailures = 0;

                            const pollLoop = async () => {
                                if (isCleanedUp || !pollingActive) return;

                                const now = Date.now();

                                // Watchdog 1: Connection Silence (No updates at all)
                                if (now - lastStatusTime > 300000) { // 5 mins
                                    log(`⚠️ Monitor Timeout (No updates for 5m). Cleanup.`);
                                    cleanup();
                                    return;
                                }

                                // Watchdog 2: Stuck in Non-Playing State (Paused/Buffering loop)
                                if ((lastState === 'PAUSED' || lastState === 'BUFFERING') && (now - lastStateChangeTime > 180000)) { // 3 mins
                                    log(`⚠️ Device Stuck in ${lastState} for 3m. Cleanup.`);
                                    cleanup();
                                    return;
                                }

                                try {
                                    debugLog(`Polling Status...`);
                                    const status = await new Promise((resolve, reject) => {
                                        const t = setTimeout(() => reject(new Error('Timeout')), 5000);
                                        device.getStatus((err, s) => {
                                            clearTimeout(t);
                                            if (err) reject(err);
                                            else resolve(s);
                                        });
                                    });

                                    // Success - Reset failure counter
                                    consecutiveFailures = 0;

                                    // Manually feed the handler
                                    statusHandler(status);

                                } catch (e) {
                                    consecutiveFailures++;
                                    debugLog(`Poll failed (${consecutiveFailures}/3): ${e.message}`);

                                    // If we fail 3 times in a row (15-20s), assume device is gone/stopped
                                    if (consecutiveFailures >= 3) {
                                        log(`⚠️ Connection Lost (3 failures). Assuming Playback Stopped.`);
                                        cleanup();
                                        return;
                                    }
                                }

                                // Schedule next poll ONLY after this one completes (Serial)
                                if (!isCleanedUp && pollingActive) {
                                    setTimeout(pollLoop, 3000); // 3s interval
                                }
                            };

                            pollLoop(); // Start the poker
                        }
                    });
                });
            }
        });
    }
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

        const PREP_BUFFER_MINUTES = 5; // Start generating 5 mins early (Safety for Pi)

        // Skip if the actual Prayer Time has already passed
        if (scheduleTime < DateTime.now().setZone(CONFIG.timezone)) {
            return;
        }

        const audioKey = prayer === 'Fajr' ? CONFIG.audio.fajrCurrent : CONFIG.audio.regularCurrent;
        const audioFile = `${audioKey}.mp3`;

        // Calculate Trigger Time (Pre-flight)
        let triggerTime = scheduleTime.minus({ minutes: PREP_BUFFER_MINUTES });

        // If system started within the buffer window (e.g. 1 min before), run immediately
        if (triggerTime < DateTime.now().setZone(CONFIG.timezone)) {
            triggerTime = DateTime.now().setZone(CONFIG.timezone).plus({ seconds: 2 }); // Give enough tick for job
        }

        schedule.scheduleJob(triggerTime.toJSDate(), function () {
            executePreFlightAndCast(prayer, audioFile, scheduleTime);
        });

        log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')})`);
    });
}

// --- STARTUP ---
log(`🚀 Adhan System v2.0 Starting...`);
scheduleToday();

// Daily Refresh at 1 AM
schedule.scheduleJob('0 1 * * *', scheduleToday);

// --- TEST MODE ---
// --- TEST MODE ---
if (process.argv.includes('--test')) {
    log("🧪 TEST TRIGGERED");

    // Allow forcing specific prayer via args (e.g. node scheduler.js --test --maghrib)
    const prayers = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
    const forcedPrayer = prayers.find(p => process.argv.includes(`--${p}`));

    const testName = forcedPrayer ? (forcedPrayer.charAt(0).toUpperCase() + forcedPrayer.slice(1)) : "Isha";
    const testKey = (testName === 'Fajr') ? CONFIG.audio.fajrCurrent : CONFIG.audio.regularCurrent;
    const testAudio = `${testKey}.mp3`;

    log(`🎯 Test Target: ${testName}`);

    setTimeout(async () => {
        await ensureAudioCache(); // Make sure we have files
        // Mock target time as 'Now' for test (pass null to skip precision wait)
        executePreFlightAndCast(testName, testAudio, null);
    }, 2000);
}
