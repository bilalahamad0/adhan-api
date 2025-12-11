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
        targetVolume: 0.3 // Updated to 0.3 (Level 3) as requested
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
const IMAGES_DIR = path.join(__dirname, '../images');

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
function generateVideoFile(prayerName, audioFileName) {
    return new Promise(async (resolve, reject) => {
        const audioPath = path.join(AUDIO_DIR, audioFileName);
        const outputVideoPath = path.join(IMAGES_DIR, 'generated', `${prayerName.toLowerCase()}.mp4`);

        // 1. Generate Image
        const imgPath = path.join(IMAGES_DIR, 'generated', 'current_dashboard.jpg');
        // Ensure dir exists
        if (!fs.existsSync(path.dirname(imgPath))) fs.mkdirSync(path.dirname(imgPath), { recursive: true });

        const today = DateTime.now().setZone(CONFIG.timezone);

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
                today.toFormat('h:mm a'), // Not used visually anymore but passed
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
                '-preset faster',
                '-profile:v main',
                '-level 3.1',
                '-movflags +faststart', // Optimized for web playback
                '-shortest' // Stop when audio ends
            ])
            .save(outputVideoPath) // Save to disk
            .on('end', () => {
                log(`✅ Video Ready: ${outputVideoPath}`);
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
// --- CASTING ENGINE WITH VOLUME CONTROL & TV SYNC ---
async function executePreFlightAndCast(prayerName, audioFileName, targetTimeObj) {
    log(`🚀 TRIGGER: ${prayerName} Time! Starting sequence...`);

    // 1. Pre-Generate Video (The Heavy Lift - takes ~1 min)
    // We do this BEFORE messing with the TV or Speaker
    try {
        await generateVideoFile(prayerName, audioFileName);
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
            if (adhanDevice) adhanDevice.close();
            if (safetyTimer) clearTimeout(safetyTimer);
            if (Client) Client.destroy();
        };

        const client = Client.on('device', function (device) {
            if (device.friendlyName === CONFIG.device.name) {
                adhanDevice = device;
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
                            // Safety Timer (Max 5 mins or Audio Length + Buffer)
                            // We rely on video ending naturally via -shortest
                            safetyTimer = setTimeout(cleanup, 360000);

                            // Monitor Loop
                            let lastStatusTime = Date.now();
                            const checkInterval = setInterval(() => {
                                if (isCleanedUp) {
                                    clearInterval(checkInterval);
                                    return;
                                }
                                if (Date.now() - lastStatusTime > 15000) {
                                    log(`⚠️ Monitor Timeout. Cleanup.`);
                                    clearInterval(checkInterval);
                                    cleanup();
                                    return;
                                }
                                try {
                                    device.getStatus((err, status) => {
                                        lastStatusTime = Date.now();
                                        if (err) { cleanup(); return; }
                                        if (!status || status.playerState === 'IDLE') {
                                            log(`⏹️  Adhan Finished.`);
                                            clearInterval(checkInterval);
                                            cleanup();
                                        }
                                    });
                                } catch (e) { cleanup(); }
                            }, 1000);
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

        const PREP_BUFFER_MINUTES = 2; // Start generating 2 mins early

        // Skip if the actual Prayer Time has already passed
        if (scheduleTime < DateTime.now().setZone(CONFIG.timezone)) {
            return;
        }

        const audioFile = prayer === 'Fajr' ? 'fajr.mp3' : 'adhan.mp3';

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
if (process.argv.includes('--test')) {
    log("🧪 TEST TRIGGERED");
    const isFajr = process.argv.includes('--fajr');
    const testAudio = isFajr ? "fajr.mp3" : "adhan.mp3";
    const testName = isFajr ? "Fajr" : "Isha";

    setTimeout(async () => {
        await ensureAudioCache(); // Make sure we have files
        executePreFlightAndCast(testName, testAudio);
    }, 2000);
}
