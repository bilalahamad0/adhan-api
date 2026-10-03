const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { DateTime } = require('luxon');

const ALADHAN_API = 'https://api.aladhan.com/v1';
const REQUIRED_TIMINGS = ['Fajr', 'Sunrise', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

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
 * The year calendar (same parameters) only covers days the daily request has not
 * reached, and Aladhan outages. The file lives in the data dir, outside the repo,
 * so a deploy's `git reset --hard` can never restore an old copy.
 *
 * Cache shape: { year, source, fetchedOn: { [entryDay]: fetchDay }, data: { [month]: [entry] } }
 */
class PrayerScheduleStore {
  static resolvePath(env = process.env) {
    const dataDir =
      env.PLAYBACK_DATA_DIR || path.join(env.HOME || path.join(__dirname, '..'), '.adhan-data');
    return path.join(dataDir, 'annual_schedule.json');
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
        cache = { year, source, fetchedOn: {}, data: await this._fetchCalendar(year) };
        changed = true;
      } catch (e) {
        this.log(`⚠️ Aladhan calendar fetch failed for ${year}: ${e.message}`);
        // Keep this year's data; the old source stays recorded so the next refresh retries.
        cache =
          cache && cache.year === year
            ? { ...cache, fetchedOn: {} }
            : { year, source: null, fetchedOn: {}, data: {} };
      }
    }

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
        changed = true;
      } catch (e) {
        this.log(`⚠️ Aladhan fetch failed for ${day.toISODate()} (${e.message}); keeping the cached entry.`);
      }
    }

    if (!changed) return;
    for (const key of Object.keys(cache.fetchedOn)) {
      if (key < today) delete cache.fetchedOn[key];
    }
    try {
      this._write(cache);
    } catch (e) {
      this.log(`⚠️ Could not write ${this.filePath}: ${e.message}`);
    }
  }

  async _fetchDay(day) {
    const url = PrayerScheduleStore.timingsUrl(this.location, day);
    this.log(`📡 Aladhan: ${url}`);
    const res = await this.http.get(url, { timeout: 10000 });
    const entry = res?.data?.data;
    this._validate(entry);
    if (entry.date?.gregorian?.date !== day.toFormat('dd-MM-yyyy')) {
      throw new Error(`response is for ${entry.date?.gregorian?.date}`);
    }
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
      days.forEach((entry) => this._validate(entry));
    }
    return data;
  }

  _validate(entry) {
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
