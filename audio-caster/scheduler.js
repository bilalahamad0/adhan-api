const express = require('express');
const schedule = require('node-schedule');
const { DateTime } = require('luxon');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { exec } = require('child_process');
const ChromecastAPI = require('chromecast-api');
require('dotenv').config();

// --- CONFIGURATION ---
const CONFIG = {
  location: {
    city: process.env.LOCATION_CITY || 'Sunnyvale',
    country: process.env.LOCATION_COUNTRY || 'US',
    method: parseInt(process.env.LOCATION_METHOD || 2), // ISNA
    school: parseInt(process.env.LOCATION_SCHOOL || 1), // Hanafi
  },
  device: {
    name: process.env.DEVICE_NAME || 'Google Display',
    targetVolume: 0.55,
  },
  audio: {
    fajrCurrent: 'fajr',
    regularCurrent: 'generic_3',
    options: {
      fajr: "https://raw.githubusercontent.com/AalianKhan/adhans/master/adhan_fajr.mp3",
      mecca_1: "https://www.islamcan.com/audio/adhan/azan1.mp3",
      mecca_2: "https://www.islamcan.com/audio/adhan/azan3.mp3",
      generic_1: "https://www.islamcan.com/audio/adhan/azan4.mp3",
      generic_2: "https://www.islamcan.com/audio/adhan/azan5.mp3",
      generic_3: "https://www.islamcan.com/audio/adhan/azan6.mp3",
      generic_4: "https://www.islamcan.com/audio/adhan/azan7.mp3",
    },
  },
  timezone: process.env.TIMEZONE || 'America/Los_Angeles',
  serverPort: parseInt(process.env.SERVER_PORT || 3001),
};

const SCHEDULE_FILE = path.join(__dirname, 'annual_schedule.json');
const AUDIO_DIR = path.join(__dirname, 'audio');
const IMAGES_DIR = path.join(__dirname, '..', 'images');

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

// --- MEDIA SERVER (EXPRESS) ---
const app = express();
app.use('/audio', express.static(AUDIO_DIR));
app.use('/images', express.static(IMAGES_DIR));

app.listen(CONFIG.serverPort, () => {
    log(`🔊 Media Server running on port ${CONFIG.serverPort}`);
});

// --- CORE UTILITIES ---
function getLocalIp() {
    return require('ip').address();
}

async function adbCommand(ip, cmd) {
    return new Promise((resolve, reject) => {
        exec(`adb -s ${ip}:5555 ${cmd}`, (error, stdout) => {
            if (error) resolve(null);
            else resolve(stdout);
        });
    });
}

// --- CORE EXECUTION ENGINE (LEGACY 603858cf PORT) ---
async function executePreFlightAndCast(prayerName, audioFileName, targetTimeObj) {
    log(`🚀 TRIGGER: ${prayerName} Time! Starting sequence...`);

    // 1. Image & Video Generation
    const outputVideoPath = path.join(IMAGES_DIR, 'generated', `${prayerName.toLowerCase()}.mp4`);
    const audioPath = path.join(AUDIO_DIR, audioFileName);
    const imgPath = path.join(IMAGES_DIR, 'generated', 'current_dashboard.jpg');

    try {
        const today = DateTime.now().setZone(CONFIG.timezone);
        const displayTime = targetTimeObj ? targetTimeObj.toFormat('h:mm a') : today.toFormat('h:mm a');
        
        const VisualGenerator = require('./visual_generator.js');
        const vg = new VisualGenerator(CONFIG);
        const imgBuffer = await vg.generateDashboard(prayerName, displayTime, null, {});
        fs.mkdirSync(path.dirname(imgPath), { recursive: true });
        fs.writeFileSync(imgPath, imgBuffer);

        // Encoding via FFmpeg (Requires fluent-ffmpeg)
        await new Promise((resolve, reject) => {
            const ffmpeg = require('fluent-ffmpeg');
            ffmpeg()
                .input(imgPath).loop(1)
                .input(audioPath)
                .outputOptions('-c:v libx264', '-tune stillimage', '-c:a aac', '-b:a 192k', '-pix_fmt yuv420p', '-shortest')
                .save(outputVideoPath)
                .on('end', resolve)
                .on('error', reject);
        });
    } catch (e) {
        log(`❌ Generation Failed: ${e.message}`);
        return;
    }

    if (targetTimeObj) {
        const delay = targetTimeObj.toMillis() - Date.now();
        if (delay > 0) {
            log(`⏳ Waiting ${Math.round(delay / 1000)}s for precise time...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    const localIp = getLocalIp();
    const castUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/${prayerName.toLowerCase()}.mp4?t=${Date.now()}`;

    // 2. Hardware Control (ADB)
    const tvIp = process.env.TV_IP;
    let tvWasInterrupted = false;
    if (tvIp) {
        try {
            const session = await adbCommand(tvIp, 'shell dumpsys media_session');
            if (session && (session.includes('state=3') || session.includes('state=Playing'))) {
                log(`📺 TV is PLAYING. Sending ADB PAUSE...`);
                await adbCommand(tvIp, 'shell input keyevent 127');
                tvWasInterrupted = true;
            }
        } catch (e) { log(`⚠️ TV ADB Error: ${e.message}`); }
    }

    // 3. Connect & Cast (LEGACY CLOSURE - ABSOLUTE PARITY)
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
        log(`🔄 Playback Ended. Starting cleanup...`);
        
        if (tvWasInterrupted) adbCommand(tvIp, 'shell input keyevent 126');

        const finalize = () => {
            try {
                if (adhanDevice) {
                    if (adhanDevice.stop) adhanDevice.stop();
                    if (adhanDevice.client) adhanDevice.client.close();
                    adhanDevice.close();
                }
            } catch (e) { }

            if (safetyTimer) clearTimeout(safetyTimer);
            try { if (Client) Client.destroy(); } catch (e) { }

            if (process.argv.includes('--test')) {
                log("🧪 Test Complete. Exiting.");
                setTimeout(() => process.exit(0), 1000);
            }
        };

        if (adhanDevice && originalVolume !== null) {
            log(`🔊 Restoring Volume...`);
            adhanDevice.setVolume(originalVolume, (err) => {
                setTimeout(finalize, 500);
            });
        } else {
            finalize();
        }
    };

    function castDuaImage() {
        const VisualGenerator = require('./visual_generator.js');
        const vg = new VisualGenerator(CONFIG);
        const staticDuaPath = path.join(IMAGES_DIR, 'dua_after_adhan.png');
        const generatedDuaPath = path.join(IMAGES_DIR, 'generated', 'dua.jpg');
        
        vg.generateDua(staticDuaPath).then(buffer => {
            fs.writeFileSync(generatedDuaPath, buffer);
            const duaUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/dua.jpg?t=${Date.now()}`;
            const media = {
                url: duaUrl,
                contentType: 'image/jpeg',
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

                device.setVolume(CONFIG.device.targetVolume, (err) => {
                    const dashboardUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/current_dashboard.jpg?t=${Date.now()}`;
                    const media = {
                        url: castUrl,
                        contentType: 'video/mp4',
                        metadata: {
                            type: 1, metadataType: 0, title: `${prayerName} Adhan`,
                            images: [{ url: dashboardUrl }]
                        }
                    };

                    device.play(media, (err) => {
                        if (err) cleanup();
                        else {
                            log(`🎶 Playback Started!`);
                            safetyTimer = setTimeout(cleanup, 600000);
                            
                            let lastState = '';
                            device.on('status', (status) => {
                                if (status && status.playerState !== lastState) {
                                    log(`📊 Device Status: ${status.playerState}`);
                                    lastState = status.playerState;
                                }
                                if (!status || status.playerState === 'IDLE') {
                                    log(`⏹️ Adhan Finished (IDLE).`);
                                    cleanup();
                                }
                            });

                            device.on('finished', () => {
                                log(`⏹️ Adhan Finished (Event).`);
                                cleanup();
                            });
                        }
                    });
                });
            });
        }
    });
}

// --- SCHEDULER ENGINE ---
async function scheduleToday() {
    log("📅 Loading Schedule...");

    let annualData;
    if (fs.existsSync(SCHEDULE_FILE)) {
        try { annualData = JSON.parse(fs.readFileSync(SCHEDULE_FILE)); } catch (e) { }
    }

    const currentYear = DateTime.now().setZone(CONFIG.timezone).toFormat('yyyy');
    if (!annualData || annualData.year !== currentYear) {
        log(`🔄 Fetching Annual Data for ${currentYear}...`);
        try {
            const url = `http://api.aladhan.com/v1/calendarByCity/${currentYear}?city=${CONFIG.location.city}&country=${CONFIG.location.country}&method=${CONFIG.location.method}&annual=true`;
            const response = await axios.get(url);
            annualData = { year: currentYear, data: response.data.data };
            fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(annualData, null, 2));
        } catch (error) { log("❌ Fetch Error."); return; }
    }

    const today = DateTime.now().setZone(CONFIG.timezone);
    const monthData = annualData.data[today.month.toString()];
    const todayEntry = monthData.find(d => parseInt(d.date.gregorian.day) === today.day);
    if (!todayEntry) return log("❌ Day missing.");

    log(`✅ Today's Prayer Times (${todayEntry.date.readable}):`);
    const prayers = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

    prayers.forEach(prayer => {
        let timeStr = todayEntry.timings[prayer].split(' ')[0];
        const [hours, minutes] = timeStr.split(':');
        const scheduleTime = today.set({ hour: parseInt(hours), minute: parseInt(minutes), second: 0 });

        if (scheduleTime < DateTime.now().setZone(CONFIG.timezone)) return;

        const audioKey = prayer === 'Fajr' ? CONFIG.audio.fajrCurrent : CONFIG.audio.regularCurrent;
        const audioFile = `${audioKey}.mp3`;
        let triggerTime = scheduleTime.minus({ minutes: 5 });
        if (triggerTime < DateTime.now().setZone(CONFIG.timezone)) {
            triggerTime = DateTime.now().setZone(CONFIG.timezone).plus({ seconds: 2 });
        }

        schedule.scheduleJob(triggerTime.toJSDate(), () => executePreFlightAndCast(prayer, audioFile, scheduleTime));
        log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')})`);
    });
}

// --- STARTUP ---
log(`🚀 Adhan System Starting (Root Mode)...`);
scheduleToday();

// Daily Refresh
schedule.scheduleJob('0 1 * * *', scheduleToday);

// --- TEST MODE ---
if (process.argv.includes('--test')) {
    log("🧪 TEST TRIGGERED");
    CONFIG.device.targetVolume = 0.10;
    
    const prayers = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
    const forcedReq = process.argv.find((arg) => prayers.includes(arg.toLowerCase()));
    const testName = forcedReq ? forcedReq.charAt(0).toUpperCase() + forcedReq.slice(1).toLowerCase() : 'Isha';
    
    const testKey = testName === 'Fajr' ? CONFIG.audio.fajrCurrent : CONFIG.audio.regularCurrent;
    const testAudio = `${testKey}.mp3`;

    log(`🎯 Test Target: ${testName}`);
    setTimeout(() => executePreFlightAndCast(testName, testAudio, null), 2000);
}
