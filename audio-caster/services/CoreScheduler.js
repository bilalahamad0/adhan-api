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
    constructor(config, hardwareService, mediaService, castService, scheduleFilePath, playbackLogger) {
        this.config = config;
        this.hardware = hardwareService;
        this.media = mediaService;
        this.scheduleFilePath = scheduleFilePath;
        this.playbackLogger = playbackLogger || null;
        this.log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
        this.executePreFlightAndCast = this.executePreFlightAndCast.bind(this);
        this.auditPlayback = this.auditPlayback.bind(this);
        this.sessionStatus = new Map();
        this.activeRuns = new Set();
        this._scheduledJobs = [];
        this._castCachePath = path.join(__dirname, '..', '.cast-cache.json');
    }

    _readCastCache() {
        try {
            if (!fs.existsSync(this._castCachePath)) return null;
            const data = JSON.parse(fs.readFileSync(this._castCachePath, 'utf8'));
            if (!data || !data.host || !data.friendlyName) return null;
            return data;
        } catch (_) {
            return null;
        }
    }

    _writeCastCache(device) {
        try {
            const payload = {
                friendlyName: device.friendlyName,
                host: device.host,
                port: device.port || 8009,
                lastSuccessIso: new Date().toISOString(),
            };
            fs.writeFileSync(this._castCachePath, JSON.stringify(payload, null, 2));
        } catch (_) { /* cache write failure is non-fatal */ }
    }

    /**
     * Try to construct a chromecast-api Device directly from cached host/port,
     * skipping the 120s mDNS scanner. Falls back to null if anything goes wrong;
     * caller treats null as "go run the full scanner".
     * Verified live by a short getReceiverStatus probe so a stale cache
     * (device IP changed) returns null instead of a hung handle.
     */
    async _connectToCachedDevice(cache, log) {
        let DeviceCls;
        try {
            DeviceCls = require('chromecast-api/lib/Device');
        } catch (_) {
            return null;
        }
        if (!DeviceCls) return null;

        let device;
        try {
            device = new DeviceCls({
                friendlyName: cache.friendlyName,
                host: cache.host,
                port: cache.port || 8009,
            });
        } catch (e) {
            log(`⚠️ Cast cache: Device ctor failed (${e.message}); falling back to mDNS.`);
            return null;
        }

        const probeMs = 3000;
        const ok = await new Promise((resolve) => {
            let done = false;
            const finish = (success) => {
                if (done) return;
                done = true;
                resolve(success);
            };
            const t = setTimeout(() => finish(false), probeMs);
            try {
                device.getReceiverStatus((err) => {
                    clearTimeout(t);
                    finish(!err);
                });
            } catch (_) {
                clearTimeout(t);
                finish(false);
            }
        });

        if (!ok) {
            try { if (typeof device.close === 'function') device.close(() => {}); } catch (_) { /* ignore */ }
            return null;
        }
        return device;
    }

    async discoverDeviceByName(deviceName, log, prayerName) {
        // Warm path: prior successful cast persisted host:port. Skip mDNS entirely
        // when the cache is fresh + reachable — sidesteps Wi-Fi↔LAN multicast bridges
        // (Xfinity gateways often drop UDP 5353 across the wired/wireless boundary).
        const cache = this._readCastCache();
        if (cache && cache.friendlyName === deviceName) {
            log(`📡 Cast cache hit: ${deviceName} @ ${cache.host}:${cache.port || 8009}; probing…`);
            const cached = await this._connectToCachedDevice(cache, log);
            if (cached) {
                log(`✅ Cast cache validated; skipping mDNS discovery.`);
                if (this.playbackLogger) {
                    this.playbackLogger.recordDeviceDiscovered(prayerName, deviceName, { cacheHit: true });
                }
                return cached;
            }
            log(`⚠️ Cast cache stale (no receiver response); falling back to mDNS.`);
        }

        return new Promise((resolve) => {
            const totalTimeoutMs = 120000;
            const scannerCycleMs = 25000;
            const startMs = Date.now();
            let resolved = false;
            let scanner = null;
            let cycleTimer = null;
            let hardTimeout = null;

            const finish = (device) => {
                if (resolved) return;
                resolved = true;
                if (cycleTimer) clearInterval(cycleTimer);
                if (hardTimeout) clearTimeout(hardTimeout);
                try {
                    if (scanner && typeof scanner.destroy === 'function') scanner.destroy();
                } catch (_) { /* ignore */ }
                resolve(device || null);
            };

            const startScanner = () => {
                try {
                    if (scanner && typeof scanner.destroy === 'function') scanner.destroy();
                } catch (_) { /* ignore */ }

                scanner = new ChromecastAPI();
                scanner.on('device', (device) => {
                    if (device && device.friendlyName === deviceName) {
                        log(`📡 Device Discovered & Cached: ${device.friendlyName}`);
                        this._writeCastCache(device);
                        if (this.playbackLogger) this.playbackLogger.recordDeviceDiscovered(prayerName, device.friendlyName, { cacheHit: false });
                        finish(device);
                    }
                });
            };

            startScanner();
            cycleTimer = setInterval(() => {
                if (resolved) return;
                const elapsedSec = Math.floor((Date.now() - startMs) / 1000);
                log(`⏳ Still searching for ${deviceName}... (${elapsedSec}s elapsed)`);
                startScanner();
            }, scannerCycleMs);

            hardTimeout = setTimeout(() => finish(null), totalTimeoutMs);
        });
    }

    resolveTodayScheduleEntry() {
        try {
            if (!fs.existsSync(this.scheduleFilePath)) return null;
            const annualData = JSON.parse(fs.readFileSync(this.scheduleFilePath));
            const today = DateTime.now().setZone(this.config.timezone);
            const monthData = annualData?.data?.[today.month.toString()];
            if (!Array.isArray(monthData)) return null;
            return monthData.find(d => parseInt(d?.date?.gregorian?.day) === today.day) || null;
        } catch {
            return null;
        }
    }

    async scheduleToday() {
        const config = this.config;
        const log = this.log;
        log("📅 Loading Schedule...");

        // Cancel prior day's jobs so restarts / re-schedules never double-fire triggers.
        this._scheduledJobs.forEach((job) => {
            try {
                job.cancel();
            } catch (_) { /* ignore */ }
        });
        this._scheduledJobs = [];

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

            this._scheduledJobs.push(
                schedule.scheduleJob(triggerTime.toJSDate(), () => this.executePreFlightAndCast(prayer, audioFile, scheduleTime, todayEntry)),
            );

            const auditTime = scheduleTime.plus({ seconds: 30 });
            this._scheduledJobs.push(
                schedule.scheduleJob(auditTime.toJSDate(), () => this.auditPlayback(prayer, audioFile)),
            );

            log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')}, Audit: ${auditTime.toFormat('h:mm:ss a')})`);
        });
    }

    /**
     * 1:1 LEGACY STRUCTURAL PORT (NO SERVICES, NO CLASSES, NO LEAKS)
     */
    async executePreFlightAndCast(prayerName, audioFileName, targetTimeObj, scheduleEntry = null) {
        const log = this.log;
        if (process.env.SMOKE_DRY_RUN === '1') {
            log(`🛑 SMOKE_DRY_RUN active: refusing to cast ${prayerName}`);
            return;
        }
        const state = this.sessionStatus.get(prayerName);

        // Block if ANY active session exists for this prayer (prevents audit race condition).
        if (this.activeRuns.has(prayerName)) {
            log(`⏭️ Skipping ${prayerName}: session already active (state: ${state}).`);
            return;
        }

        if (!targetTimeObj && (state === 'PLAYING' || state === 'DUA' || state === 'COMPLETED')) {
            return;
        }

        this.activeRuns.add(prayerName);

        log(`🚀 TRIGGER: ${prayerName} Time! Starting sequence...`);

        const scheduledTimeStr = targetTimeObj ? targetTimeObj.toFormat('HH:mm') : null;
        if (this.playbackLogger) {
            this.playbackLogger.startEvent(prayerName, scheduledTimeStr);
        }

        const CONFIG = this.config;
        const mediaService = this.media;
        const hardwareService = this.hardware;
        const localIp = require('ip').address();
        
        const outputVideoPath = path.join(__dirname, '..', '..', 'images', 'generated', `${prayerName.toLowerCase()}.mp4`);
        const audioPath = path.join(__dirname, '..', 'audio', audioFileName);
        const imgPath = path.join(__dirname, '..', '..', 'images', 'generated', 'current_dashboard.jpg');

        this.sessionStatus.set(prayerName, 'GENERATING');

        try {
            const today = DateTime.now().setZone(CONFIG.timezone);

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

            if (!hijriDate) {
                const recoveredEntry = this.resolveTodayScheduleEntry();
                if (recoveredEntry) {
                    scheduleEntry = recoveredEntry;
                    try {
                        const h = recoveredEntry.date.hijri;
                        hijriDate = `${h.day} ${h.month.en} ${h.year}`;
                        holidays = h.holidays || [];
                    } catch (e) { log(`⚠️ Hijri recovery parse warning: ${e.message}`); }
                }
            }

            const VisualGenerator = require('../visual_generator.js');
            const vg = new VisualGenerator(CONFIG);
            
            const weather = await vg.getWeather();
            const weatherCode = weather ? weather.code : 0;

            const imgBuffer = await vg.generateDashboard(
                prayerName,
                targetTimeObj ? targetTimeObj.toFormat('h:mm a') : today.toFormat('h:mm a'),
                hijriDate,
                { holidays, isFriday }
            );

            fs.mkdirSync(path.dirname(imgPath), { recursive: true });
            fs.writeFileSync(imgPath, imgBuffer);

            const staticDuaPath = path.join(__dirname, '..', '..', 'images', 'dua_after_adhan.png');
            const generatedDuaPath = path.join(__dirname, '..', '..', 'images', 'generated', 'dua.jpg');
            vg.generateDua(staticDuaPath).then(buffer => {
                fs.writeFileSync(generatedDuaPath, buffer);
                log(`✅ Checkpoint 1.5: Dua Image Pre-generated.`);
            }).catch(e => log(`⚠️ Dua generation warning: ${e.message}`));

            const audioDuration = await mediaService.getMediaDuration(audioPath);
            const MediaServiceCls = require('./MediaService');
            const nominalSec = MediaServiceCls.getNominalAdhanSeconds(prayerName);
            const minAudioExpected = MediaServiceCls.getMinExpectedDuration(prayerName);
            if (audioDuration === null) {
                log(`⚠️ Could not read audio duration for ${audioFileName}. Proceeding with encoding anyway.`);
            } else if (audioDuration < minAudioExpected) {
                throw new Error(
                    `SMART_RECOVERY: Audio ${audioFileName} is only ${audioDuration.toFixed(1)}s (nominal ${nominalSec}s, pre-encode floor ${minAudioExpected}s). File may be corrupt.`
                );
            } else {
                log(`🎵 Audio verified: ${audioFileName} (${audioDuration.toFixed(1)}s, nominal ${nominalSec}s)`);
            }

            log(`🎬 Starting Video Encoding...`);
            const { promise: encodingPromise, abort: abortEncoding } = mediaService.encodeVideoFromImageAndAudio(imgPath, audioPath, outputVideoPath, weatherCode);

            const encodeTimeoutMs = MediaServiceCls.getEncodingTimeoutMs(prayerName, audioDuration);
            log(`⏱️ Encode timeout: ${Math.round(encodeTimeoutMs / 1000)}s (audio ${audioDuration != null ? `${audioDuration.toFixed(1)}s` : 'unknown'})`);

            let encodeTimeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                encodeTimeoutId = setTimeout(() => reject(new Error('Encoding Timeout')), encodeTimeoutMs);
            });

            try {
                await Promise.race([encodingPromise, timeoutPromise]);
            } catch (err) {
                if (err.message === 'Encoding Timeout') {
                    abortEncoding();
                    this.sessionStatus.set(prayerName, 'RECOVERING');
                    throw new Error(
                        `SMART_RECOVERY: Encoding exceeded ${Math.round(encodeTimeoutMs / 1000)}s (not necessarily hung — host may be CPU-bound). Switching to fallback.`
                    );
                }
                throw err;
            } finally {
                clearTimeout(encodeTimeoutId);
            }

            const videoDuration = await mediaService.getMediaDuration(outputVideoPath);
            const minVideoExpected = MediaServiceCls.getMinExpectedDuration(prayerName);
            if (videoDuration !== null && videoDuration < minVideoExpected) {
                log(
                    `⚠️ Video duration ${videoDuration.toFixed(1)}s is below pre-encode floor ${minVideoExpected}s (nominal ${nominalSec}s) for ${prayerName}. Switching to fallback.`
                );
                this.sessionStatus.set(prayerName, 'RECOVERING');
                if (this.playbackLogger) {
                    this.playbackLogger.recordEncodingFailed(prayerName, 'SHORT_VIDEO');
                    this.playbackLogger.recordUsedFallback(prayerName);
                }
                const fallbackPath = path.join(__dirname, '..', '..', 'images', 'fallback_adhan.mp4');
                if (!fs.existsSync(fallbackPath)) {
                    log('❌ Hard Failure: Fallback video missing.');
                    if (this.playbackLogger) this.playbackLogger.recordFailed(prayerName, 'SHORT_VIDEO');
                    this.activeRuns.delete(prayerName);
                    return;
                }
                log('🛠️ Smart Reset: Using pre-rendered premium fallback_adhan.mp4');
            } else {
                log(`✅ Checkpoint 1: Assets Generated (video ${videoDuration ? videoDuration.toFixed(1) + 's' : 'unknown duration'}).`);
            }
            if (this.playbackLogger) this.playbackLogger.recordEncodingComplete(prayerName);
        } catch (e) { 
            if (e.message.includes('SMART_RECOVERY')) {
                log(`⚠️ ${e.message}`);
                if (this.playbackLogger) {
                    this.playbackLogger.recordEncodingFailed(prayerName, 'ENCODING_TIMEOUT');
                    this.playbackLogger.recordUsedFallback(prayerName);
                }
                const fallbackPath = path.join(__dirname, '..', '..', 'images', 'fallback_adhan.mp4');
                if (fs.existsSync(fallbackPath)) {
                    log('🛠️ Smart Reset: Using pre-rendered premium fallback_adhan.mp4');
                } else {
                    log('❌ Hard Failure: Fallback video missing.');
                    if (this.playbackLogger) this.playbackLogger.recordFailed(prayerName, 'ENCODING_TIMEOUT');
                    this.activeRuns.delete(prayerName);
                    return;
                }
            } else {
                log(`❌ Generation Failed: ${e.message}`);
                if (this.playbackLogger) this.playbackLogger.recordFailed(prayerName, 'GENERATION_FAILED');
                this.activeRuns.delete(prayerName);
                return; 
            }
        }

        log(`📡 Checkpoint 2: Pre-cast wait (discovery starts after wait to avoid stale mDNS browse)...`);
        this.sessionStatus.set(prayerName, 'WAITING');

        if (targetTimeObj) {
            const delay = targetTimeObj.toMillis() - Date.now();
            if (delay > 0) {
                log(`⏳ Waiting ${Math.round(delay/1000)}s...`);
                await new Promise(r => setTimeout(r, delay));
                log(`🚀 Checkpoint 3: Wait over. Proceeding with Casting...`);
            }
        }

        log(`📡 Starting Device Discovery (post-wait)...`);
        if (this.playbackLogger) this.playbackLogger.recordDiscoveryStart(prayerName);
        const discoveredDevice = await this.discoverDeviceByName(CONFIG.device.name, log, prayerName);

        let finalVideoFile = `${prayerName.toLowerCase()}.mp4`;
        const castUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/${finalVideoFile}?t=${Date.now()}`;
        const effectiveCastUrl = this.sessionStatus.get(prayerName) === 'RECOVERING' 
            ? `http://${localIp}:${CONFIG.serverPort}/images/fallback_adhan.mp4?t=${Date.now()}`
            : castUrl;

        const tvIp = process.env.TV_IP;
        let tvWasPaused = false;
        let tvWasMuted = false;

        if (tvIp && hardwareService) {
            if (this.playbackLogger) this.playbackLogger.recordPrePlayStart(prayerName);
            try {
                const isTvOn = await hardwareService.isActuallyOn(tvIp);
                if (isTvOn) {
                    const status = await hardwareService.getAudioStatus(tvIp);
                    if (status.isMediaSessionPlaying) {
                        log(`📺 TV is playing pause-able media. Sending PAUSE...`);
                        await hardwareService.pauseMedia(tvIp);
                        tvWasPaused = true;
                    } else if (status.isAudioActive) {
                        if (!status.isMuted && !status.isSonyMuted) {
                            log(`🔇 TV is playing non-pausable audio. Muting...`);
                            await hardwareService.setMuteState(tvIp, true);
                            tvWasMuted = true;
                        }
                    }
                }
            } catch (e) { log(`⚠️ TV Control Error: ${e.message}`); }
            if (this.playbackLogger) this.playbackLogger.recordPrePlayComplete(prayerName);
        }

        let adhanDevice = null;
        let isCleanedUp = false;
        let isFinalizing = false;
        let safetyTimer = null;
        let originalVolume = null;
        let currentPhase = 'ADHAN';
        let skipDua = false;

        const cleanup = async () => {
            if (isCleanedUp) return;
            
            if (currentPhase === 'ADHAN') {
                if (safetyTimer) clearTimeout(safetyTimer);

                if (skipDua) {
                    log(`⏭️ Skipping Dua due to failed/aborted Adhan playback.`);
                    currentPhase = 'DONE';
                    cleanup();
                    return;
                }

                const playFn = adhanDevice && typeof adhanDevice.play === 'function'
                    ? adhanDevice.play.bind(adhanDevice)
                    : null;
                if (!playFn) {
                    log(`⚠️ No device connected -- skipping Dua, proceeding to cleanup.`);
                    currentPhase = 'DONE';
                    cleanup();
                    return;
                }

                log(`✨ Adhan Video Finished. Switching to Dua...`);
                currentPhase = 'DUA';

                const duaUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/dua.jpg?t=${Date.now()}`;
                const media = {
                    url: duaUrl, contentType: 'image/jpeg',
                    metadata: { type: 0, metadataType: 0, title: `Dua After Adhan`, images: [{ url: duaUrl }] }
                };
                log(`🤲 Casting Pre-generated Dua: ${duaUrl}`);
                this.sessionStatus.set(prayerName, 'DUA');
                playFn(media, (err) => {
                    if (err) {
                        log(`⚠️ Dua Play Error: ${err.message}`);
                        currentPhase = 'DONE';
                        cleanup();
                    } else {
                        safetyTimer = setTimeout(() => { 
                            log(`✅ Dua Complete.`); 
                            currentPhase = 'DONE'; 
                            this.sessionStatus.set(prayerName, 'COMPLETED');
                            if (this.playbackLogger) this.playbackLogger.recordCompleted(prayerName);
                            cleanup(); 
                        }, 20000);
                    }
                });
                return;
            }

            if (currentPhase === 'DONE') {
                isCleanedUp = true;
                this.activeRuns.delete(prayerName);
                log(`🔄 Playback Ended. Cleaning up...`);
                
                if (tvIp && hardwareService) {
                    try {
                        if (tvWasMuted) await hardwareService.setMuteState(tvIp, false);
                        if (tvWasPaused) await hardwareService.resumeMedia(tvIp);
                    } catch (e) { log(`⚠️ TV Restore Error: ${e.message}`); }
                }

                const finalize = () => {
                    if (isFinalizing) return;
                    isFinalizing = true;
                    log(`🔄 Finalize: Hard destroying session...`);
                    
                    if (safetyTimer) clearTimeout(safetyTimer);

                    const completeFinalize = () => {
                        if (process.argv.includes('--test')) {
                            log("🧪 Test Complete. Exiting.");
                            setTimeout(() => process.exit(0), 1000);
                        }
                    };

                    try {
                        if (adhanDevice) {
                            adhanDevice.stop(() => {
                                log(`⏹️ Receiver Stopped.`);
                                setTimeout(() => {
                                    try {
                                        if (adhanDevice && adhanDevice.close) {
                                            adhanDevice.close(() => {
                                                log(`🔌 Connection Closed.`);
                                                completeFinalize();
                                            });
                                        } else { completeFinalize(); }
                                    } catch (e) { completeFinalize(); }
                                }, 500);
                            });
                        } else {
                            completeFinalize();
                        }
                    } catch (e) { 
                        log(`⚠️ Finalize warning: ${e.message}`);
                        completeFinalize();
                    }
                };

                if (adhanDevice && originalVolume !== null) {
                    log(`🔊 Restoring Volume...`);
                    try {
                        adhanDevice.setVolume(originalVolume, () => setTimeout(finalize, 500));
                    } catch (e) { setTimeout(finalize, 500); }
                } else { finalize(); }
            }
        };

        const startPlayback = (device) => {
            if (adhanDevice) return;
            adhanDevice = device;
            log(`✅ Connected to Adhan Speaker: ${device.friendlyName}`);

            if (this.playbackLogger) this.playbackLogger.recordCastConnectStart(prayerName);
            device.getReceiverStatus((err, status) => {
                if (!err && status && status.volume) originalVolume = status.volume.level;
                device.setVolume(CONFIG.device.targetVolume, () => {
                    const dashboardUrl = `http://${localIp}:${CONFIG.serverPort}/images/generated/current_dashboard.jpg?t=${Date.now()}`;
                    const media = {
                        url: effectiveCastUrl, contentType: 'video/mp4',
                        metadata: { type: 1, metadataType: 0, title: `${prayerName} Adhan`, images: [{ url: dashboardUrl }] }
                    };
                    device.play(media, (err) => {
                        if (err) {
                            if (this.playbackLogger) {
                                this.playbackLogger.recordCastConnectComplete(prayerName);
                                this.playbackLogger.recordFailed(prayerName, 'CAST_ERROR');
                            }
                            cleanup();
                        } else {
                            log(`🎶 Playback Started!`);
                            this.sessionStatus.set(prayerName, 'PLAYING');
                            if (this.playbackLogger) {
                                this.playbackLogger.recordCastConnectComplete(prayerName);
                                this.playbackLogger.recordPlaybackStarted(prayerName, targetTimeObj);
                            }
                            safetyTimer = setTimeout(cleanup, 600000);
                            let lastState = '';
                            const adhanPlayStartMs = Date.now();
                            const adhanStatusHandler = (s) => {
                                if (currentPhase !== 'ADHAN') return;
                                // Never treat a missing status object as "finished" — chromecast-api can emit null/empty updates.
                                if (!s) return;
                                const prevState = lastState;
                                if (s.playerState !== lastState || s.idleReason) {
                                    log(`📊 Device Status: ${s.playerState}${s.idleReason ? ' (Idle Reason: ' + s.idleReason + ')' : ''}`);
                                    lastState = s.playerState;
                                }
                                if (s.playerState !== 'IDLE') return;
                                const reason = (s.idleReason || '').toString();
                                const terminalSuccess = ['FINISHED'].includes(reason);
                                const implicitEnd = !reason && prevState === 'PLAYING';
                                const terminalFailure = ['ERROR', 'INTERRUPTED', 'CANCELLED'].includes(reason);
                                if (terminalFailure) {
                                    skipDua = true;
                                    log(`❌ Adhan FAILED: Receiver ended with ${reason}.`);
                                    if (this.playbackLogger) this.playbackLogger.recordFailed(prayerName, `CAST_${reason}`);
                                    device.removeListener('status', adhanStatusHandler);
                                    currentPhase = 'DONE';
                                    cleanup();
                                    return;
                                }
                                if (!terminalSuccess && !implicitEnd) {
                                    if (reason || prevState) {
                                        log(`📊 Ignoring IDLE (idleReason="${reason || 'none'}", prevState=${prevState || 'none'})`);
                                    }
                                    return;
                                }
                                const elapsedSec = Math.round((Date.now() - adhanPlayStartMs) / 1000);
                                const MS = require('./MediaService');
                                const nominal = MS.getNominalAdhanSeconds(prayerName);
                                const playbackTooShortSec = MS.getPlaybackTooShortThresholdSeconds(prayerName);
                                const tooShort =
                                    (terminalSuccess || implicitEnd) && elapsedSec < playbackTooShortSec;
                                if (tooShort) {
                                    skipDua = true;
                                    log(
                                        `❌ Adhan FAILED: FINISHED after ~${elapsedSec}s (threshold <${playbackTooShortSec}s = half of nominal ${nominal}s for ${prayerName}).`
                                    );
                                    if (this.playbackLogger) this.playbackLogger.recordFailed(prayerName, 'SHORT_PLAYBACK');
                                    currentPhase = 'DONE';
                                } else {
                                    log(
                                        `⏹️ Adhan Finished. (Final State: ${s.playerState}, Reason: ${reason || (implicitEnd ? 'implicit-after-PLAYING' : 'N/A')}, elapsed: ${elapsedSec}s)`
                                    );
                                }
                                device.removeListener('status', adhanStatusHandler);
                                cleanup();
                            };
                            device.on('status', adhanStatusHandler);
                            device.on('finished', () => { if (currentPhase === 'ADHAN') { log(`⏹️ Adhan Finished (via Finished event).`); cleanup(); } });
                        }
                    });
                });
            });
        };

        if (discoveredDevice) {
            startPlayback(discoveredDevice);
            return;
        }

        log(`⚠️ Discovery window expired for ${CONFIG.device.name}. Retrying one final short pass...`);
        const retryDevice = await this.discoverDeviceByName(CONFIG.device.name, log, prayerName);
        if (retryDevice) {
            startPlayback(retryDevice);
            return;
        }

        log(`❌ Discovery Timeout: Speaker ${CONFIG.device.name} not found after retries.`);
        if (this.playbackLogger) this.playbackLogger.recordFailed(prayerName, 'DISCOVERY_TIMEOUT');
        this.activeRuns.delete(prayerName);
        cleanup();
    }

    /**
     * AUDIT JOB: Runs 30s after target time.
     * Silent check via API. Resets system if playback failed.
     */
    async auditPlayback(prayerName, audioFileName) {
        const log = this.log;
        const state = this.sessionStatus.get(prayerName);
        
        // If primary session is anywhere in its lifecycle, don't interfere.
        if (this.activeRuns.has(prayerName)) {
            log(`✅ Audit: ${prayerName} session is active (state: ${state}). Skipping.`);
            if (this.playbackLogger) this.playbackLogger.recordAuditResult(prayerName, true);
            return;
        }

        if (state === 'PLAYING' || state === 'DUA' || state === 'COMPLETED') {
            if (this.playbackLogger) this.playbackLogger.recordAuditResult(prayerName, true);
            return;
        }

        log(`🔍 Audit: ${prayerName} state is '${state || 'UNKNOWN'}'. Checking device status...`);
        
        const scanner = new ChromecastAPI();
        let auditDevice = null;
        
        const finishAudit = () => {
            if (scanner) scanner.destroy();
        };

        const triggerEmergency = () => {
            log(`🚨 AUDIT FAILURE: Speaker is silent during ${prayerName} time. TRIGGERING SMART RECOVERY...`);
            if (this.playbackLogger) this.playbackLogger.recordAuditResult(prayerName, false);
            this.sessionStatus.set(prayerName, 'RECOVERING');
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
                        const isAdhan = status.applications.some(app => app.statusText && app.statusText.includes('Adhan'));
                        if (!isAdhan) triggerEmergency();
                        else {
                            log(`✅ Audit Passed: ${prayerName} is confirmed playing.`);
                            if (this.playbackLogger) this.playbackLogger.recordAuditResult(prayerName, true);
                            finishAudit();
                        }
                    }
                });
            }
        });

        setTimeout(() => {
            if (!auditDevice) {
                log(`⚠️ Audit Discovery Timeout. Resetting system...`);
                triggerEmergency();
            }
        }, 15000);
    }
}

module.exports = CoreScheduler;
