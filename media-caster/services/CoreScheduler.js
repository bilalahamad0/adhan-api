const schedule = require('node-schedule');
const { DateTime } = require('luxon');
const path = require('path');
const fs = require('fs');
const dns = require('dns');
const axios = require('axios');
const { exec } = require('child_process');
const ChromecastAPI = require('chromecast-api');

/**
 * CoreScheduler V10: THE CLEAN REVERSION
 * Structurally identical to commit 603858cf.
 * No classes or services are touched during the casting flow.
 */
class CoreScheduler {
    constructor(config, hardwareService, mediaService, castService, scheduleFilePath, playbackLogger, pushNotifier) {
        this.config = config;
        this.hardware = hardwareService;
        this.media = mediaService;
        this.scheduleFilePath = scheduleFilePath;
        this.playbackLogger = playbackLogger || null;
        this.pushNotifier = pushNotifier || null;
        this.log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
        this.executePreFlightAndCast = this.executePreFlightAndCast.bind(this);
        this.auditPlayback = this.auditPlayback.bind(this);
        this.sessionStatus = new Map();
        this.activeRuns = new Set();
        this._scheduledJobs = [];
        this._castCachePath = path.join(__dirname, '..', '.cast-cache.json');
        // Window-retry state persisted here so scheduled retries survive a
        // pm2 reload / crash / auto-updater deploy. .adhan-data/ is excluded
        // from the BuildManager rsync, so this file is preserved across deploys.
        this._pendingRetriesPath = (playbackLogger && playbackLogger.dataDir)
            ? path.join(playbackLogger.dataDir, 'pending-retries.json')
            : path.join(__dirname, '..', '.pending-retries.json');
    }

    _readCastCache() {
        try {
            if (!fs.existsSync(this._castCachePath)) return null;
            const data = JSON.parse(fs.readFileSync(this._castCachePath, 'utf8'));
            if (!data || !data.host || !data.friendlyName) return null;
            // TTL: ignore entries older than CAST_CACHE_TTL_HOURS (default 24h).
            // The cache now stores a resolved IPv4 (see _writeCastCache), so a
            // stale entry is caught cheaply by the unicast probe rather than by
            // the timer — meaning the TTL only needs to bound how long we trust a
            // DHCP lease. 24h is the smallest value that spans the longest daily
            // prayer gap (Fajr→Dhuhr ≈ 9h): a 6h TTL forced every Dhuhr back onto
            // cold mDNS, which is what let a multicast stall delay playback.
            const ttlHours = Number(process.env.CAST_CACHE_TTL_HOURS || 24);
            if (data.lastSuccessIso && Number.isFinite(ttlHours) && ttlHours > 0) {
                const ageMs = Date.now() - Date.parse(data.lastSuccessIso);
                if (Number.isFinite(ageMs) && ageMs > ttlHours * 3600 * 1000) {
                    data._expired = true;
                }
            }
            return data;
        } catch (_) {
            return null;
        }
    }

    async _writeCastCache(device, log) {
        try {
            // Capture fields synchronously — the device object may be mutated /
            // torn down while we resolve.
            const rawHost = device && device.host;
            const friendlyName = device && device.friendlyName;
            const port = (device && device.port) || 8009;
            if (!rawHost || !friendlyName) return;

            // Store a resolved IPv4, NOT the mDNS SRV target. chromecast-api 0.4.2
            // sets device.host to the SRV target (e.g. fuchsia-XXXX.local); probing
            // that later forces the OS resolver back through mDNS/multicast (a .local
            // getaddrinfo needs the announcement still cached in avahi, TTL ~120s),
            // so the warm cache silently missed every prayer. We resolve here, while
            // the device was just seen over multicast, so the warm path becomes a
            // pure unicast TCP probe that no longer touches the flaky Wi-Fi↔LAN bridge.
            const ip = await this._resolveHostToIpv4(rawHost, log);
            const payload = {
                friendlyName,
                host: ip || rawHost, // fall back to raw host so we never regress
                port,
                mdnsHost: rawHost,   // keep the SRV target for debugging / re-resolution
                resolved: Boolean(ip),
                lastSuccessIso: new Date().toISOString(),
            };
            fs.writeFileSync(this._castCachePath, JSON.stringify(payload, null, 2));
            if (log && ip && ip !== rawHost) {
                log(`🧭 Cast cache stored IP ${ip} for "${friendlyName}" (mDNS host ${rawHost}).`);
            }
        } catch (_) { /* cache write failure is non-fatal */ }
    }

    /**
     * Bump lastSuccessIso on a validated warm hit so a device that keeps
     * answering never ages out of the cache. (A cold mDNS discovery rewrites
     * the whole entry; this only slides the TTL for the hit path.)
     */
    _touchCastCache() {
        try {
            if (!fs.existsSync(this._castCachePath)) return;
            const data = JSON.parse(fs.readFileSync(this._castCachePath, 'utf8'));
            if (!data || !data.host) return;
            data.lastSuccessIso = new Date().toISOString();
            fs.writeFileSync(this._castCachePath, JSON.stringify(data, null, 2));
        } catch (_) { /* non-fatal */ }
    }

    /**
     * Resolve a discovered cast host to a stable IPv4. Returns null on failure so
     * the caller can fall back to the raw host. Order: pass through a literal
     * IPv4 (the SSDP path already yields rinfo.address); else a direct mDNS
     * A-record query (works even on avahi-only Pis where nss-mdns is not wired
     * into nsswitch); else the OS resolver.
     */
    async _resolveHostToIpv4(host, log) {
        if (!host || typeof host !== 'string') return null;
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
        const name = host.endsWith('.') ? host.slice(0, -1) : host;

        const viaMdns = await this._resolveViaMdns(name).catch(() => null);
        if (viaMdns) return viaMdns;

        const viaLookup = await new Promise((resolve) => {
            try {
                dns.lookup(name, { family: 4 }, (err, address) => resolve(err ? null : address));
            } catch (_) { resolve(null); }
        });
        if (viaLookup) return viaLookup;

        if (log) log(`⚠️ Cast cache: could not resolve ${name} to IPv4; caching raw host.`);
        return null;
    }

    /**
     * Direct mDNS A-record lookup on its own socket (independent of the scanner).
     * Resolves to an IPv4 string or null. multicast-dns is a transitive dep of
     * chromecast-api; required lazily so a dependency-tree change degrades to the
     * dns.lookup fallback instead of crashing the caster.
     */
    _resolveViaMdns(name, timeoutMs = 2000) {
        return new Promise((resolve) => {
            let mdns;
            try {
                mdns = require('multicast-dns')();
            } catch (_) {
                return resolve(null);
            }
            let done = false;
            const finish = (ip) => {
                if (done) return;
                done = true;
                try { mdns.destroy(); } catch (_) { /* ignore */ }
                resolve(ip || null);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            mdns.on('response', (res) => {
                const records = (res.answers || []).concat(res.additionals || []);
                const a = records.find((r) => r && r.type === 'A' && r.name === name && r.data);
                if (a) {
                    clearTimeout(timer);
                    finish(a.data);
                }
            });
            try {
                mdns.query(name, 'A');
            } catch (_) {
                clearTimeout(timer);
                finish(null);
            }
        });
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
            // MUST be lowercase 'device' — the file is chromecast-api/lib/device.js.
            // Capital 'Device' resolves on case-insensitive macOS but throws on the
            // Pi's case-sensitive Linux fs, which silently disabled the entire
            // warm-cache path (every cast fell back to flaky mDNS).
            DeviceCls = require('chromecast-api/lib/device');
        } catch (e) {
            // Log rather than swallow: if this ever fails to load again, the
            // warm-cache path is dead and we want it visible, not silent.
            log(`⚠️ Cast cache: could not load Device class (${e.message}); using mDNS.`);
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

    async _probeDevice(device, timeoutMs = 3000) {
        if (!device) return false;
        return new Promise((resolve) => {
            let done = false;
            const finish = (ok) => { if (done) return; done = true; resolve(ok); };
            const t = setTimeout(() => finish(false), timeoutMs);
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
    }

    _getDynamicVolume(prayerName, isTvActive) {
        const normalizedName = String(prayerName || '')
            .charAt(0).toUpperCase() + String(prayerName || '').slice(1).toLowerCase();
        if (isTvActive) return normalizedName === 'Fajr' ? 0.35 : 0.45;

        const baseVolumeMap = {
            Fajr: 0.30,
            Dhuhr: 0.40,
            Asr: 0.40,
            Maghrib: 0.40,
            Isha: 0.40,
        };
        return baseVolumeMap[normalizedName] || 0.40;
    }

    async discoverDeviceByName(deviceName, log, prayerName, customTimeoutMs = null) {
        // Warm path: prior successful cast persisted host:port. Skip mDNS entirely
        // when the cache is fresh + reachable — sidesteps Wi-Fi↔LAN multicast bridges
        // (Xfinity gateways often drop UDP 5353 across the wired/wireless boundary).
        const cache = this._readCastCache();
        // Adaptive skip: if the cached hostname has been silently unreachable
        // for the last N prayers, stop wasting a 3s probe on it every time.
        // N defaults to 3 (about one prayer-day's worth of evidence).
        const STALE_STREAK_SKIP = Number(process.env.CAST_CACHE_STALE_STREAK || 3);
        const staleStreak = this.playbackLogger
            ? this.playbackLogger.getConsecutiveCacheStaleCount(deviceName)
            : 0;
        const skipDueToStreak = staleStreak >= STALE_STREAK_SKIP;

        if (cache && cache.friendlyName === deviceName && cache._expired) {
            log(`📡 Cast cache expired (>${process.env.CAST_CACHE_TTL_HOURS || 24}h since last success); forcing mDNS.`);
        } else if (cache && cache.friendlyName === deviceName && skipDueToStreak) {
            log(`📡 Cast cache skipped: ${staleStreak} consecutive stale events for ${deviceName}; going straight to mDNS.`);
        } else if (cache && cache.friendlyName === deviceName) {
            log(`📡 Cast cache hit: ${deviceName} @ ${cache.host}:${cache.port || 8009}; probing…`);
            const cached = await this._connectToCachedDevice(cache, log);
            if (cached) {
                log(`✅ Cast cache validated; skipping mDNS discovery.`);
                this._touchCastCache();
                if (this.playbackLogger) {
                    this.playbackLogger.recordDeviceDiscovered(prayerName, deviceName, { cacheHit: true });
                }
                return cached;
            }
            log(`⚠️ Cast cache stale (no receiver response); falling back to mDNS.`);
            if (this.playbackLogger) this.playbackLogger.recordCacheStale(prayerName, deviceName);
        }

        return new Promise((resolve) => {
            const totalTimeoutMs = customTimeoutMs || 120000;
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
                        // Fire-and-forget: resolving + persisting the IP only helps
                        // future casts, so it must not delay finish()/this cast.
                        this._writeCastCache(device, log);
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
        // Reset window-retry counters so yesterday's exhausted retries don't lock today out,
        // then re-arm any still-valid retries that were persisted before a reload/crash.
        if (this._discoveryRetryAttempts) this._discoveryRetryAttempts.clear();
        if (this._pendingRetries) this._pendingRetries.clear();
        this._restorePendingRetries();

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

            // Push notification fires AT the scheduled prayer time (not 5 min
            // early like the cast preflight), so the alert matches the Adhan.
            const scheduledTimeLabel = scheduleTime.toFormat('h:mm a');
            this._scheduledJobs.push(
                schedule.scheduleJob(scheduleTime.toJSDate(), () => {
                    if (!this.pushNotifier) return;
                    Promise.resolve()
                        .then(() => this.pushNotifier.notifyPrayer(prayer, { time: scheduledTimeLabel }))
                        .catch(() => {});
                }),
            );

            log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')}, Audit: ${auditTime.toFormat('h:mm:ss a')})`);
        });

        this._scheduleMorningScene(today, todayEntry, log, 'sunrise');
        this._scheduleMorningScene(today, todayEntry, log, 'ishraq');
    }

    /**
     * Per-scene metadata. runKey is the activeRuns entry (chosen so it can never
     * collide with a prayer name); file is the cached clip served over HTTP.
     */
    static get MORNING_SCENES() {
        return {
            sunrise: { runKey: 'Sunrise', label: 'Sunrise', emoji: '🌅', file: 'sunrise.mp4' },
            ishraq: { runKey: 'Ishraq', label: 'Ishraq', emoji: '🌤️', file: 'ishraq.mp4' },
        };
    }

    /**
     * Arms a decorative morning clip (sunrise or ishraq) off
     * todayEntry.timings.Sunrise — already location-matched and zoned by the
     * Aladhan calendar fetch above, so there is no extra request and no schema
     * change. Ishraq is simply sunrise + a larger offset (the voluntary Duha
     * prayer becomes permissible ~15-20min after sunrise).
     *
     * Neither is a prayer, so neither joins the `prayers` array: no adhan audio,
     * no T-5min preflight, no audit, no push, no PlaybackLogger playback event.
     * See castScene() for the Adhan-safety contract.
     *
     * Jobs go on this._scheduledJobs so the next scheduleToday() cancels them,
     * exactly like the prayer jobs.
     */
    _scheduleMorningScene(today, todayEntry, log, sceneKey) {
        const cfg = (this.config && this.config[sceneKey]) || {};
        const meta = CoreScheduler.MORNING_SCENES[sceneKey];
        if (!cfg.enabled) return;

        const raw = todayEntry && todayEntry.timings && todayEntry.timings.Sunrise;
        if (!raw) return log(`   - ${meta.label}: no sunrise timing in schedule, skipped.`);

        const [hours, minutes] = String(raw).split(' ')[0].split(':').map(Number);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
            return log(`   - ${meta.label}: unparseable timing "${raw}", skipped.`);
        }

        const now = DateTime.now().setZone(this.config.timezone);
        const castTime = today
            .set({ hour: hours, minute: minutes, second: 0, millisecond: 0 })
            .plus({ seconds: cfg.offsetSec || 0 });
        if (castTime < now) return; // Already passed today — same guard as the prayers loop.

        // Pre-bake ahead of the cast so encoding never overlaps the cast itself.
        // The clip is identical every day, so after the first bake this is a
        // no-op stat(). Even Ishraq (sunrise+~20min) pre-bakes long after any
        // Fajr run or retry window has closed — the tightest Fajr->Sunrise gap in
        // the annual schedule is ~71min.
        const bakeTime = castTime.minus({ seconds: cfg.prebakeSec });
        if (bakeTime > now) {
            this._scheduledJobs.push(
                schedule.scheduleJob(bakeTime.toJSDate(), () =>
                    this.ensureSceneClip(sceneKey).catch((e) => log(`⚠️ ${meta.label} bake failed: ${e.message}`))),
            );
        }

        this._scheduledJobs.push(
            schedule.scheduleJob(castTime.toJSDate(), () =>
                this.castScene(sceneKey, castTime.toFormat('h:mm a'))
                    .catch((e) => log(`⚠️ ${meta.label} cast failed: ${e.message}`))),
        );

        log(`   - ${meta.label}: ${castTime.toFormat('h:mm')} (silent, ${cfg.clipSeconds}s, Bake: ${bakeTime.toFormat('h:mm:ss a')})`);
    }

    /**
     * Bakes a scene clip if the cached one is missing or was built with different
     * settings. Each clip is fully procedural and date-independent, so this is a
     * once-ever cost per scene that self-heals if the file is removed.
     */
    async ensureSceneClip(sceneKey) {
        const cfg = (this.config && this.config[sceneKey]) || {};
        const meta = CoreScheduler.MORNING_SCENES[sceneKey];
        const outputPath = path.join(__dirname, '..', '..', 'images', 'generated', meta.file);
        const stampPath = `${outputPath}.json`;
        // v11: Arabic -> y650, tagline -> y750 — bump so v10 clips rebake. The
        // caption layout isn't otherwise in the stamp, so this version bump is
        // what invalidates them. tagline stays part of identity.
        const stamp = JSON.stringify({
            v: 11, scene: sceneKey, durationSec: cfg.clipSeconds, tagline: cfg.tagline || null,
        });

        try {
            if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 10000
                && fs.existsSync(stampPath) && fs.readFileSync(stampPath, 'utf8') === stamp) {
                return outputPath;
            }
        } catch (_) { /* fall through and rebake */ }

        // Single-flight, PER SCENE. The pre-bake job and a manual trigger can both
        // land here while an encode is running; without this they would run two
        // ffmpeg processes against the same output path, and the loser would stamp
        // a half-written file as valid — poisoning the cache until the next config
        // change. Sunrise and ishraq bake independently, so the lock is keyed.
        this._sceneBakes = this._sceneBakes || {};
        if (this._sceneBakes[sceneKey]) return this._sceneBakes[sceneKey];

        this._sceneBakes[sceneKey] = (async () => {
            const dir = path.dirname(outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const { promise, abort } = this.media.encodeSceneClip(outputPath, sceneKey, {
                durationSec: cfg.clipSeconds,
                tagline: cfg.tagline,
            });

            let timer;
            try {
                await Promise.race([
                    promise,
                    new Promise((_, reject) => {
                        timer = setTimeout(() => {
                            abort();
                            reject(new Error('SCENE_ENCODE_TIMEOUT'));
                        }, 120000);
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }

            // Stamp only after a clean encode, so an aborted bake is retried
            // rather than cached.
            fs.writeFileSync(stampPath, stamp);
            return outputPath;
        })();

        try {
            return await this._sceneBakes[sceneKey];
        } finally {
            this._sceneBakes[sceneKey] = null;
        }
    }

    /**
     * Casts a scene clip. Intentionally NOT routed through
     * executePreFlightAndCast: that path requires an adhan mp3, a dashboard
     * render, a fallback video and a Dua phase, and it logs playback events.
     *
     * Three things this must never do, each of which would harm the Adhan:
     *  - Log a PlaybackLogger playback event. A non-adhan PLAYED/FAILED would
     *    count toward the daily success rate and break the streak.
     *  - Touch the TV via ADB. Yanking a user's stream for a decorative clip is
     *    worse than skipping the clip.
     *  - Touch the device volume. The next prayer reads the live volume as its
     *    "original" and restores to it afterwards, so any change left behind
     *    would make the Adhan itself play quiet. The clips are silent, so there
     *    is no reason to set a level at all — the safest handling of volume is to
     *    never call setVolume.
     */
    async castScene(sceneKey, timeLabel = '') {
        const cfg = this.config[sceneKey];
        const meta = CoreScheduler.MORNING_SCENES[sceneKey];
        if (!cfg || !cfg.enabled) return;
        const log = this.log;
        const runKey = meta.runKey;

        // Check self first: otherwise a double-trigger reports "another cast is
        // active" when the only active run is this one.
        if (this.activeRuns.has(runKey)) {
            return log(`${meta.emoji} ${meta.label} skipped: already casting.`);
        }
        // Never contend with a prayer (or the other scene). A missed clip is a
        // non-event; the Adhan always wins the device.
        if (this.activeRuns.size > 0) {
            return log(`${meta.emoji} ${meta.label} skipped: another cast is active.`);
        }
        this.activeRuns.add(runKey);

        let device = null;
        let finished = false;
        let watchdog = null;

        const finish = () => {
            if (finished) return;
            finished = true;
            if (device) {
                // A prayer starting mid-clip should be impossible: it holds
                // activeRuns from T-5min through the Dua, so the guard above
                // rejects us first. But a second Device joins the SAME receiver
                // session, so if it ever did overlap, stop() would cut off the
                // Adhan. Skipped in that case; close() still runs, since it only
                // drops our own socket and would otherwise leak the connection.
                const prayerOwnsDevice = [...this.activeRuns].some((r) => r !== runKey);
                if (!prayerOwnsDevice) {
                    try { device.stop(() => {}); } catch (_) { /* ignore */ }
                }
                try { device.close(); } catch (_) { /* ignore */ }
            }
            this.activeRuns.delete(runKey);
        };

        try {
            const clipPath = await this.ensureSceneClip(sceneKey);
            device = await this.discoverDeviceByName(this.config.device.name, log, runKey, 60000);
            if (!device) return log(`${meta.emoji} ${meta.label} skipped: display not found.`);

            const localIp = require('ip').address();
            const url = `http://${localIp}:${this.config.serverPort}/images/generated/${path.basename(clipPath)}?t=${Date.now()}`;

            // Armed only now, and only around the cast itself. Arming it earlier
            // would let it fire during discovery (60s budget) or a cold bake
            // (120s), running the one-shot finish() while the cast was still
            // starting — leaving the connection open for the next prayer to
            // inherit. The phases before this each carry their own timeout.
            watchdog = setTimeout(finish, (cfg.clipSeconds + 25) * 1000);

            // Volume is deliberately never touched. The clip is silent, so there
            // is nothing to set a level for — and not calling setVolume means
            // there is no way to leave the Hub at the wrong level for the next
            // Adhan, which reads the live volume as its own "original".
            await new Promise((resolve, reject) => {
                device.play({
                    url,
                    contentType: 'video/mp4',
                    // Carries today's time without rebaking the clip.
                    metadata: {
                        type: 1,
                        metadataType: 0,
                        title: timeLabel ? `${meta.label} · ${timeLabel}` : meta.label,
                    },
                }, (playErr) => (playErr ? reject(playErr) : resolve()));
            });

            log(`${meta.emoji} ${meta.label} cast (${cfg.clipSeconds}s, silent).`);
            await new Promise((r) => setTimeout(r, (cfg.clipSeconds + 2) * 1000));
        } finally {
            if (watchdog) clearTimeout(watchdog);
            finish();
        }
    }

    /** Back-compat aliases: the sunrise scene. */
    ensureSunriseClip() { return this.ensureSceneClip('sunrise'); }
    castSunrise(timeLabel = '') { return this.castScene('sunrise', timeLabel); }

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

        // Prevent massively delayed triggers (e.g. clock jumps after network reconnect)
        if (targetTimeObj) {
            const delayMs = Date.now() - targetTimeObj.toMillis();
            if (delayMs > 30 * 60 * 1000) { // 30 minutes
                log(`⏭️ Skipping ${prayerName}: trigger is too old (latency: ${Math.round(delayMs / 1000)}s). System clock likely jumped.`);
                if (!this._isRescheduling) {
                    this._isRescheduling = true;
                    log(`🔄 Initiating True Recovery: Syncing and rescheduling based on correct system time.`);
                    this.scheduleToday().catch(e => log(`❌ Recovery failed: ${e.message}`)).finally(() => {
                        this._isRescheduling = false;
                    });
                }
                return;
            }
        }

        if (!targetTimeObj && (state === 'PLAYING' || state === 'DUA' || state === 'COMPLETED')) {
            return;
        }

        this.activeRuns.add(prayerName);

        log(`🚀 TRIGGER: ${prayerName} Time! Starting sequence...`);

        // NOTE: the prayer push notification is scheduled separately, AT the
        // actual prayer time (see scheduleToday). It is intentionally NOT sent
        // here because this preflight runs ~5 min early to prepare the cast.

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

        log(`📡 Checkpoint 2: Pre-staging device discovery (during wait)...`);
        this.sessionStatus.set(prayerName, 'WAITING');

        if (this.playbackLogger) this.playbackLogger.recordDiscoveryStart(prayerName);
        
        let timeUntilPrayerMs = targetTimeObj ? Math.max(0, targetTimeObj.toMillis() - Date.now()) : 0;
        // Allow discovery to use the full wait period, or at least 120s if already past time
        let preStageTimeout = Math.max(120000, timeUntilPrayerMs);
        
        const preStagedDevice = await this.discoverDeviceByName(CONFIG.device.name, log, prayerName, preStageTimeout);
        if (preStagedDevice) {
            log(`✅ Device pre-staged: ${CONFIG.device.name}. Waiting for prayer time...`);
        } else {
            log(`⚠️ Pre-stage discovery failed; will retry at prayer time.`);
        }

        let castFiredAtMs = null;
        if (targetTimeObj) {
            // Cast connect + receiver buffer adds latency before audible playback.
            // Fire Checkpoint 3 slightly before prayer time so the muezzin's first
            // syllable lands at ~T+0. The lead is adaptive: a rolling p75 of recent
            // observed cast-to-playing latencies (PlaybackLogger), falling back to
            // PRAYER_CAST_LEAD_MS (default 2000ms) until enough history exists.
            const fallbackLeadMs = Number(process.env.PRAYER_CAST_LEAD_MS || 2000);
            const castLeadMs = this.playbackLogger
                ? this.playbackLogger.getRecommendedCastLeadMs(fallbackLeadMs)
                : fallbackLeadMs;
            const delay = targetTimeObj.toMillis() - Date.now() - castLeadMs;
            if (delay > 0) {
                log(`⏳ Waiting ${Math.round(delay/1000)}s until cast (adaptive lead ${castLeadMs}ms)...`);
                await new Promise(r => setTimeout(r, delay));
            }
            castFiredAtMs = Date.now();
            log(`🚀 Checkpoint 3: Casting now (lead ${castLeadMs}ms before prayer time)...`);
        }

        let discoveredDevice = null;
        if (preStagedDevice) {
            // Single 3s probes mis-fire on momentary mDNS hiccups (Wi-Fi handoff,
            // gateway multicast bridge stall). Try up to 3 times with a short gap
            // before giving up — total budget ~9s, still well under any audit
            // schedule and far cheaper than a 120s mDNS rescan.
            let ok = false;
            for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
                ok = await this._probeDevice(preStagedDevice);
                if (!ok && attempt < 3) {
                    log(`⏳ Pre-stage probe ${attempt}/3 missed; retrying in 2s…`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            if (ok) {
                log(`✅ Pre-staged device still alive; skipping re-discovery.`);
                discoveredDevice = preStagedDevice;
            } else {
                log(`⚠️ Pre-staged device went stale (3 probes failed); falling back to live discovery...`);
                discoveredDevice = await this.discoverDeviceByName(CONFIG.device.name, log, prayerName);
            }
        } else {
            log(`📡 No pre-staged device; starting live discovery...`);
            discoveredDevice = await this.discoverDeviceByName(CONFIG.device.name, log, prayerName);
        }

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
                        // Verify PAUSE actually took effect. Some apps — Plex live TV,
                        // Netflix/YouTube live streams, some IPTV clients — silently
                        // ignore KEYCODE_MEDIA_PAUSE because they're live broadcasts.
                        // If still playing, fall back to MUTE so the Adhan isn't
                        // talking over a live channel.
                        await new Promise(r => setTimeout(r, 750));
                        let postPause;
                        try {
                            postPause = await hardwareService.getAudioStatus(tvIp);
                        } catch (e) {
                            log(`⚠️ Pause-verify status read failed: ${e.message}; assuming pause succeeded.`);
                        }
                        if (postPause && postPause.isMediaSessionPlaying) {
                            log(`⚠️ PAUSE ignored by current app (likely live stream). Falling back to MUTE.`);
                            if (!postPause.isMuted && !postPause.isSonyMuted) {
                                await hardwareService.setMuteState(tvIp, true);
                                tvWasMuted = true;
                            } else {
                                log(`ℹ️ TV already muted by user; nothing to do.`);
                            }
                            // Leave tvWasPaused=false — we don't want cleanup's
                            // resumeMedia() to fire a stray PLAY keyevent later.
                        } else {
                            tvWasPaused = true;
                        }
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
                const tvWasActive = tvWasPaused || tvWasMuted;
                const dynamicVolume = this._getDynamicVolume(prayerName, tvWasActive);
                log(`🔊 Setting Volume to ${(dynamicVolume * 100).toFixed(0)}% (${prayerName}${tvWasActive ? ', TV active override' : ''})`);
                device.setVolume(dynamicVolume, () => {
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
                                if (castFiredAtMs) {
                                    this.playbackLogger.recordCastToPlaying(prayerName, Date.now() - castFiredAtMs);
                                }
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
        // Window-retry: device often becomes reachable again within minutes
        // (Chromecast firmware self-update, mDNS responder restart, etc.).
        // Re-arm at T+3min and T+8min from the original prayer time, capped
        // at 2 retries and only while still within a sensible prayer window.
        this._scheduleDiscoveryRetry(prayerName, audioFileName, targetTimeObj);
    }

    /**
     * Schedule re-attempts after a DISCOVERY_TIMEOUT. Caps at 2 retries and
     * never crosses the prayer-window boundary (defaults to 15 minutes past
     * the original prayer time — comfortably inside even Maghrib's short
     * valid window).
     */
    _scheduleDiscoveryRetry(prayerName, audioFileName, targetTimeObj) {
        if (!targetTimeObj) return; // No anchor; this call was itself an emergency.
        this._pendingRetries = this._pendingRetries || new Map();
        const attempts = this._discoveryRetryAttempts || (this._discoveryRetryAttempts = new Map());
        const prior = attempts.get(prayerName) || 0;
        const OFFSETS_MIN = [3, 8];
        const PRAYER_WINDOW_MIN = Number(process.env.PRAYER_RETRY_WINDOW_MIN || 15);

        if (prior >= OFFSETS_MIN.length) {
            this.log(`⏭️ ${prayerName}: discovery retry cap (${OFFSETS_MIN.length}) reached; not rescheduling.`);
            attempts.delete(prayerName);
            this._pendingRetries.delete(prayerName);
            this._persistPendingRetries();
            return;
        }

        const retryAtMs = Date.now() + OFFSETS_MIN[prior] * 60000;
        const minutesPastPrayer = (retryAtMs - targetTimeObj.toMillis()) / 60000;
        if (minutesPastPrayer > PRAYER_WINDOW_MIN) {
            this.log(`⏭️ ${prayerName}: next retry would land +${minutesPastPrayer.toFixed(1)}min past prayer (window cap ${PRAYER_WINDOW_MIN}min); skipping.`);
            attempts.delete(prayerName);
            this._pendingRetries.delete(prayerName);
            this._persistPendingRetries();
            return;
        }

        const nextAttempt = prior + 1;
        attempts.set(prayerName, nextAttempt);
        this._pendingRetries.set(prayerName, {
            audioFileName,
            retryAtMs,
            targetTimeIso: targetTimeObj.toISO(),
            attempts: nextAttempt,
        });
        this._persistPendingRetries();

        const retryDate = new Date(retryAtMs);
        this.log(`🔁 ${prayerName}: scheduling window-retry #${nextAttempt}/${OFFSETS_MIN.length} at ${retryDate.toLocaleTimeString()} (+${OFFSETS_MIN[prior]}min, +${minutesPastPrayer.toFixed(1)}min past prayer)`);

        this._scheduledJobs.push(
            schedule.scheduleJob(retryDate, () => this._fireRetry(prayerName, audioFileName, targetTimeObj))
        );
    }

    /** Fires a scheduled window-retry: clear its pending marker (+persist) then re-run the cast. */
    _fireRetry(prayerName, audioFileName, targetTimeObj) {
        if (this._pendingRetries) this._pendingRetries.delete(prayerName);
        this._persistPendingRetries();
        this.executePreFlightAndCast(prayerName, audioFileName, targetTimeObj);
    }

    /** Serializes the in-memory pending-retry map to disk (best-effort). */
    _persistPendingRetries() {
        try {
            const retries = [];
            if (this._pendingRetries) {
                for (const [prayerName, info] of this._pendingRetries.entries()) {
                    if (info && typeof info === 'object') retries.push({ prayerName, ...info });
                }
            }
            fs.writeFileSync(this._pendingRetriesPath, JSON.stringify({ savedAt: new Date().toISOString(), retries }, null, 2));
        } catch (e) {
            this.log(`⚠️ Failed to persist pending retries: ${e.message}`);
        }
    }

    /**
     * Re-arms window-retries that were persisted before a reload/crash. Drops
     * any entry already past its prayer window. A retry whose slot elapsed
     * during downtime fires shortly after boot (if still in-window).
     */
    _restorePendingRetries() {
        let data;
        try {
            if (!fs.existsSync(this._pendingRetriesPath)) return;
            data = JSON.parse(fs.readFileSync(this._pendingRetriesPath, 'utf8'));
        } catch (e) {
            this.log(`⚠️ Failed to read pending retries: ${e.message}`);
            return;
        }
        if (!data || !Array.isArray(data.retries) || data.retries.length === 0) return;

        this._pendingRetries = this._pendingRetries || new Map();
        this._discoveryRetryAttempts = this._discoveryRetryAttempts || new Map();
        const now = Date.now();
        const PRAYER_WINDOW_MIN = Number(process.env.PRAYER_RETRY_WINDOW_MIN || 15);
        let restored = 0;

        for (const r of data.retries) {
            if (!r || !r.prayerName || !r.audioFileName || !r.retryAtMs || !r.targetTimeIso) continue;
            const targetTimeObj = DateTime.fromISO(r.targetTimeIso, { zone: this.config.timezone });
            if (!targetTimeObj.isValid) continue;
            // Drop entries already past the prayer window (e.g. yesterday's).
            if ((r.retryAtMs - targetTimeObj.toMillis()) / 60000 > PRAYER_WINDOW_MIN) continue;

            this._discoveryRetryAttempts.set(r.prayerName, r.attempts || 1);
            const fireAtMs = r.retryAtMs <= now ? now + 2000 : r.retryAtMs;
            if (r.retryAtMs <= now) {
                this.log(`🔁 Restoring overdue retry for ${r.prayerName}; firing shortly (was due ${new Date(r.retryAtMs).toLocaleTimeString()}).`);
            } else {
                this.log(`🔁 Restoring pending retry for ${r.prayerName} at ${new Date(r.retryAtMs).toLocaleTimeString()}.`);
            }
            this._pendingRetries.set(r.prayerName, {
                audioFileName: r.audioFileName,
                retryAtMs: fireAtMs,
                targetTimeIso: r.targetTimeIso,
                attempts: r.attempts || 1,
            });
            this._scheduledJobs.push(
                schedule.scheduleJob(new Date(fireAtMs), () => this._fireRetry(r.prayerName, r.audioFileName, targetTimeObj))
            );
            restored++;
        }

        if (restored > 0) {
            this.log(`✅ Restored ${restored} pending discovery-retr${restored === 1 ? 'y' : 'ies'} from disk.`);
            this._persistPendingRetries();
        }
    }

    /**
     * AUDIT JOB: Runs 30s after target time.
     * Silent check via API. Triggers emergency recovery only when the
     * primary run has fully released and no scheduled retry is pending —
     * avoids racing the original discovery loop (which could still find
     * the device late and double-cast).
     *
     * Before 2026-05: the audit treated `activeRuns.has(prayer)` as proof
     * of life and exited SUCCESS, which silently masked the 4-minute
     * Maghrib discovery failure on 2026-05-20. Now the audit re-polls
     * up to MAX_AUDIT_FOLLOWUPS times before deferring to the
     * discovery-retry path (executePreFlightAndCast self-reschedule).
     */
    async auditPlayback(prayerName, audioFileName, depth = 0) {
        const log = this.log;
        const state = this.sessionStatus.get(prayerName);
        const MAX_AUDIT_FOLLOWUPS = 4; // 4 × 60s = up to 4.5min of polling

        // Proof of life: only actual playback states count as success.
        if (state === 'PLAYING' || state === 'BUFFERING' || state === 'DUA' || state === 'COMPLETED') {
            log(`✅ Audit: ${prayerName} confirmed (state: ${state}).`);
            if (this.playbackLogger) this.playbackLogger.recordAuditResult(prayerName, true);
            return;
        }

        // Original run still working. Don't race it — re-poll instead.
        if (this.activeRuns.has(prayerName)) {
            if (depth < MAX_AUDIT_FOLLOWUPS) {
                log(`⚠️ Audit: ${prayerName} at-risk (state: ${state || 'UNKNOWN'}); rechecking in 60s. [follow-up ${depth + 1}/${MAX_AUDIT_FOLLOWUPS}]`);
                this._scheduledJobs.push(
                    schedule.scheduleJob(new Date(Date.now() + 60000), () => this.auditPlayback(prayerName, audioFileName, depth + 1))
                );
                return;
            }
            log(`⚠️ Audit: ${prayerName} still in-flight after ${MAX_AUDIT_FOLLOWUPS} follow-ups (state: ${state || 'UNKNOWN'}); deferring to discovery-retry path.`);
            if (this.playbackLogger) this.playbackLogger.recordAuditResult(prayerName, false);
            return;
        }

        // Discovery-retry already queued? Let that handle recovery instead of double-firing.
        if (this._pendingRetries && this._pendingRetries.has(prayerName)) {
            log(`⏭️ Audit: ${prayerName} not playing but window retry already scheduled; deferring.`);
            if (this.playbackLogger) this.playbackLogger.recordAuditResult(prayerName, false);
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
