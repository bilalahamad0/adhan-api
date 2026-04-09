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

const DEBUG = process.argv.includes('--debug') || process.argv.includes('--test');
function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
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
        targetVolume: 0.55 // Level 5.5 (Range 0.0-1.0)
    },
    audio: {
        fajrCurrent: "fajr",
        regularCurrent: "generic_3",
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
    serverPort: parseInt(process.env.SERVER_PORT || 3001)
};

const SCHEDULE_FILE = path.join(__dirname, 'annual_schedule.json');
const AUDIO_DIR = path.join(__dirname, 'audio');
const IMAGES_DIR = path.join(__dirname, '..', 'images');

// --- MEDIA SERVER ---
const app = express();
app.use('/audio', express.static(AUDIO_DIR));
app.use('/images', express.static(IMAGES_DIR));

app.listen(CONFIG.serverPort, () => {
    log(`🔊 Media Server running on port ${CONFIG.serverPort}`);
});

// --- UTILS ---
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return 'localhost';
}

async function ensureAudioCache() {
    if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
    const prayers = ['fajr', 'generic_3'];
    for (const key of prayers) {
        const url = CONFIG.audio.options[key];
        const filePath = path.join(AUDIO_DIR, `${key}.mp3`);
        if (!fs.existsSync(filePath)) {
            log(`📥 Downloading ${key}...`);
            try {
                const res = await axios({ method: 'get', url, responseType: 'stream' });
                await pipeline(res.data, fs.createWriteStream(filePath));
            } catch (e) { log(`❌ Error downloading ${key}: ${e.message}`); }
        }
    }
}

// --- ENGINE (603858cf LITERAL Restoration) ---
async function executePreFlightAndCast(prayerName, audioFileName, targetTimeObj) {
    const localIp = getLocalIp();
    log(`🚀 TRIGGER: ${prayerName} Time! Starting sequence...`);

    const outputVideoPath = path.join(IMAGES_DIR, 'generated', `${prayerName.toLowerCase()}.mp4`);
    const audioPath = path.join(AUDIO_DIR, audioFileName);
    const imgPath = path.join(IMAGES_DIR, 'generated', 'current_dashboard.jpg');

    try {
        const today = DateTime.now().setZone(CONFIG.timezone);
        const VisualGenerator = require('./visual_generator.js');
        const vg = new VisualGenerator(CONFIG);
        const imgBuffer = await vg.generateDashboard(prayerName, targetTimeObj ? targetTimeObj.toFormat('h:mm a') : today.toFormat('h:mm a'), null, {});
        fs.mkdirSync(path.dirname(imgPath), { recursive: true });
        fs.writeFileSync(imgPath, imgBuffer);

        // Encoding via FFmpeg (603858cf Literal Block)
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(imgPath)
                .inputOptions(['-loop 1']) 
                .input(audioPath)
                .videoCodec('libx264')
                .audioCodec('aac')
                .audioFrequency(44100)
                .outputOptions([
                    '-pix_fmt yuv420p',
                    '-preset ultrafast', 
                    '-profile:v baseline', 
                    '-level 3.0',
                    '-tune stillimage',
                    '-shortest'
                ])
                .save(outputVideoPath)
                .on('end', resolve)
                .on('error', reject);
        });
    } catch (e) { log(`❌ Generation Failed: ${e.message}`); return; }

    if (targetTimeObj) {
        const delay = targetTimeObj.toMillis() - Date.now();
        if (delay > 0) { log(`⏳ Waiting ${Math.round(delay/1000)}s...`); await new Promise(r => setTimeout(r, delay)); }
    }

    const castUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/${prayerName.toLowerCase()}.mp4?t=${Date.now()}`;

    // ADB
    const tvIp = process.env.TV_IP;
    let tvWasInterrupted = false;
    if (tvIp) {
        try {
            const res = await new Promise(resolve => {
                exec(`adb -s ${tvIp}:5555 shell dumpsys media_session`, (e, stdout) => resolve(stdout));
            });
            if (res && (res.includes('state=3') || res.includes('state=Playing'))) {
                log(`📺 TV is PLAYING. Sending ADB PAUSE...`);
                exec(`adb -s ${tvIp}:5555 shell input keyevent 127`);
                tvWasInterrupted = true;
            }
        } catch (e) { }
    }

    // CAST CLOSURE (Literal)
    const Client = new ChromecastAPI();
    let adhanDevice = null;
    let isCleanedUp = false;
    let safetyTimer = null;
    let originalVolume = null;
    let currentPhase = 'ADHAN';

    const cleanup = () => {
        if (isCleanedUp) return;
        if (currentPhase === 'ADHAN') {
            log(`✨ Adhan Video Finished. Switching to Dua...`);
            if (safetyTimer) clearTimeout(safetyTimer);
            currentPhase = 'DUA';
            castDuaImage();
            return;
        }
        if (currentPhase === 'DUA') return;

        isCleanedUp = true;
        currentPhase = 'DONE';
        log(`🔄 Playback Ended. Cleaning up...`);
        if (tvWasInterrupted) exec(`adb -s ${tvIp}:5555 shell input keyevent 126`);

        const finalize = () => {
            try {
                if (adhanDevice) {
                    if (adhanDevice.stop) adhanDevice.stop();
                    if (adhanDevice.client) adhanDevice.client.close();
                    adhanDevice.close();
                }
                if (Client) Client.destroy();
            } catch (e) { }
            if (safetyTimer) clearTimeout(safetyTimer);
            if (process.argv.includes('--test')) {
                log("🧪 Test Complete. Exiting.");
                setTimeout(() => process.exit(0), 1000);
            }
        };

        if (adhanDevice && originalVolume !== null) {
            log(`🔊 Restoring Volume...`);
            adhanDevice.setVolume(originalVolume, () => setTimeout(finalize, 500));
        } else finalize();
    };

    function castDuaImage() {
        // USE STRETCHED GENERATOR (Confirmed Fix)
        const VisualGenerator = require('./visual_generator.js');
        const vg = new VisualGenerator(CONFIG);
        const staticDuaPath = path.join(IMAGES_DIR, 'dua_after_adhan.png');
        const generatedDuaPath = path.join(IMAGES_DIR, 'generated', 'dua.jpg');
        
        vg.generateDua(staticDuaPath).then(buffer => {
            fs.writeFileSync(generatedDuaPath, buffer);
            const duaUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/dua.jpg?t=${Date.now()}`;
            const media = {
                url: duaUrl, contentType: 'image/jpeg',
                metadata: { type: 0, metadataType: 0, title: `Dua After Adhan`, images: [{ url: duaUrl }] }
            };
            log(`🤲 Casting Stretched Dua: ${duaUrl}`);
            adhanDevice.play(media, (err) => {
                if (err) cleanup();
                else safetyTimer = setTimeout(() => { log(`✅ Dua Complete.`); currentPhase = 'DONE'; cleanup(); }, 20000);
            });
        }).catch(() => cleanup());
    }

    Client.on('device', (device) => {
        if (device.friendlyName === CONFIG.device.name) {
            if (adhanDevice) return;
            adhanDevice = device;
            log(`✅ Connected to Adhan Speaker: ${device.friendlyName}`);

            device.getReceiverStatus((err, status) => {
                if (!err && status && status.volume) originalVolume = status.volume.level;
                device.setVolume(CONFIG.device.targetVolume, () => {
                    const dashboardUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/current_dashboard.jpg?t=${Date.now()}`;
                    const media = {
                        url: castUrl, contentType: 'video/mp4',
                        metadata: { type: 1, metadataType: 0, title: `${prayerName} Adhan`, images: [{ url: dashboardUrl }] }
                    };
                    device.play(media, (err) => {
                        if (err) cleanup();
                        else {
                            log(`🎶 Playback Started!`);
                            safetyTimer = setTimeout(cleanup, 600000);
                            let lastState = '';
                            device.on('status', (s) => {
                                if (s && s.playerState !== lastState) { log(`📊 Status: ${s.playerState}`); lastState = s.playerState; }
                                if (!s || s.playerState === 'IDLE') { log(`⏹️  Finished.`); cleanup(); }
                            });
                        }
                    });
                });
            });
        }
    });
}

// --- SCHEDULER ---
async function scheduleToday() {
    log("📅 Loading Schedule...");
    let annualData;
    if (fs.existsSync(SCHEDULE_FILE)) {
        try { annualData = JSON.parse(fs.readFileSync(SCHEDULE_FILE)); } catch (e) { }
    }
    const currentYear = DateTime.now().setZone(CONFIG.timezone).toFormat('yyyy');
    if (!annualData || annualData.year !== currentYear) {
        log(`🔄 Initialzing Annual Data for ${currentYear}...`);
        try {
            const url = `http://api.aladhan.com/v1/calendarByCity/${currentYear}?city=${CONFIG.location.city}&country=${CONFIG.location.country}&method=${CONFIG.location.method}&annual=true`;
            const response = await axios.get(url);
            annualData = { year: currentYear, data: response.data.data };
            fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(annualData, null, 2));
        } catch (error) { log("❌ Fetch Error."); return; }
    }
    await ensureAudioCache();
    const today = DateTime.now().setZone(CONFIG.timezone);
    const monthData = annualData.data[today.month.toString()];
    const todayEntry = monthData.find(d => parseInt(d.date.gregorian.day) === today.day);
    if (!todayEntry) return log("❌ Calendar Error.");

    log(`✅ Today's Prayer Times (${todayEntry.date.readable}):`);
    const prayers = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
    prayers.forEach(prayer => {
        let timeStr = todayEntry.timings[prayer].split(' ')[0];
        const [hours, minutes] = timeStr.split(':');
        const scheduleTime = today.set({ hour: parseInt(hours), minute: parseInt(minutes), second: 0 });
        if (scheduleTime < DateTime.now().setZone(CONFIG.timezone)) return;

        const audioFile = `${prayer === 'Fajr' ? CONFIG.audio.fajrCurrent : CONFIG.audio.regularCurrent}.mp3`;
        let triggerTime = scheduleTime.minus({ minutes: 5 });
        if (triggerTime < DateTime.now().setZone(CONFIG.timezone)) triggerTime = DateTime.now().setZone(CONFIG.timezone).plus({ seconds: 2 });

        schedule.scheduleJob(triggerTime.toJSDate(), () => executePreFlightAndCast(prayer, audioFile, scheduleTime));
        log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')})`);
    });
}

// --- STARTUP ---
log(`🚀 Adhan System v2.0 Starting (LITERAL Restoration)...`);
scheduleToday();
schedule.scheduleJob('0 1 * * *', scheduleToday);

// TEST
if (process.argv.includes('--test')) {
    log("🧪 TEST TRIGGERED");
    CONFIG.device.targetVolume = 0.10;
    const testTarget = "Isha"; 
    const testAudio = `${CONFIG.audio.regularCurrent}.mp3`;
    setTimeout(() => executePreFlightAndCast(testTarget, testAudio, null), 2000);
}
