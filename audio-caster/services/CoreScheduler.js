const schedule = require('node-schedule');
const { DateTime } = require('luxon');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { exec } = require('child_process');
const ChromecastAPI = require('chromecast-api');

/**
 * CoreScheduler V8: ABSOLUTE LEGACY RESTORATION
 * This class now acts as a shell for the PROVEN structural logic of commit 603858cf.
 * All modular service layers (CastService, HardwareService) are bypassed in the execution flow
 * to ensure 1:1 hardware behavioral parity.
 */
class CoreScheduler {
    constructor(config, hardwareService, mediaService, castService, scheduleFilePath) {
        this.config = config;
        this.hardware = hardwareService;
        this.media = mediaService;
        this.cast = castService;
        this.scheduleFilePath = scheduleFilePath;
        this.log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
    }

    async scheduleToday() {
        const SCHEDULE_FILE = this.scheduleFilePath;
        const log = this.log;
        const config = this.config;

        log("📅 Loading Schedule...");

        let annualData;
        if (fs.existsSync(SCHEDULE_FILE)) {
            try {
                annualData = JSON.parse(fs.readFileSync(SCHEDULE_FILE));
            } catch (e) { log("⚠️ Local schedule corrupt."); }
        }

        const currentYear = DateTime.now().setZone(config.timezone).toFormat('yyyy');

        if (!annualData || annualData.year !== currentYear) {
            log(`🔄 Initialzing Annual Data for ${currentYear}...`);
            try {
                const url = `http://api.aladhan.com/v1/calendarByCity/${currentYear}?city=${config.location.city}&country=${config.location.country}&method=${config.location.method}&annual=true`;
                const response = await axios.get(url);
                annualData = { year: currentYear, data: response.data.data };
                fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(annualData, null, 2));
                log("💾 Annual Data Downloaded & Saved.");
            } catch (error) {
                log("❌ Fetch Error. Cannot Schedule.");
                return;
            }
        }

        // Cache Sync
        const audioDirPath = path.join(__dirname, '..', 'audio');
        await this.media.cacheAudioSources(config, audioDirPath);

        const today = DateTime.now().setZone(config.timezone);
        const month = today.month.toString();
        const monthData = annualData.data[month];
        if (!monthData) return log("❌ Calendar Error: Month missing.");
        const todayEntry = monthData.find(d => parseInt(d.date.gregorian.day) === today.day);
        if (!todayEntry) return log("❌ Calendar Error: Day missing.");

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

            schedule.scheduleJob(triggerTime.toJSDate(), () => {
                this.executePreFlightAndCast(prayer, audioFile, scheduleTime);
            });

            log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')})`);
        });
    }

    /**
     * EXACT PORT OF 603858cf EXECUTION ENGINE
     */
    async executePreFlightAndCast(prayerName, audioFileName, targetTimeObj) {
        const log = this.log;
        const CONFIG = this.config;
        const localIp = require('ip').address();

        log(`🚀 TRIGGER: ${prayerName} Time! Starting sequence...`);

        // 1. Image & Video Gen (Legacy Style)
        const outputVideoPath = path.join(__dirname, '..', '..', 'images', 'generated', `${prayerName.toLowerCase()}.mp4`);
        const audioPath = path.join(__dirname, '..', 'audio', audioFileName);
        const imgPath = path.join(__dirname, '..', '..', 'images', 'generated', 'current_dashboard.jpg');

        try {
            const today = DateTime.now().setZone(CONFIG.timezone);
            const displayTime = targetTimeObj ? targetTimeObj.toFormat('h:mm a') : today.toFormat('h:mm a');
            
            const VisualGenerator = require('../visual_generator.js');
            const vg = new VisualGenerator(CONFIG);
            const imgBuffer = await vg.generateDashboard(prayerName, displayTime, null, {});
            fs.mkdirSync(path.dirname(imgPath), { recursive: true });
            fs.writeFileSync(imgPath, imgBuffer);
            await this.media.encodeVideoFromImageAndAudio(imgPath, audioPath, outputVideoPath);
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

        const castUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/${prayerName.toLowerCase()}.mp4?t=${Date.now()}`;

        // 2. Sony TV ADB (Legacy Block)
        const tvIp = process.env.TV_IP;
        let tvWasInterrupted = false;
        let tvWasMuted = false;

        const adbCommand = (cmd) => {
            return new Promise((resolve, reject) => {
                exec(`adb -s ${tvIp}:5555 ${cmd}`, (error, stdout) => {
                    if (error) reject(error);
                    else resolve(stdout);
                });
            });
        };

        if (tvIp) {
            try {
                const sessionOutput = await adbCommand('shell dumpsys media_session');
                if (sessionOutput && (sessionOutput.includes('state=3') || sessionOutput.includes('state=Playing'))) {
                    log(`📺 TV is PLAYING. Sending PAUSE...`);
                    await adbCommand('shell input keyevent 127');
                    await new Promise(r => setTimeout(r, 1000));
                    tvWasInterrupted = true;
                }
            } catch (e) { log(`⚠️ TV ADB Error: ${e.message}`); }
        }

        // 3. Connect & Cast (LEGACY CLOSURE)
        const Client = new ChromecastAPI();
        let adhanDevice = null;
        let isCleanedUp = false;
        let safetyTimer = null;
        let originalVolume = null;
        let currentPhase = 'ADHAN';

        const resumeTvSafely = async () => {
            if (!tvIp) return;
            try {
                if (tvWasMuted) await adbCommand('shell input keyevent 164');
                else if (tvWasInterrupted) await adbCommand('shell input keyevent 126');
            } catch (e) { }
        };

        const cleanup = () => {
            if (isCleanedUp) return;

            if (currentPhase === 'ADHAN') {
                log(`✨ Adhan Video Finished. Switching to Dua Image...`);
                if (safetyTimer) clearTimeout(safetyTimer);
                currentPhase = 'DUA';
                castDuaImage();
                return;
            }

            if (currentPhase === 'DUA') return;

            isCleanedUp = true;
            currentPhase = 'DONE';
            log(`🔄 Playback Ended. Starting cleanup...`);
            resumeTvSafely();

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
                log(`🔊 Restoring Original Volume to ${(originalVolume * 100).toFixed(0)}%...`);
                adhanDevice.setVolume(originalVolume, (err) => {
                    setTimeout(finalize, 500);
                });
            } else {
                finalize();
            }
        };

        function castDuaImage() {
            // Restore Stretched Dua generator from turn V5
            const VisualGenerator = require('../visual_generator.js');
            const vg = new VisualGenerator(CONFIG);
            const staticDuaPath = path.join(__dirname, '..', '..', 'images', 'dua_after_adhan.png');
            const generatedDuaPath = path.join(__dirname, '..', '..', 'images', 'generated', 'dua.jpg');
            
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
            }).catch(() => {
                const fallbackUrl = `http://${localIp}:${CONFIG.serverPort}/images/dua_after_adhan.png`;
                adhanDevice.play({ url: fallbackUrl, contentType: 'image/png' }, () => {
                   safetyTimer = setTimeout(cleanup, 20000);
                });
            });
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
}

module.exports = CoreScheduler;
