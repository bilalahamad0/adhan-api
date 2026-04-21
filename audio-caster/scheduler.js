const schedule = require('node-schedule');
const axios = require('axios');
require('events').EventEmitter.defaultMaxListeners = 25;
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
const HardwareService = require('./services/HardwareService');
const hardware = new HardwareService();

const DEBUG = process.argv.includes('--debug') || process.argv.includes('--test');
function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath('/usr/local/bin/ffmpeg');

// --- CONFIGURATION ---
const CONFIG = {
    location: {
        city: process.env.LOCATION_CITY || 'CityName',
        country: process.env.LOCATION_COUNTRY || 'CountryCode',
        lat: process.env.LOCATION_LAT || '0.0',
        lon: process.env.LOCATION_LON || '0.0',
        method: parseInt(process.env.LOCATION_METHOD || 2), // ISNA
        school: parseInt(process.env.LOCATION_SCHOOL || 1)
    },
    device: {
        name: process.env.DEVICE_NAME || 'Google Display',
        targetVolume: 0.55
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

// --- ENGINE (Phase 16: Zero-Latency Restoration) ---
async function executePreFlightAndCast(prayerName, audioFileName, targetTimeObj, prayerContext = null) {
    const localIp = getLocalIp();
    log(`🚀 TRIGGER: ${prayerName} Time! Starting pre-flight...`);

    const outputVideoPath = path.join(IMAGES_DIR, 'generated', `${prayerName.toLowerCase()}.mp4`);
    const audioPath = path.join(AUDIO_DIR, audioFileName);
    const imgPath = path.join(IMAGES_DIR, 'generated', 'current_dashboard.jpg');
    const generatedDuaPath = path.join(IMAGES_DIR, 'generated', 'dua.jpg');

    try {
        const today = DateTime.now().setZone(CONFIG.timezone);
        const VisualGenerator = require('./visual_generator.js');
        const vg = new VisualGenerator(CONFIG);

        // 1. Logic for Context (Hijri, Friday, Holidays)
        const hijri = prayerContext?.date?.hijri;
        const hijriStr = hijri ? `${hijri.day} ${hijri.month.en} ${hijri.year}` : null;
        const isFriday = today.weekday === 5;

        // 2. Weather Fetch for Baking
        const weather = await vg.getWeather();
        log(`⛅ Baking with weather: ${weather.temp}, Code: ${weather.code}`);

        // 3. Pre-generate Dashboard
        const imgBuffer = await vg.generateDashboard(
            prayerName,
            targetTimeObj ? targetTimeObj.toFormat('h:mm a') : today.toFormat('h:mm a'),
            hijriStr,
            { isFriday, holidays: hijri?.holidays || [] }
        );
        fs.mkdirSync(path.dirname(imgPath), { recursive: true });
        fs.writeFileSync(imgPath, imgBuffer);

        // 4. Pre-generate Stretched Dua
        const staticDuaPath = path.join(IMAGES_DIR, 'dua_after_adhan.png');
        const duaBuffer = await vg.generateDua(staticDuaPath);
        fs.writeFileSync(generatedDuaPath, duaBuffer);

        // 5. Select Weather Filter (v22 Audited Manual-Stitch)
        let filterChain = '[bg][weath]lut2=c0=\'x+y\':c1=\'x\':c2=\'x\',format=yuv420p[v]'; // Default Clear
        let weatherFilter = 'color=black:s=1280x800:d=5'; // Default constant black block

        if (weather.code >= 51 && weather.code <= 67) {
            log('🌧️  Condition: RAIN (v22 Dense)');
            weatherFilter = 'color=black:s=1280x800:d=5,noise=alls=100:allf=t+u,dblur=90:60';
        } else if (weather.code >= 71 && weather.code <= 77) {
            log('❄️  Condition: SNOW (v22 Slow Drift)');
            weatherFilter = 'color=black:s=1280x800:d=5,noise=alls=100:allf=t+u,scale=64:40:flags=neighbor,scale=1280:800:flags=neighbor,gblur=15,setpts=4.0*PTS';
        } else if (weather.code >= 45 && weather.code <= 48) {
            log('≡  Condition: FOG (v22 Patchy)');
            weatherFilter = 'color=black:s=1280x800:d=5,noise=alls=100:allf=t+u,scale=32:20:flags=neighbor,scale=1280:800:flags=neighbor,boxblur=50,scroll=h=0.03';
        }

        log(`🖼️  Baking Adhan Video (v22 Master)...`);

        // 6. Bake Video (Zero-Chroma Safety Profile)
        await new Promise((resolve, reject) => {
            ffmpeg()
                .input(imgPath).inputOptions(['-loop 1'])
                .input(audioPath)
                .complexFilter([
                    // Background Prep: Scale, Pad, and prepare standard YUV format
                    `[0:v]scale=1280:800,setsar=1,format=yuv420p[base]`,
                    
                    // Procedural Weather Mask: Generate black block + Noise/Motion within the same string
                    `color=black:s=1280x800:d=5,${weatherFilter},format=yuv420p[mask]`,
                    
                    // Final Stitch: Additive Luminance only on the brightness channel
                    `[base][mask]lut2=c0='x+y':c1='x':c2='x',format=yuv420p[v]`
                ])
                .outputOptions([
                    '-map [v]',
                    '-map 1:a',
                    '-c:v libx264',
                    '-pix_fmt yuvj420p',
                    '-color_range pc',
                    '-preset ultrafast',
                    '-tune stillimage',
                    '-shortest'
                ])
                .save(outputVideoPath)
                .on('end', () => {
                   log(`✅ Video Baked: ${path.basename(outputVideoPath)}`);
                   resolve();
                })
                .on('error', (err) => {
                   log(`❌ FFMPEG Error: ${err.message}`);
                   reject(err);
                });
        });
    } catch (e) { log(`❌ Generation Failed: ${e.message}`); return; }

    if (targetTimeObj) {
        const delay = targetTimeObj.toMillis() - Date.now();
        if (delay > 0) { log(`⏳ Waiting ${Math.round(delay / 1000)}s for precise time...`); await new Promise(r => setTimeout(r, delay)); }
    }

    const castUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/${prayerName.toLowerCase()}.mp4?t=${Date.now()}`;

    // ADB TV INTERRUPT (v23 State-Aware Muting)
    const tvIp = process.env.TV_IP;
    let tvWasInterrupted = false;
    let tvWasMutedByUs = false;

    if (tvIp) {
        try {
            log(`📺 Checking Sony TV (${tvIp})...`);
            // Ensure ADB is connected
            await hardware.adbCommand(tvIp + ":5555", "connect");

            const status = await hardware.getAudioStatus(tvIp + ":5555");
            log(`📺 Status: Playing=${status.isPlaying}, Muted=${status.isMuted}, Sony=${status.isSonyMuted}`);

            if (status.isPlaying) {
                log(`📺 TV is PLAYING. Sending ADB PAUSE...`);
                await hardware.pauseMedia(tvIp + ":5555");
                tvWasInterrupted = true;
            }

            // Composite Mute Check: If not muted by any standard, apply mute
            const isActuallyMuted = status.isSonyMuted === true || status.isMuted === true;
            if (!isActuallyMuted) {
                log(`🔇 TV is AUDIBLE. Sending ADB MUTE...`);
                tvWasMutedByUs = await hardware.setMuteState(tvIp + ":5555", true);
            }
        } catch (e) { log(`⚠️ ADB Check Failed: ${e.message}`); }
    }

    const Client = new ChromecastAPI();
    let adhanDevice = null;
    let isCleanedUp = false;
    let safetyTimer = null;
    let originalVolume = null;
    let currentPhase = 'ADHAN';

    const finalize = () => {
        if (isCleanedUp && currentPhase === 'DONE') return;
        isCleanedUp = true;
        currentPhase = 'DONE';

        log(`🔄 Finalizing: Hard terminating session...`);

        const performHardStop = async () => {
            if (tvWasInterrupted) await hardware.resumeMedia(tvIp + ":5555");
            if (tvWasMutedByUs) {
                log(`🔊 Adhan Finished. Restoring TV Volume (Unmuting)...`);
                await hardware.setMuteState(tvIp + ":5555", false);
            }

            const killSystem = () => {
                try {
                    if (adhanDevice) adhanDevice.close();
                    if (Client) Client.destroy();
                } catch (e) { }
                if (safetyTimer) clearTimeout(safetyTimer);
                if (process.argv.includes('--test')) {
                    log("🧪 Test Complete. Exiting.");
                    setTimeout(() => process.exit(0), 1000);
                }
            };

            try {
                if (adhanDevice && adhanDevice.client) {
                    // HARD STOP: Kill the receiver application itself
                    const receiver = adhanDevice.client.receiver;
                    if (receiver) {
                        log(`🛑 Sending RECEIVER STOP (Return to Clock)...`);
                        adhanDevice.client.stop(receiver, (err) => {
                            log(`✅ Receiver exited.`);
                            adhanDevice.client.close();
                            killSystem();
                        });
                    } else {
                        adhanDevice.client.close();
                        killSystem();
                    }
                } else { killSystem(); }
            } catch (e) { killSystem(); }
        };

        // 1. RESTORE VOLUME FIRST
        if (adhanDevice && originalVolume !== null) {
            log(`🔊 Restoring original volume to ${(originalVolume * 100).toFixed(0)}%...`);
            try {
                adhanDevice.setVolume(originalVolume, () => {
                    performHardStop();
                });
            } catch (e) {
                log(`⚠️ Volume restoration failed: ${e.message}`);
                performHardStop();
            }
        } else {
            performHardStop();
        }
    };


    const cleanup = () => {
        if (isCleanedUp) return;
        if (currentPhase === 'ADHAN') {
            log(`✨ Adhan Video Finished. Switching to Dua...`);
            if (safetyTimer) clearTimeout(safetyTimer);
            currentPhase = 'DUA';
            castDuaImage();
            return;
        }
        if (currentPhase === 'DUA') return; // Ignore status updates during 20s Dua
        finalize();
    };

    function castDuaImage() {
        // IMAGE IS ALREADY PRE-GENERATED AT THIS POINT (ZERO DELAY)
        const duaUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/dua.jpg?t=${Date.now()}`;
        const media = {
            url: duaUrl, contentType: 'image/jpeg',
            metadata: { type: 0, metadataType: 0, title: `Dua After Adhan`, images: [{ url: duaUrl }] }
        };
        log(`🤲 Casting Stretched Dua (Instant Switch): ${duaUrl}`);
        adhanDevice.play(media, (err) => {
            if (err) finalize();
            else safetyTimer = setTimeout(() => { log(`✅ Dua Complete.`); finalize(); }, 20000);
        });
    }

    // --- CASTING ENGINE ---
    const discoveryTimeout = setTimeout(() => {
        if (!adhanDevice && !isCleanedUp) {
            log(`❌ Discovery Timeout: Device "${CONFIG.device.name}" not found after 30s.`);
            finalize();
        }
    }, 30000);

    Client.on('error', (err) => {
        log(`❌ Chromecast Client Error: ${err.message}`);
        finalize();
    });

    Client.on('device', (device) => {
        if (device.friendlyName === CONFIG.device.name) {
            if (adhanDevice || isCleanedUp) return;
            adhanDevice = device;
            clearTimeout(discoveryTimeout);
            log(`✅ Connected to Adhan Speaker: ${device.friendlyName}`);

            device.on('error', (err) => {
                log(`❌ Device Error: ${err.message}`);
                finalize();
            });

            const startPlayback = () => {
                if (isCleanedUp) return;
                const dashboardUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/current_dashboard.jpg?t=${Date.now()}`;
                const media = {
                    url: castUrl,
                    contentType: 'video/mp4',
                    metadata: {
                        type: 1,
                        metadataType: 0,
                        title: `${prayerName} Adhan`,
                        images: [{ url: dashboardUrl }]
                    }
                };

                try {
                    log(`🎶 Starting Playback: ${prayerName}...`);
                    device.play(media, (err) => {
                        if (err) {
                            log(`❌ Play Command Failed: ${err.message}`);
                            finalize();
                        } else {
                            log(`🎶 Playback Started Successfully!`);
                            if (safetyTimer) clearTimeout(safetyTimer);
                            safetyTimer = setTimeout(finalize, 600000); // 10m safety

                            let lastState = '';
                            device.on('status', (s) => {
                                if (s && s.playerState !== lastState) {
                                    log(`📊 Status Update: ${s.playerState}`);
                                    lastState = s.playerState;
                                }
                                if (!s || s.playerState === 'IDLE') {
                                    log(`⏹️  Playback Finished.`);
                                    cleanup();
                                }
                            });
                        }
                    });
                } catch (e) {
                    log(`❌ Exception during device.play(): ${e.message}`);
                    finalize();
                }
            };

            // Volume and Play Sequence
            try {
                device.getReceiverStatus((err, status) => {
                    if (!err && status && status.volume) {
                        originalVolume = status.volume.level;
                    }

                    log(`🔊 Setting Volume to ${CONFIG.device.targetVolume}...`);
                    try {
                        device.setVolume(CONFIG.device.targetVolume, (volErr) => {
                            if (volErr) log(`⚠️ Volume set error (non-fatal): ${volErr.message}`);
                            startPlayback();
                        });
                    } catch (vEx) {
                        log(`⚠️ Volume exception (non-fatal): ${vEx.message}`);
                        startPlayback();
                    }
                });
            } catch (e) {
                log(`❌ Critical Exception during device interaction: ${e.message}`);
                finalize();
            }
        }
    });

}



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

        schedule.scheduleJob(triggerTime.toJSDate(), () => executePreFlightAndCast(prayer, audioFile, scheduleTime, todayEntry));
        log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')})`);
    });
}

log(`🚀 Adhan System Starting (Zero-Latency Restore)...`);
scheduleToday();
const dailyScheduleRule = new schedule.RecurrenceRule();
dailyScheduleRule.hour = 0;
dailyScheduleRule.minute = 0;
dailyScheduleRule.tz = CONFIG.timezone;
schedule.scheduleJob(dailyScheduleRule, scheduleToday);

if (process.argv.includes('--test')) {
    log("🧪 TEST TRIGGERED");
    CONFIG.device.targetVolume = 0.10;
    const prayersList = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
    const forcedReq = process.argv.find((arg) => prayersList.includes(arg.replace('--', '').toLowerCase()));
    const testName = forcedReq ? (forcedReq.replace('--', '').charAt(0).toUpperCase() + forcedReq.replace('--', '').slice(1).toLowerCase()) : 'Isha';
    const testAudio = `${testName === 'Fajr' ? CONFIG.audio.fajrCurrent : CONFIG.audio.regularCurrent}.mp3`;
    log(`🎯 Test Target: ${testName}`);
    setTimeout(() => executePreFlightAndCast(testName, testAudio, null), 2000);
}
