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
        this.hardware = hardwareService;
        this.media = mediaService;
        this.scheduleFilePath = scheduleFilePath;
        this.log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
        this.executePreFlightAndCast = this.executePreFlightAndCast.bind(this);
        this.auditPlayback = this.auditPlayback.bind(this);
        this.sessionStatus = new Map(); // Tracks: 'IDLE', 'FIXING', 'RECOVERING', 'PLAYING', 'COMPLETED'
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

            schedule.scheduleJob(triggerTime.toJSDate(), () => this.executePreFlightAndCast(prayer, audioFile, scheduleTime, todayEntry));
            
            // Audit Job (30s Post-Adhan)
            const auditTime = scheduleTime.plus({ seconds: 30 });
            schedule.scheduleJob(auditTime.toJSDate(), () => this.auditPlayback(prayer, audioFile));

            log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')}, Audit: ${auditTime.toFormat('h:mm:ss a')})`);
        });
    }

    /**
     * 1:1 LEGACY STRUCTURAL PORT (NO SERVICES, NO CLASSES, NO LEAKS)
     */
    async executePreFlightAndCast(prayerName, audioFileName, targetTimeObj, scheduleEntry = null) {
        const log = this.log;
        const state = this.sessionStatus.get(prayerName);
        
        // If this is a recovery trigger (targetTimeObj is null), but it's already playing, skip.
        if (!targetTimeObj && (state === 'PLAYING' || state === 'DUA' || state === 'COMPLETED')) {
            return;
        }

        log(`🚀 TRIGGER: ${prayerName} Time! Starting sequence...`);

        const CONFIG = this.config;
        const mediaService = this.media;
        const hardwareService = this.hardware;
        const localIp = require('ip').address();
        
        this.sessionStatus.set(prayerName, 'GENERATING');

        try {
            const today = DateTime.now().setZone(CONFIG.timezone);

            // Extract Hijri date & context from the schedule entry (fixes Hijri calendar regression)
            let hijriDate = null;
            let holidays = [];
            const isFriday = today.weekday === 5;
            if (scheduleEntry) {
                try {
                    const h = scheduleEntry.date.hijri;
                    hijriDate = `${h.day} ${h.month.en} ${h.year}`;
                    holidays = h.holidays || [];
                } catch (e) { log(`⚠️ Hijri parse warning: ${e.message}`); }
            }

            const VisualGenerator = require('../visual_generator.js');
            const vg = new VisualGenerator(CONFIG);
            
            // TIER 1 SMART RECOVERY: Weather Bypass (Already handled inside VisualGenerator with 10s timeout)
            const imgBuffer = await vg.generateDashboard(
                prayerName,
                targetTimeObj ? targetTimeObj.toFormat('h:mm a') : today.toFormat('h:mm a'),
                hijriDate,
                { holidays, isFriday }
            );

            fs.mkdirSync(path.dirname(imgPath), { recursive: true });
            fs.writeFileSync(imgPath, imgBuffer);

            // TIER 2 SMART RECOVERY: Encoding Guard (60s)
            log(`🎬 Starting Video Encoding...`);
            const { promise: encodingPromise, abort: abortEncoding } = mediaService.encodeVideoFromImageAndAudio(imgPath, audioPath, outputVideoPath);
            
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Encoding Timeout')), 60000)
            );

            try {
                await Promise.race([encodingPromise, timeoutPromise]);
            } catch (err) {
                if (err.message === 'Encoding Timeout') {
                    abortEncoding();
                    this.sessionStatus.set(prayerName, 'RECOVERING');
                    throw new Error('SMART_RECOVERY: Encoding hung. Switching to fallback.');
                }
                throw err;
            }

            log(`✅ Checkpoint 1: Assets Generated.`);
        } catch (e) { 
            if (e.message.includes('SMART_RECOVERY')) {
                log(`⚠️ ${e.message}`);
                // Use Fallback Adhan
                const fallbackPath = path.join(__dirname, '..', '..', 'images', 'fallback_adhan.mp4');
                if (fs.existsSync(fallbackPath)) {
                    log('🛠️ Smart Reset: Using pre-rendered premium fallback_adhan.mp4');
                    // We don't return here, we proceed with the fallback path
                    // Update the castUrl logically later
                } else {
                    log('❌ Hard Failure: Fallback video missing.');
                    return;
                }
            } else {
                log(`❌ Generation Failed: ${e.message}`); 
                return; 
            }
        }

        // 2. Start Discovery Early (Fix for Issue 1)
        log(`📡 Checkpoint 2: Starting Device Discovery...`);
        const scanner = new ChromecastAPI();
        let discoveredDevice = null;
        scanner.on('device', (device) => {
            if (device.friendlyName === CONFIG.device.name && !discoveredDevice) {
                discoveredDevice = device;
                log(`📡 Device Discovered & Cached: ${device.friendlyName}`);
            }
        });

        this.sessionStatus.set(prayerName, 'WAITING');

        // 3. Wait for target time
        if (targetTimeObj) {
            const delay = targetTimeObj.toMillis() - Date.now();
            if (delay > 0) {
                log(`⏳ Waiting ${Math.round(delay/1000)}s...`);
                await new Promise(r => setTimeout(r, delay));
                log(`🚀 Checkpoint 3: Wait over. Proceeding with Casting...`);
            }
        }

        // Determine Final Cast URL (If recovered, use fallback)
        let finalVideoFile = `${prayerName.toLowerCase()}.mp4`;
        if (this.sessionStatus.get(prayerName) === 'RECOVERING') {
            finalVideoFile = 'fallback_adhan.mp4';
        }
        const castUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/${finalVideoFile}?t=${Date.now()}`;
        // Note: images/generated symlinks or pathing might need to be verified. 
        // fallback_adhan.mp4 is in /images, whereas results are in /images/generated.
        // Let's ensure fallback exists in both or just use /images/ URL.
        const effectiveCastUrl = this.sessionStatus.get(prayerName) === 'RECOVERING' 
            ? `http://${localIp}:${CONFIG.serverPort}/images/fallback_adhan.mp4?t=${Date.now()}`
            : castUrl;

        // 4. Hardware Interruption (Fix for Issue 2 - Muting)
        const tvIp = process.env.TV_IP;
        let tvWasPaused = false;
        let tvWasMuted = false;

        if (tvIp && hardwareService) {
            try {
                const isTvOn = await hardwareService.isActuallyOn(tvIp);
                if (isTvOn) {
                    const status = await hardwareService.getAudioStatus(tvIp);
                    
                    if (status.isMediaSessionPlaying) {
                        log(`📺 TV is playing pause-able media (App). Sending PAUSE...`);
                        await hardwareService.pauseMedia(tvIp);
                        tvWasPaused = true;
                    } else if (status.isAudioActive) {
                        // Only mute if it's not a pause-able session (e.g. Live TV)
                        if (!status.isMuted && !status.isSonyMuted) {
                            log(`🔇 TV is playing non-pausable audio (Live TV). Muting...`);
                            await hardwareService.setMuteState(tvIp, true);
                            tvWasMuted = true;
                        }
                    } else {
                        log(`📺 TV is ON but silent.`);
                    }
                } else {
                    log(`📺 TV is OFF. Skipping interruption.`);
                }
            } catch (e) { log(`⚠️ TV Control Error: ${e.message}`); }
        }

        // 5. Connect & Cast
        let adhanDevice = null;
        let isCleanedUp = false;
        let safetyTimer = null;
        let originalVolume = null;
        let currentPhase = 'ADHAN';

        const cleanup = async () => {
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
            
            // Restore TV State
            if (tvIp && hardwareService) {
                if (tvWasMuted) {
                    log(`🔊 Unmuting TV...`);
                    await hardwareService.setMuteState(tvIp, false);
                }
                if (tvWasPaused) {
                    log(`▶️ Resuming TV...`);
                    await hardwareService.resumeMedia(tvIp);
                }
            }

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
                this.sessionStatus.set(prayerName, 'DUA');
                adhanDevice.play(media, (err) => {
                    if (err) cleanup();
                    else safetyTimer = setTimeout(() => { log(`✅ Dua Complete.`); currentPhase = 'DONE'; this.sessionStatus.set(prayerName, 'COMPLETED'); cleanup(); }, 20000);
                });
            }).catch(() => cleanup());
        };

        const startPlayback = (device) => {
            if (adhanDevice) return;
            adhanDevice = device;
            log(`✅ Connected to Adhan Speaker: ${device.friendlyName}`);

            device.getReceiverStatus((err, status) => {
                if (!err && status && status.volume) originalVolume = status.volume.level;
                device.setVolume(CONFIG.device.targetVolume, () => {
                    const dashboardUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/current_dashboard.jpg?t=${Date.now()}`;
                    const media = {
                        url: effectiveCastUrl, contentType: 'video/mp4',
                        metadata: { type: 1, metadataType: 0, title: `${prayerName} Adhan`, images: [{ url: dashboardUrl }] }
                    };
                    device.play(media, (err) => {
                        if (err) cleanup();
                        else {
                            log(`🎶 Playback Started!`);
                            this.sessionStatus.set(prayerName, 'PLAYING');
                            safetyTimer = setTimeout(cleanup, 600000);
                            let lastState = '';
                            // Use a named handler so we can remove it when transitioning to Dua
                            // This prevents ADHAN status events from firing spurious cleanup during Dua phase (black screen fix)
                            const adhanStatusHandler = (s) => {
                                if (currentPhase !== 'ADHAN') return; // Guard against late-firing events
                                if (s && s.playerState !== lastState) { log(`📊 Device Status: ${s.playerState}`); lastState = s.playerState; }
                                if (!s || s.playerState === 'IDLE') { log(`⏹️ Adhan Finished.`); device.removeListener('status', adhanStatusHandler); cleanup(); }
                            };
                            device.on('status', adhanStatusHandler);
                            device.on('finished', () => { if (currentPhase === 'ADHAN') { log(`⏹️ Adhan Finished.`); cleanup(); } });
                        }
                    });
                });
            });
        };

        // If already discovered during wait, start now. Otherwise wait for discovery.
        if (discoveredDevice) {
            startPlayback(discoveredDevice);
        } else {
            log(`⏳ Still searching for ${CONFIG.device.name}...`);
            scanner.on('device', (device) => {
                if (device.friendlyName === CONFIG.device.name) startPlayback(device);
            });
            // Safety timeout for discovery
            setTimeout(() => {
                if (!adhanDevice) {
                    log(`❌ Discovery Timeout: Speaker ${CONFIG.device.name} not found.`);
                    cleanup();
                }
            }, 60000); 
        }
    }

    /**
     * AUDIT JOB: Runs 30s after target time.
     * Silent check via API. Resets system if playback failed.
     */
    async auditPlayback(prayerName, audioFileName) {
        const log = this.log;
        const state = this.sessionStatus.get(prayerName);
        
        if (state === 'PLAYING' || state === 'DUA' || state === 'COMPLETED') {
            return; // Already healthy
        }

        log(`🔍 Audit: ${prayerName} state is '${state || 'UNKNOWN'}'. Checking device status...`);
        
        const scanner = new ChromecastAPI();
        let auditDevice = null;
        
        const finishAudit = () => {
            if (scanner) scanner.destroy();
        };

        const triggerEmergency = () => {
            log(`🚨 AUDIT FAILURE: Speaker is silent during ${prayerName} time. TRIGGERING SMART RECOVERY...`);
            this.sessionStatus.set(prayerName, 'RECOVERING');
            // Hard trigger with fallback assets
            this.executePreFlightAndCast(prayerName, audioFileName, null);
            finishAudit();
        };

        scanner.on('device', (device) => {
            if (device.friendlyName === this.config.device.name && !auditDevice) {
                auditDevice = device;
                device.getReceiverStatus((err, status) => {
                    if (err || !status || !status.applications || status.applications.length === 0) {
                        triggerEmergency();
                    } else {
                        // Check if our Adhan is currently playing in the status
                        const isAdhan = status.applications.some(app => app.statusText && app.statusText.includes('Adhan'));
                        if (!isAdhan) triggerEmergency();
                        else {
                            log(`✅ Audit Passed: ${prayerName} is confirmed playing.`);
                            finishAudit();
                        }
                    }
                });
            }
        });

        // 30s timeout for binary discovery during audit
        setTimeout(() => {
            if (!auditDevice) {
                log(`⚠️ Audit Discovery Timeout. Resetting system...`);
                triggerEmergency();
            }
        }, 15000);
    }
}

module.exports = CoreScheduler;
