const schedule = require('node-schedule');
const { DateTime } = require('luxon');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { exec } = require('child_process');
const ChromecastAPI = require('chromecast-api');

/**
 * CoreScheduler V10: THE CLEAN REVERSION
 * Structurally identical to commit 603858cf.
 * No classes or services are touched during the casting flow.
 */
class CoreScheduler {
    constructor(config, hardwareService, mediaService, castService, scheduleFilePath) {
        this.config = config;
        this.media = mediaService;
        this.scheduleFilePath = scheduleFilePath;
        this.log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
        this.executePreFlightAndCast = this.executePreFlightAndCast.bind(this);
    }

    async scheduleToday() {
        const config = this.config;
        const log = this.log;
        log("📅 Loading Schedule...");

        let annualData;
        if (fs.existsSync(this.scheduleFilePath)) {
            try { annualData = JSON.parse(fs.readFileSync(this.scheduleFilePath)); } catch (e) { }
        }

        const currentYear = DateTime.now().setZone(config.timezone).toFormat('yyyy');
        if (!annualData || annualData.year !== currentYear) {
            log(`🔄 Fetching Annual Data for ${currentYear}...`);
            try {
                const url = `http://api.aladhan.com/v1/calendarByCity/${currentYear}?city=${config.location.city}&country=${config.location.country}&method=${config.location.method}&annual=true`;
                const response = await axios.get(url);
                annualData = { year: currentYear, data: response.data.data };
                fs.writeFileSync(this.scheduleFilePath, JSON.stringify(annualData, null, 2));
            } catch (error) { log("❌ Fetch Error."); return; }
        }

        const today = DateTime.now().setZone(config.timezone);
        const monthData = annualData.data[today.month.toString()];
        const todayEntry = monthData.find(d => parseInt(d.date.gregorian.day) === today.day);
        if (!todayEntry) return log("❌ Day missing.");

        log(`✅ Today's Prayer Times (${todayEntry.date.readable}):`);
        const prayers = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
        prayers.forEach(prayer => {
            let timeStr = todayEntry.timings[prayer].split(' ')[0];
            const [hours, minutes] = timeStr.split(':');
            const scheduleTime = today.set({ hour: parseInt(hours), minute: parseInt(minutes), second: 0 });

            if (scheduleTime < DateTime.now().setZone(config.timezone)) return;

            const audioKey = prayer === 'Fajr' ? config.audio.fajrCurrent : config.audio.regularCurrent;
            const audioFile = `${audioKey}.mp3`;
            let triggerTime = scheduleTime.minus({ minutes: 5 });
            if (triggerTime < DateTime.now().setZone(config.timezone)) {
                triggerTime = DateTime.now().setZone(config.timezone).plus({ seconds: 2 });
            }

            schedule.scheduleJob(triggerTime.toJSDate(), () => this.executePreFlightAndCast(prayer, audioFile, scheduleTime));
            log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')})`);
        });
    }

    /**
     * 1:1 LEGACY STRUCTURAL PORT (NO SERVICES, NO CLASSES, NO LEAKS)
     */
    async executePreFlightAndCast(prayerName, audioFileName, targetTimeObj) {
        const log = this.log;
        const CONFIG = this.config;
        const mediaService = this.media;
        const localIp = require('ip').address();

        log(`🚀 TRIGGER: ${prayerName} Time! Starting sequence...`);

        // 1. Assets
        const outputVideoPath = path.join(__dirname, '..', '..', 'images', 'generated', `${prayerName.toLowerCase()}.mp4`);
        const audioPath = path.join(__dirname, '..', 'audio', audioFileName);
        const imgPath = path.join(__dirname, '..', '..', 'images', 'generated', 'current_dashboard.jpg');

        try {
            const today = DateTime.now().setZone(CONFIG.timezone);
            const VisualGenerator = require('../visual_generator.js');
            const vg = new VisualGenerator(CONFIG);
            const imgBuffer = await vg.generateDashboard(prayerName, targetTimeObj ? targetTimeObj.toFormat('h:mm a') : today.toFormat('h:mm a'), null, {});
            fs.mkdirSync(path.dirname(imgPath), { recursive: true });
            fs.writeFileSync(imgPath, imgBuffer);
            await mediaService.encodeVideoFromImageAndAudio(imgPath, audioPath, outputVideoPath);
        } catch (e) { log(`❌ Generation Failed: ${e.message}`); return; }

        if (targetTimeObj) {
            const delay = targetTimeObj.toMillis() - Date.now();
            if (delay > 0) { log(`⏳ Waiting ${Math.round(delay/1000)}s...`); await new Promise(r => setTimeout(r, delay)); }
        }

        const castUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/${prayerName.toLowerCase()}.mp4?t=${Date.now()}`;

        // 2. Hardware (RAW ADB)
        const tvIp = process.env.TV_IP;
        let tvWasInterrupted = false;

        const adbAction = (cmd) => new Promise((resolve) => {
            if (!tvIp) return resolve();
            exec(`adb -s ${tvIp}:5555 ${cmd}`, (err, stdout) => resolve(stdout));
        });

        if (tvIp) {
            const session = await adbAction('shell dumpsys media_session');
            if (session && (session.includes('state=3') || session.includes('state=Playing'))) {
                log(`📺 TV is PLAYING. Sending PAUSE...`);
                await adbAction('shell input keyevent 127');
                tvWasInterrupted = true;
            }
        }

        // 3. Connect & Cast (STRICT LEGACY)
        const scanner = new ChromecastAPI();
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
            
            if (tvWasInterrupted) adbAction('shell input keyevent 126');

            const finalize = () => {
                log(`🔄 Finalize: Hard destroying session...`);
                try {
                    if (adhanDevice) {
                        if (adhanDevice.stop) adhanDevice.stop();
                        if (adhanDevice.client) adhanDevice.client.close();
                        adhanDevice.close();
                    }
                    if (scanner) scanner.destroy();
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
            } else { finalize(); }
        };

        const castDuaImage = () => {
            const VisualGenerator = require('../visual_generator.js');
            const vg = new VisualGenerator(CONFIG);
            const staticDuaPath = path.join(__dirname, '..', '..', 'images', 'dua_after_adhan.png');
            const generatedDuaPath = path.join(__dirname, '..', '..', 'images', 'generated', 'dua.jpg');
            
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
        };

        scanner.on('device', (device) => {
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
                                    if (s && s.playerState !== lastState) { log(`📊 Device Status: ${s.playerState}`); lastState = s.playerState; }
                                    if (!s || s.playerState === 'IDLE') { log(`⏹️ Adhan Finished.`); cleanup(); }
                                });
                                device.on('finished', () => { log(`⏹️ Adhan Finished.`); cleanup(); });
                            }
                        });
                    });
                });
            }
        });
    }
}

module.exports = CoreScheduler;
