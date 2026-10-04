const schedule = require('node-schedule');
const { DateTime } = require('luxon');
const path = require('path');
const fs = require('fs');
const dns = require('dns');
const ChromecastAPI = require('chromecast-api');
const PrayerScheduleStore = require('./PrayerScheduleStore');

const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

// Pre-prayer revalidation (shared rule v2, implemented the same way by adhan-ce's
// background.js) so both apps converge on the freshest Aladhan answer. Aladhan
// geocodes the city server-side and its answer for the same URL can move a minute
// during a day, so each app samples today's timings at the same moment before
// every prayer P:
//   due when now >= P - REVALIDATE_AT_MS and now < P - REVALIDATE_WINDOW_END_MS,
//   today was last fetched before P - REVALIDATE_FRESH_MS, and no prayer is in
//   its REVALIDATE_QUIET_AFTER_MS quiet period.
// The T-45 job arms exactly at P - REVALIDATE_AT_MS; a failed, malformed or held
// answer is retried once at P - REVALIDATE_RETRY_AT_MS.
const REVALIDATE_AT_MS = 45 * 60 * 1000; // the sampling moment, "T-45"
// Fetched at or after T-50: fresh, no second fetch (a fetch just made, or a
// re-armed check after the prayer itself moved by a minute or two).
const REVALIDATE_FRESH_MS = 50 * 60 * 1000;
const REVALIDATE_WINDOW_END_MS = 30 * 60 * 1000; // nothing revalidates at or after T-30
const REVALIDATE_RETRY_AT_MS = 35 * 60 * 1000; // the Pi's one retry, inside [T-45, T-30)
// A check armed after T-45 (a boot or a re-arm) catches up this long after
// arming, or halfway to T-30 when that is sooner, so it still starts before T-30.
const REVALIDATE_CATCH_UP_MS = 30 * 1000;
// No revalidation from a prayer's time until this long after it (ts <= now < ts + 10min),
// so its push, audit and window-retries never see their jobs move. Before the
// prayer, the windows above keep every revalidation out of [T-30, T); the cast
// itself (from T-5) and any pending window-retry block too (see _revalidationBlocker).
const REVALIDATE_QUIET_AFTER_MS = 10 * 60 * 1000;
// Larger moves are still applied (both apps must converge) but logged as suspect,
// unless they move a prayer across "now": then, as in adhan-ce, the whole answer
// is rejected (see revalidationCrossesNow).
const LARGE_CHANGE_MS = 30 * 60 * 1000;
// The morning re-check (PRAYER_MORNING_REFRESH) retries once this long after a
// skipped or failed run. It does not run within [T-50, T) of any prayer: that
// prayer's own T-45 sample covers it, so both apps sample at the same moment.
const MORNING_REVALIDATION_RETRY_MS = 10 * 60 * 1000;
const MORNING_REVALIDATION_DEFAULT = { hour: 8, minute: 0 };

/**
 * CoreScheduler V10: THE CLEAN REVERSION
 * Structurally identical to commit 603858cf.
 * No classes or services are touched during the casting flow.
 */
class CoreScheduler {
    /**
     * options.onScheduleChanged(change): called after a revalidation moved
     * today's times and the jobs were re-armed (boot.js republishes Firestore).
     * It runs after the revalidation lock is released and is never awaited by
     * it; calls are queued in order and their errors are logged.
     */
    constructor(config, hardwareService, mediaService, castService, scheduleFilePath, playbackLogger, pushNotifier, options = {}) {
        this.config = config;
        this.hardware = hardwareService;
        this.media = mediaService;
        this.scheduleFilePath = scheduleFilePath;
        this.scheduleStore = new PrayerScheduleStore({
            location: config.location,
            timezone: config.timezone,
            filePath: scheduleFilePath,
            log: (msg) => this.log(msg),
        });
        this.playbackLogger = playbackLogger || null;
        this.pushNotifier = pushNotifier || null;
        this.log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
        this.executePreFlightAndCast = this.executePreFlightAndCast.bind(this);
        this.auditPlayback = this.auditPlayback.bind(this);
        this.sessionStatus = new Map();
        this.activeRuns = new Set();
        this._scheduledJobs = [];
        // { date, times: { Fajr: 'HH:mm', ..., Sunrise } } the current jobs were armed for.
        this._armed = null;
        this.onScheduleChanged = (options && options.onScheduleChanged) || null;
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
        // Fajr keeps its quiet level even when the TV is active — at that hour,
        // not waking the house matters more than carrying over whatever is
        // already playing.
        if (isTvActive) return normalizedName === 'Fajr' ? 0.10 : 0.45;

        const baseVolumeMap = {
            Fajr: 0.10,
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

    /**
     * 'HH:mm' from a cached Aladhan timing ('05:53', '05:53 (PDT)', '21:5'), or
     * null. Deliberately lenient: it arms whatever the cache holds. A freshly
     * fetched answer is only accepted when strict (PrayerScheduleStore.parseTiming).
     */
    static hhmm(raw) {
        const m = String(raw == null ? '' : raw).trim().match(/^(\d{1,2}):(\d{1,2})/);
        if (!m) return null;
        const hour = Number(m[1]);
        const minute = Number(m[2]);
        if (hour > 23 || minute > 59) return null;
        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }

    /** The five prayers plus Sunrise from a schedule entry, as 'HH:mm'. */
    static extractTimes(entry) {
        const times = {};
        for (const key of [...PRAYERS, 'Sunrise']) {
            const t = CoreScheduler.hhmm(entry && entry.timings && entry.timings[key]);
            if (t) times[key] = t;
        }
        return times;
    }

    /** `hhmm` on `day`'s date, in `day`'s zone. */
    static at(day, hhmm) {
        const [hour, minute] = hhmm.split(':').map(Number);
        return day.set({ hour, minute, second: 0, millisecond: 0 });
    }

    /**
     * adhan-ce's revalidationCrossesNow (lib/schedule.js) on 'HH:mm' times: the
     * prayers that replacing `prev` with `next` would flip between "already
     * passed" and "still upcoming" at `now` (re-fire one that fired, or skip one
     * that has not). A prayer missing from either side counts as crossing.
     * Upcoming means `>= now`, the test _armToday arms by.
     */
    static revalidationCrossesNow(prev, next, now) {
        return PRAYERS.filter((p) => {
            if (!prev[p] || !next[p]) return true;
            return (CoreScheduler.at(now, prev[p]) >= now) !== (CoreScheduler.at(now, next[p]) >= now);
        });
    }

    /** Strict 24h 'H:MM' / 'HH:MM' (e.g. PRAYER_MORNING_REFRESH) to { hour, minute }, or null. */
    static parseClockTime(raw) {
        const m = String(raw == null ? '' : raw).trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null;
        const hour = Number(m[1]);
        const minute = Number(m[2]);
        if (hour > 23 || minute > 59) return null;
        return { hour, minute };
    }

    _cancelScheduledJobs() {
        this._scheduledJobs.forEach((job) => {
            try {
                job.cancel();
            } catch (_) { /* ignore */ }
        });
        this._scheduledJobs = [];
    }

    async scheduleToday() {
        const config = this.config;
        const log = this.log;
        log("📅 Loading Schedule...");
        // Revalidation stands aside while this runs (see _revalidationBlocker).
        this._schedulingToday = true;
        try {
            // Cancel prior day's jobs so restarts / re-schedules never double-fire triggers.
            this._cancelScheduledJobs();
            this._armed = null;
            // Reset window-retry counters so yesterday's exhausted retries don't lock today out,
            // then re-arm any still-valid retries that were persisted before a reload/crash.
            if (this._discoveryRetryAttempts) this._discoveryRetryAttempts.clear();
            if (this._pendingRetries) this._pendingRetries.clear();
            this._restorePendingRetries();

            const today = DateTime.now().setZone(config.timezone);
            await this.scheduleStore.refresh(today);
            const todayEntry = this.scheduleStore.getEntry(today);
            if (!todayEntry) {
                log("❌ No schedule for today (Aladhan unreachable and nothing cached).");
                return false;
            }

            this._armToday(today, todayEntry);
            return true;
        } finally {
            this._schedulingToday = false;
        }
    }

    /**
     * Arms today's jobs from `todayEntry`: per prayer the T-5min preflight, the
     * audit, the push at prayer time and the pre-prayer revalidation; then the
     * morning scenes. Prayers before `now` are skipped.
     *
     * `previous` is set when a revalidation moved the times: the 'HH:mm' times
     * the cancelled jobs were armed for, and `now` is the instant the new answer
     * was checked at. revalidationCrossesNow rejected any answer that moves a
     * prayer across that instant, so a prayer is past under the new times
     * exactly when it fired under the old ones. Sunrise can move across it; the
     * morning scenes handle that (see _scheduleMorningScene).
     */
    _armToday(today, todayEntry, { previous = null, now = DateTime.now().setZone(this.config.timezone) } = {}) {
        const config = this.config;
        const log = this.log;
        const times = CoreScheduler.extractTimes(todayEntry);
        this._armed = { date: today.toISODate(), times };

        log(previous
            ? `🔁 Re-armed today's prayer times (${todayEntry.date.readable}):`
            : `✅ Today's Prayer Times (${todayEntry.date.readable}):`);
        PRAYERS.forEach(prayer => {
            const timeStr = times[prayer];
            if (!timeStr) {
                log(`   - ${prayer}: unparseable timing "${todayEntry.timings && todayEntry.timings[prayer]}", skipped.`);
                return;
            }
            const scheduleTime = CoreScheduler.at(today, timeStr);
            if (scheduleTime < now) return;

            const audioKey = prayer === 'Fajr' ? config.audio.fajrCurrent : config.audio.regularCurrent;
            const audioFile = `${audioKey}.mp3`;
            let triggerTime = scheduleTime.minus({ minutes: 5 });
            if (triggerTime < now) {
                triggerTime = now.plus({ seconds: 2 });
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

            const recheck = this._armRevalidation(today, prayer, scheduleTime, now);
            log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')}, Audit: ${auditTime.toFormat('h:mm:ss a')}${recheck ? `, Recheck: ${recheck.toFormat('h:mm:ss a')}` : ''})`);
        });

        const previousSunrise = previous ? previous.Sunrise || null : null;
        this._scheduleMorningScene(today, todayEntry, log, 'sunrise', { now, previousSunrise });
        this._scheduleMorningScene(today, todayEntry, log, 'ishraq', { now, previousSunrise });
    }

    /**
     * The shared rule's moments for the prayer at `prayerTime` (DateTimes):
     * at (T-45, the sample), freshSince (T-50: a fetch at or after it is fresh),
     * end (T-30, exclusive) and retryAt (T-35, the Pi's one retry).
     */
    static revalidationWindow(prayerTime) {
        return {
            at: prayerTime.minus({ milliseconds: REVALIDATE_AT_MS }),
            freshSince: prayerTime.minus({ milliseconds: REVALIDATE_FRESH_MS }),
            end: prayerTime.minus({ milliseconds: REVALIDATE_WINDOW_END_MS }),
            retryAt: prayerTime.minus({ milliseconds: REVALIDATE_RETRY_AT_MS }),
        };
    }

    /**
     * Arms the pre-prayer revalidation for one prayer at exactly T-45. Armed
     * at or after T-45 but before T-30 (a boot, or a re-arm), it catches up
     * REVALIDATE_CATCH_UP_MS later, or halfway to T-30 when that is sooner:
     * the check is due any time before T-30. Not armed at all when today was
     * already fetched at or after T-50: the check would only find the times
     * fresh. That covers the re-arm after this prayer's own check moved it by
     * a minute or two. Returns the run time, or null.
     */
    _armRevalidation(today, prayer, prayerTime, now) {
        const w = CoreScheduler.revalidationWindow(prayerTime);
        const lastFetch = this._lastFetchedAt(today);
        if (lastFetch && lastFetch >= w.freshSince) return null;
        let runAt = w.at;
        if (runAt <= now) {
            const left = w.end.toMillis() - now.toMillis();
            if (left <= 0) return null;
            runAt = now.plus({ milliseconds: Math.max(1, Math.min(REVALIDATE_CATCH_UP_MS, Math.floor(left / 2))) });
        }
        const job = schedule.scheduleJob(runAt.toJSDate(), () => this.revalidateToday(`pre-${prayer}`, {
            prayerTime,
            retryAt: w.retryAt,
        }));
        if (!job) return null; // runAt slipped into the past while arming
        this._scheduledJobs.push(job);
        return runAt;
    }

    _lastFetchedAt(day) {
        try {
            return typeof this.scheduleStore.lastFetchedAt === 'function'
                ? this.scheduleStore.lastFetchedAt(day)
                : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Why a revalidation must not run (or apply) right now, or null; returns
     * { reason, noRetry } where noRetry means a retry cannot help: the
     * pre-prayer window closed, or a prayer's own pre-prayer check covers it.
     *
     * Never while a full reschedule or any cast is running, a window-retry is
     * pending, or a prayer is in its quiet period (ts <= now < ts + 10min).
     * Then the window: a pre-prayer check (prayerTime set) only before its
     * T-30, and only for the next upcoming prayer; any other check (the
     * morning one) not within [T-50, T) of any prayer: [T-50, T-30) is that
     * prayer's own sample, and nothing revalidates
     * from T-30 on. Together these keep every prayer either fully done
     * (preflight, push, audit) or not started, which is what lets a re-arm judge
     * "fired".
     */
    _revalidationBlocker(now, { prayerTime = null } = {}) {
        if (this._schedulingToday) return { reason: 'a full reschedule is running' };
        if (this.activeRuns.size > 0) return { reason: `a cast is in progress (${[...this.activeRuns].join(', ')})` };
        if (this._pendingRetries && this._pendingRetries.size > 0) {
            return { reason: `a window-retry is pending (${[...this._pendingRetries.keys()].join(', ')})` };
        }
        if (!this._armed || this._armed.date !== now.toISODate()) return { reason: "today's schedule is not armed" };
        const armedPrayers = PRAYERS
            .filter((prayer) => this._armed.times[prayer])
            .map((prayer) => ({ prayer, t: this._armed.times[prayer], ts: CoreScheduler.at(now, this._armed.times[prayer]) }));
        for (const { prayer, t, ts } of armedPrayers) {
            if (now >= ts && now < ts.plus({ milliseconds: REVALIDATE_QUIET_AFTER_MS })) {
                return { reason: `${prayer} (${t}) was less than ${REVALIDATE_QUIET_AFTER_MS / 60000} min ago` };
            }
        }
        if (prayerTime) {
            const { end } = CoreScheduler.revalidationWindow(prayerTime);
            if (now >= end) return { reason: `the pre-prayer window closed at ${end.toFormat('h:mm a')}`, noRetry: true };
            // Only the next upcoming prayer is sampled (as in adhan-ce): with prayers
            // under 45 min apart, a later prayer's T-45 can come before an earlier one.
            const earlier = armedPrayers.find(({ ts }) => ts >= now && ts < prayerTime);
            if (earlier) return { reason: `${earlier.prayer} (${earlier.t}) comes first`, noRetry: true };
            return null;
        }
        for (const { prayer, t, ts } of armedPrayers) {
            const w = CoreScheduler.revalidationWindow(ts);
            if (now >= w.freshSince && now < w.end) {
                return { reason: `${prayer} (${t}) is sampled by its own pre-prayer check`, noRetry: true };
            }
            if (now >= w.end && now < ts) {
                return { reason: `${prayer} (${t}) is less than ${REVALIDATE_WINDOW_END_MS / 60000} min away`, noRetry: true };
            }
        }
        return null;
    }

    /**
     * Re-fetches today's timings and, when Aladhan's answer moved, re-arms every
     * job for the new times (the freshest answer wins, as in adhan-ce). Unchanged
     * times only record the fetch; a failed or malformed fetch keeps the current
     * times. As in adhan-ce, an answer that would move a prayer across "now" is
     * rejected whole. A fetched answer is stored only once accepted, so a
     * rejected or unapplied one never reaches the cache a restart arms from.
     *
     * prayerTime: set for a pre-prayer check (the prayer's DateTime). It runs
     *   only before T-30 and skips the fetch (still applying any cached change)
     *   when today was already fetched at or after T-50. Without it (the morning
     *   check) it never runs within [T-50, T) of any prayer.
     * retryAt: when skipped or failed, try once more at this DateTime (not when
     *   a prayer's own pre-prayer check covers the skip).
     *
     * onScheduleChanged is queued once the lock is released, never awaited.
     * Resolves { changed, changes?, skipped?, failed? }. Never throws.
     */
    async revalidateToday(reason = 'manual', { prayerTime = null, retryAt = null } = {}) {
        try {
            let result;
            if (this._revalidating) {
                this.log(`🔄 Revalidation (${reason}) skipped: another revalidation is running.`);
                result = { changed: false, skipped: 'another revalidation is running' };
            } else {
                this._revalidating = true;
                try {
                    result = await this._revalidateToday(reason, prayerTime);
                } finally {
                    this._revalidating = false;
                }
            }
            const { notify, noRetry, ...publicResult } = result;
            if (notify) this._queueScheduleChanged(reason, notify);
            if (retryAt && !noRetry && !result.changed && (result.skipped || result.failed)) {
                this._armRevalidationRetry(reason, prayerTime, retryAt);
            }
            return publicResult;
        } catch (e) {
            this.log(`⚠️ Revalidation (${reason}) failed: ${e.message}; keeping the current times.`);
            return { changed: false, failed: true };
        }
    }

    /** Runs onScheduleChanged after the ones already queued; errors are logged, never thrown. */
    _queueScheduleChanged(reason, change) {
        const hook = this.onScheduleChanged;
        if (typeof hook !== 'function') return;
        this._scheduleChangedQueue = (this._scheduleChangedQueue || Promise.resolve())
            .then(() => hook(change))
            .catch((e) => this.log(`⚠️ Revalidation (${reason}): schedule-change hook failed: ${e && e.message}`));
    }

    _armRevalidationRetry(reason, prayerTime, retryAt) {
        if (retryAt <= DateTime.now().setZone(this.config.timezone)) return;
        this.log(`🔄 Revalidation (${reason}) will retry at ${retryAt.toFormat('h:mm:ss a')}.`);
        this._scheduledJobs.push(
            schedule.scheduleJob(retryAt.toJSDate(), () => this.revalidateToday(`${reason} retry`, { prayerTime })),
        );
    }

    async _revalidateToday(reason, prayerTime) {
        const log = this.log;
        const tz = this.config.timezone;
        const label = `Revalidation (${reason})`;
        const now = DateTime.now().setZone(tz);
        const blocker = this._revalidationBlocker(now, { prayerTime });
        if (blocker) {
            log(`🔄 ${label} skipped: ${blocker.reason}.`);
            return { changed: false, skipped: blocker.reason, noRetry: !!blocker.noRetry };
        }

        const armed = this._armed;
        const freshSince = prayerTime ? CoreScheduler.revalidationWindow(prayerTime).freshSince : null;
        const lastFetch = this._lastFetchedAt(now);
        let fetched = null;
        if (freshSince && lastFetch && lastFetch >= freshSince) {
            log(`🔄 ${label}: today's times were fetched at ${lastFetch.toFormat('HH:mm')}, already fresh for this prayer; not re-fetching.`);
        } else {
            log(`🔄 ${label}: re-fetching today's prayer times...`);
            try {
                fetched = await this.scheduleStore.fetchEntry(now);
            } catch (e) {
                log(`⚠️ ${label}: fetch failed (${e.message}); keeping the current times.`);
                return { changed: false, failed: true };
            }
        }

        // The fetch awaited the network: re-check that nothing started meanwhile.
        // Nothing was stored yet, so the next check fetches again.
        if (this._armed !== armed) {
            log(`🔄 ${label}: today was rescheduled meanwhile; nothing to apply.`);
            return { changed: false, skipped: 'rescheduled meanwhile' };
        }
        const applyAt = DateTime.now().setZone(tz);
        const lateBlocker = this._revalidationBlocker(applyAt, { prayerTime });
        if (lateBlocker) {
            log(`🔄 ${label}: not applying now (${lateBlocker.reason}).`);
            return { changed: false, skipped: lateBlocker.reason, noRetry: !!lateBlocker.noRetry };
        }

        // Without a fetch, the cache is compared: it can only differ from the
        // armed times if something outside this process rewrote it.
        const entry = fetched || this.scheduleStore.getEntry(applyAt);
        const fresh = entry ? CoreScheduler.extractTimes(entry) : {};
        if (!entry || PRAYERS.some((p) => !fresh[p])) {
            log(`⚠️ ${label}: no usable entry for today; keeping the current times.`);
            return { changed: false, failed: true };
        }

        // The five prayers and Sunrise (optional in an answer: missing on one
        // side only is a change; it never counts as crossing now).
        const changes = {};
        for (const key of [...PRAYERS, 'Sunrise']) {
            if (fresh[key] !== armed.times[key]) changes[key] = { from: armed.times[key] || null, to: fresh[key] || null };
        }
        const changed = Object.keys(changes).length > 0;
        if (changed) {
            const crossing = CoreScheduler.revalidationCrossesNow(armed.times, fresh, applyAt);
            if (crossing.length > 0) {
                log(`⚠️ ${label}: Aladhan's answer would move ${crossing.map((p) => `${p} ${armed.times[p] || '--'} -> ${fresh[p]}`).join(', ')} across now; keeping the current times.`);
                return { changed: false, failed: true };
            }
        }
        if (fetched && !this.scheduleStore.commitEntry(applyAt, fetched, now)) {
            log(`⚠️ ${label}: could not store the fetched times; keeping the current times.`);
            return { changed: false, failed: true };
        }
        if (!changed) {
            log(`✅ ${label}: prayer times unchanged.`);
            return { changed: false };
        }
        for (const [key, { from, to }] of Object.entries(changes)) {
            const large = from && to
                && Math.abs(CoreScheduler.at(applyAt, to).toMillis() - CoreScheduler.at(applyAt, from).toMillis()) > LARGE_CHANGE_MS;
            log(`🔁 ${label}: ${key} ${from || '--'} -> ${to || '--'}${large ? ' (unusually large change)' : ''}`);
        }

        // Safe to cancel everything: the blocker guarantees no cast, audit
        // follow-up or window-retry is pending, so every job is re-created below.
        this._cancelScheduledJobs();
        this._armToday(applyAt, entry, { previous: armed.times, now: applyAt });
        return {
            changed: true,
            changes,
            notify: { date: applyAt.toISODate(), reason, changes, times: fresh },
        };
    }

    /**
     * Arms the daily morning re-check of today's times at `raw`
     * (PRAYER_MORNING_REFRESH: 24h 'HH:MM' in the prayer timezone; anything else
     * falls back to 08:00). It lives outside _scheduledJobs, so scheduleToday
     * never cancels it; calling this again replaces it. It skips (logging why)
     * within [T-50, T) of any prayer, whose own T-45 sample covers it, and in a
     * prayer's quiet period. Any other skipped or failed run retries once
     * MORNING_REVALIDATION_RETRY_MS later. Returns the job.
     */
    armMorningRevalidation(raw) {
        const tz = this.config.timezone;
        let at = CoreScheduler.parseClockTime(raw || '08:00');
        if (!at) {
            this.log(`⚠️ PRAYER_MORNING_REFRESH="${raw}" is not HH:MM; using 08:00.`);
            at = MORNING_REVALIDATION_DEFAULT;
        }
        const rule = new schedule.RecurrenceRule();
        rule.hour = at.hour;
        rule.minute = at.minute;
        rule.tz = tz;
        if (this._morningRevalidationJob) this._morningRevalidationJob.cancel();
        this._morningRevalidationJob = schedule.scheduleJob(rule, () => this.revalidateToday('morning', {
            retryAt: DateTime.now().setZone(tz).plus({ milliseconds: MORNING_REVALIDATION_RETRY_MS }),
        }));
        this.log(`🌅 Morning prayer-time re-check scheduled daily at ${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}.`);
        return this._morningRevalidationJob;
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
     * exactly like the prayer jobs. On a re-arm after a revalidation,
     * previousSunrise is the 'HH:mm' the cancelled jobs used: a clip whose old
     * cast time has passed already played and is not armed again, and one whose
     * old time is still ahead but whose new time has passed casts right away
     * instead of being dropped.
     */
    _scheduleMorningScene(today, todayEntry, log, sceneKey, { now = DateTime.now().setZone(this.config.timezone), previousSunrise = null } = {}) {
        const cfg = (this.config && this.config[sceneKey]) || {};
        const meta = CoreScheduler.MORNING_SCENES[sceneKey];
        if (!cfg.enabled) return;

        const raw = todayEntry && todayEntry.timings && todayEntry.timings.Sunrise;
        if (!raw) return log(`   - ${meta.label}: no sunrise timing in schedule, skipped.`);

        const [hours, minutes] = String(raw).split(' ')[0].split(':').map(Number);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
            return log(`   - ${meta.label}: unparseable timing "${raw}", skipped.`);
        }

        const offset = { seconds: cfg.offsetSec || 0 };
        let castTime = today
            .set({ hour: hours, minute: minutes, second: 0, millisecond: 0 })
            .plus(offset);
        if (previousSunrise) {
            const oldCastTime = CoreScheduler.at(today, previousSunrise).plus(offset);
            if (oldCastTime <= now) return; // Played at the old sunrise time; never cast twice.
            if (castTime < now) {
                log(`   - ${meta.label}: moved to ${castTime.toFormat('h:mm:ss a')} before it played; casting it now.`);
                castTime = now.plus({ seconds: 2 });
            }
        }
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
                                    } catch { completeFinalize(); }
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
                    } catch { setTimeout(finalize, 500); }
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
