const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { DateTime } = require('luxon');

const ALADHAN_API = 'https://api.aladhan.com/v1';
// Year calendar entries: every one must carry these (unchanged since the calendar
// became the fallback; see _validateCalendarEntry).
const REQUIRED_TIMINGS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
// The daily answer (shared rule v2 with adhan-ce): the five prayers are required,
// Sunrise is optional (validated the same way when present).
const DAILY_PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
// Strict 24h 'H:MM' / 'HH:MM', optionally followed by Aladhan's ' (ZONE)' label
// ('05:53', '05:53 (PDT)'), and nothing else.
const TIMING_RE = /^(\d{1,2}):(\d{2})(?: \([^()]+\))?$/;

/**
 * Owns the prayer-time cache (annual_schedule.json) that every service reads.
 *
 * Sync contract with the Adhan Focus extension (adhan-ce): each day's times come
 * from the exact request the extension makes — same endpoint, parameters, order
 * and encoding as its background.js fetchAndStoreSchedule() — fetched on that day.
 * Aladhan geocodes the city string server-side and the point it picks is not
 * stable over time (its geocoder changed on 2026-08-20), so a months-old snapshot
 * drifts a minute from the live answer on some days; a same-day identical request
 * does not.
 *
 * The answer for the same URL can also move during a day (2026-10-03: Asr 16:17
 * in the morning, 16:16 at 12:38), so a once-a-day fetch is not enough: both apps
 * re-fetch today's entry before each prayer (see CoreScheduler.revalidateToday).
 * That goes through fetchEntry() + commitEntry(), so an answer the scheduler
 * rejects never reaches this file, which is what a restart arms from.
 *
 * The year calendar (same parameters) only covers days the daily request has not
 * reached, and Aladhan outages. The file lives in the data dir, outside the repo,
 * so a deploy's `git reset --hard` can never restore an old copy.
 *
 * Cache shape: { year, source, fetchedOn: { [entryDay]: fetchDay },
 *   fetchedAt: { [entryDay]: ISO timestamp of the last successful fetch }, data: { [month]: [entry] } }
 */
class PrayerScheduleStore {
  static resolvePath(env = process.env) {
    const dataDir =
      env.PLAYBACK_DATA_DIR || path.join(env.HOME || path.join(__dirname, '..'), '.adhan-data');
    return path.join(dataDir, 'annual_schedule.json');
  }

  /** 'HH:mm' from a strict Aladhan timing ('5:53', '05:53', '05:53 (PDT)'), or null. */
  static parseTiming(raw) {
    const m = typeof raw === 'string' ? raw.match(TIMING_RE) : null;
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${m[2]}`;
  }

  /** Query string, byte-identical to adhan-ce's timingsByCity request. */
  static query({ city, country, state, method, school }) {
    let q = `city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=${method}&school=${school}`;
    if (state) q += `&state=${encodeURIComponent(state)}`;
    return q;
  }

  static timingsUrl(location, day) {
    return `${ALADHAN_API}/timingsByCity/${day.toFormat('dd-MM-yyyy')}?${PrayerScheduleStore.query(location)}`;
  }

  static calendarUrl(location, year) {
    return `${ALADHAN_API}/calendarByCity/${year}?${PrayerScheduleStore.query(location)}`;
  }

  constructor({ location, timezone, filePath, http = axios, log = console.log } = {}) {
    this.location = location;
    this.timezone = timezone;
    this.filePath = filePath || PrayerScheduleStore.resolvePath();
    this.http = http;
    this.log = log;
  }

  /** The cached entry for exactly this date (never last year's same day), or null. */
  getEntry(day) {
    const monthData = this._read()?.data?.[day.month.toString()];
    if (!Array.isArray(monthData)) return null;
    const date = day.toFormat('dd-MM-yyyy');
    return monthData.find((d) => d?.date?.gregorian?.date === date) || null;
  }

  /** When `day`'s entry was last fetched from Aladhan, or null (calendar-only / never). */
  lastFetchedAt(day) {
    const iso = this._read()?.fetchedAt?.[day.toISODate()];
    if (!iso) return null;
    const at = DateTime.fromISO(iso, { zone: this.timezone });
    return at.isValid ? at : null;
  }

  /**
   * Bring the cache up to date for `now`: the year calendar when missing or when
   * the location changed, today's entry once per day, and tomorrow's entry
   * provisionally (for the dashboard's next-day row). Never throws; on failure
   * the last good data stays in place.
   */
  async refresh(now = DateTime.now().setZone(this.timezone)) {
    const source = PrayerScheduleStore.query(this.location);
    const year = now.toFormat('yyyy');
    let cache = this._read();
    let changed = false;

    if (!cache || cache.year !== year || cache.source !== source) {
      try {
        cache = { year, source, fetchedOn: {}, fetchedAt: {}, data: await this._fetchCalendar(year) };
        changed = true;
      } catch (e) {
        this.log(`⚠️ Aladhan calendar fetch failed for ${year}: ${e.message}`);
        // Keep this year's data; the old source stays recorded so the next refresh retries.
        cache =
          cache && cache.year === year
            ? { ...cache, fetchedOn: {}, fetchedAt: {} }
            : { year, source: null, fetchedOn: {}, fetchedAt: {}, data: {} };
      }
    }
    if (!cache.fetchedAt) cache.fetchedAt = {}; // caches written before fetchedAt existed

    const today = now.toISODate();
    const tomorrow = now.plus({ days: 1 });
    // Today's entry is final once fetched today; tomorrow's (fetched a day early) is provisional.
    const due = [[now, cache.fetchedOn[today] !== today]];
    if (tomorrow.year === now.year) due.push([tomorrow, !cache.fetchedOn[tomorrow.toISODate()]]);
    for (const [day, needed] of due) {
      if (!needed) continue;
      try {
        this._putEntry(cache, day, await this._fetchDay(day));
        cache.fetchedOn[day.toISODate()] = today;
        cache.fetchedAt[day.toISODate()] = now.toISO();
        changed = true;
      } catch (e) {
        this.log(`⚠️ Aladhan fetch failed for ${day.toISODate()} (${e.message}); keeping the cached entry.`);
      }
    }

    if (!changed) return;
    for (const map of [cache.fetchedOn, cache.fetchedAt]) {
      for (const key of Object.keys(map)) {
        if (key < today) delete map[key];
      }
    }
    try {
      this._write(cache);
    } catch (e) {
      this.log(`⚠️ Could not write ${this.filePath}: ${e.message}`);
    }
  }

  /**
   * First half of a revalidation: `day`'s entry from the daily request,
   * validated (see _validateDayEntry) but NOT stored. Throws on any failure or
   * malformed answer. The caller stores it with commitEntry() only once it has
   * accepted the answer.
   */
  async fetchEntry(day) {
    return this._fetchDay(day);
  }

  /**
   * Second half: stores `entry` (from fetchEntry) as `day`'s answer, fetched at
   * `fetchedAt`. Returns false, leaving the file untouched, when there is no
   * cache for `day`'s year (scheduleToday's refresh() builds it) or the write fails.
   */
  commitEntry(day, entry, fetchedAt = DateTime.now().setZone(this.timezone)) {
    const cache = this._read();
    if (!cache || cache.year !== day.toFormat('yyyy') || !cache.data || typeof cache.data !== 'object') {
      this.log(`⚠️ No ${day.toFormat('yyyy')} cache in ${this.filePath}; not storing ${day.toISODate()}.`);
      return false;
    }
    if (!cache.fetchedOn) cache.fetchedOn = {};
    if (!cache.fetchedAt) cache.fetchedAt = {};
    this._putEntry(cache, day, entry);
    cache.fetchedOn[day.toISODate()] = fetchedAt.toISODate();
    cache.fetchedAt[day.toISODate()] = fetchedAt.toISO();
    try {
      this._write(cache);
      return true;
    } catch (e) {
      this.log(`⚠️ Could not write ${this.filePath}: ${e.message}`);
      return false;
    }
  }

  /**
   * `day`'s entry from the daily timingsByCity request (the day-start fetch and
   * every revalidation), 10 s timeout. Throws unless the answer is well formed
   * (see _validateDayEntry).
   */
  async _fetchDay(day) {
    const url = PrayerScheduleStore.timingsUrl(this.location, day);
    this.log(`📡 Aladhan: ${url}`);
    const res = await this.http.get(url, { timeout: 10000 });
    const entry = res?.data?.data;
    this._validateDayEntry(entry, day);
    return entry;
  }

  async _fetchCalendar(year) {
    const url = PrayerScheduleStore.calendarUrl(this.location, year);
    this.log(`📡 Aladhan: ${url}`);
    const res = await this.http.get(url, { timeout: 20000 });
    const data = res?.data?.data;
    for (let m = 1; m <= 12; m++) {
      const days = data?.[m.toString()];
      if (!Array.isArray(days) || days.length < 28) throw new Error(`month ${m} missing`);
      days.forEach((entry) => this._validateCalendarEntry(entry));
    }
    return data;
  }

  /**
   * The daily answer is accepted only when (shared rule v2 with adhan-ce) the
   * five prayers each parse with parseTiming, Sunrise is absent or parses the
   * same way, meta.timezone is the configured timezone and it is for `day`.
   * Anything else is malformed and throws, so the caller keeps the old times.
   */
  _validateDayEntry(entry, day) {
    const timings = entry?.timings;
    if (!timings || typeof timings !== 'object') throw new Error('no timings');
    for (const p of DAILY_PRAYERS) {
      if (!PrayerScheduleStore.parseTiming(timings[p])) throw new Error(`bad ${p} timing`);
    }
    if (timings.Sunrise != null && !PrayerScheduleStore.parseTiming(timings.Sunrise)) {
      throw new Error('bad Sunrise timing');
    }
    if (entry.meta?.timezone !== this.timezone) {
      throw new Error(`timezone ${entry.meta?.timezone}, expected ${this.timezone}`);
    }
    if (entry.date?.gregorian?.date !== day.toFormat('dd-MM-yyyy')) {
      throw new Error(`response is for ${entry.date?.gregorian?.date}`);
    }
  }

  /** A year-calendar entry: all six timings start with H:MM, in the configured timezone. */
  _validateCalendarEntry(entry) {
    for (const p of REQUIRED_TIMINGS) {
      if (!/^\d{1,2}:\d{2}/.test(String(entry?.timings?.[p]))) throw new Error(`bad ${p} timing`);
    }
    if (entry.meta?.timezone !== this.timezone) {
      throw new Error(`timezone ${entry.meta?.timezone}, expected ${this.timezone}`);
    }
  }

  _putEntry(cache, day, entry) {
    const month = day.month.toString();
    const days = Array.isArray(cache.data[month]) ? cache.data[month] : (cache.data[month] = []);
    const i = days.findIndex((d) => parseInt(d?.date?.gregorian?.day, 10) === day.day);
    if (i >= 0) days[i] = entry;
    else days.push(entry);
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  _write(cache) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = PrayerScheduleStore;
