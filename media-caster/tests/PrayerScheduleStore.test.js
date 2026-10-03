const fs = require('fs');
const os = require('os');
const path = require('path');
const { DateTime } = require('luxon');
const PrayerScheduleStore = require('../services/PrayerScheduleStore');

const TZ = 'America/Los_Angeles';
const LOCATION = { city: 'Sunnyvale', state: 'California', country: 'United States', method: 2, school: 0 };

// What adhan-ce's background.js fetchAndStoreSchedule() requests for its default
// location on 2026-10-02. adhan-api must send exactly this so both show the same times.
const ADHAN_CE_URL =
  'https://api.aladhan.com/v1/timingsByCity/02-10-2026?city=Sunnyvale&country=United%20States&method=2&school=0&state=California';

const at = (iso) => DateTime.fromISO(iso, { zone: TZ });

function entry(day, maghrib, { suffix = ' (PDT)', timezone = TZ } = {}) {
  const t = (v) => `${v}${suffix}`;
  return {
    timings: {
      Fajr: t('05:53'), Sunrise: t('07:05'), Dhuhr: t('12:57'), Asr: t('16:17'),
      Sunset: t(maghrib), Maghrib: t(maghrib), Isha: t('20:01'),
    },
    date: {
      readable: day.toFormat('dd LLL yyyy'),
      gregorian: { date: day.toFormat('dd-MM-yyyy'), day: day.toFormat('dd') },
      hijri: { day: '20', month: { en: 'Rabīʿ al-thānī' }, year: '1448', holidays: [] },
    },
    meta: { timezone },
  };
}

function calendar(year, maghrib) {
  const data = {};
  for (let m = 1; m <= 12; m++) {
    const first = DateTime.fromObject({ year, month: m, day: 1 }, { zone: TZ });
    data[m] = Array.from({ length: first.daysInMonth }, (_, i) => entry(first.plus({ days: i }), maghrib));
  }
  return data;
}

// Fake Aladhan: calendar says 18:49 (an old geocode), the live daily call says 18:50.
function fakeHttp({ failCalendar = false, failDay = false, dayTimezone = TZ } = {}) {
  return {
    get: jest.fn(async (url) => {
      const cal = url.match(/\/calendarByCity\/(\d{4})\?/);
      if (cal) {
        if (failCalendar) throw new Error('503');
        return { data: { code: 200, data: calendar(Number(cal[1]), '18:49') } };
      }
      const day = url.match(/\/timingsByCity\/(\d{2}-\d{2}-\d{4})\?/);
      if (day) {
        if (failDay) throw new Error('503');
        const dt = DateTime.fromFormat(day[1], 'dd-MM-yyyy', { zone: TZ });
        return { data: { code: 200, data: entry(dt, '18:50', { suffix: '', timezone: dayTimezone }) } };
      }
      throw new Error(`unexpected url ${url}`);
    }),
  };
}

describe('PrayerScheduleStore', () => {
  let dir;
  let filePath;
  const make = (http, location = LOCATION) =>
    new PrayerScheduleStore({ location, timezone: TZ, filePath, http, log: () => {} });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-store-'));
    filePath = path.join(dir, 'data', 'annual_schedule.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('daily request is byte-identical to the adhan-ce extension request', () => {
    expect(PrayerScheduleStore.timingsUrl(LOCATION, at('2026-10-02'))).toBe(ADHAN_CE_URL);
    expect(PrayerScheduleStore.timingsUrl({ ...LOCATION, state: '' }, at('2026-10-02'))).toBe(
      'https://api.aladhan.com/v1/timingsByCity/02-10-2026?city=Sunnyvale&country=United%20States&method=2&school=0'
    );
    expect(PrayerScheduleStore.calendarUrl(LOCATION, '2026')).toBe(
      'https://api.aladhan.com/v1/calendarByCity/2026?city=Sunnyvale&country=United%20States&method=2&school=0&state=California'
    );
  });

  test('resolvePath puts the cache in the data dir, outside the repo', () => {
    expect(PrayerScheduleStore.resolvePath({ PLAYBACK_DATA_DIR: '/data' })).toBe('/data/annual_schedule.json');
    expect(PrayerScheduleStore.resolvePath({ HOME: '/home/pi' })).toBe(
      '/home/pi/.adhan-data/annual_schedule.json'
    );
  });

  test('cold start: year calendar plus live today/tomorrow; today wins over the calendar', async () => {
    const http = fakeHttp();
    const store = make(http);
    await store.refresh(at('2026-10-02T00:00:05'));

    expect(http.get).toHaveBeenCalledTimes(3);
    expect(http.get.mock.calls[1][0]).toBe(ADHAN_CE_URL);
    expect(store.getEntry(at('2026-10-02')).timings.Maghrib).toBe('18:50');
    expect(store.getEntry(at('2026-10-03')).timings.Maghrib).toBe('18:50');
    expect(store.getEntry(at('2026-10-04')).timings.Maghrib).toBe('18:49 (PDT)');

    const cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(cache.year).toBe('2026');
    expect(cache.source).toBe(ADHAN_CE_URL.split('?')[1]);
    expect(cache.fetchedOn).toEqual({ '2026-10-02': '2026-10-02', '2026-10-03': '2026-10-02' });
  });

  test('same day: restarts and deploys make no requests, so times never change mid-day', async () => {
    const http = fakeHttp();
    await make(http).refresh(at('2026-10-02T00:00:05'));
    http.get.mockClear();
    await make(http).refresh(at('2026-10-02T14:30:00'));
    expect(http.get).not.toHaveBeenCalled();
  });

  test('next day: re-fetches the provisional entry on its own day and adds the new tomorrow', async () => {
    const http = fakeHttp();
    const store = make(http);
    await store.refresh(at('2026-10-02T00:00:05'));
    http.get.mockClear();
    await store.refresh(at('2026-10-03T00:00:05'));

    expect(http.get.mock.calls.map((c) => c[0].match(/timingsByCity\/([\d-]+)/)[1])).toEqual([
      '03-10-2026',
      '04-10-2026',
    ]);
    const cache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(cache.fetchedOn).toEqual({ '2026-10-03': '2026-10-03', '2026-10-04': '2026-10-03' });
  });

  test('daily fetch failure keeps the calendar entry and retries on the next refresh', async () => {
    const store = make(fakeHttp({ failDay: true }));
    await expect(store.refresh(at('2026-10-02T00:00:05'))).resolves.toBeUndefined();
    expect(store.getEntry(at('2026-10-02')).timings.Maghrib).toBe('18:49 (PDT)');

    const http = fakeHttp();
    await make(http).refresh(at('2026-10-02T00:10:00'));
    expect(http.get).toHaveBeenCalledTimes(2); // today + tomorrow, calendar already cached
    expect(make(http).getEntry(at('2026-10-02')).timings.Maghrib).toBe('18:50');
  });

  test('calendar failure still caches today, and the calendar is retried next time', async () => {
    const store = make(fakeHttp({ failCalendar: true }));
    await store.refresh(at('2026-10-02T00:00:05'));
    expect(store.getEntry(at('2026-10-02')).timings.Maghrib).toBe('18:50');
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).source).toBeNull();

    const http = fakeHttp();
    await make(http).refresh(at('2026-10-02T00:10:00'));
    expect(http.get.mock.calls[0][0]).toContain('/calendarByCity/2026?');
  });

  test('writes nothing when Aladhan is unreachable on a cold start', async () => {
    const store = make(fakeHttp({ failCalendar: true, failDay: true }));
    await store.refresh(at('2026-10-02T00:00:05'));
    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.getEntry(at('2026-10-02'))).toBeNull();
  });

  test('rejects a response geocoded into another timezone', async () => {
    const store = make(fakeHttp({ dayTimezone: 'Asia/Karachi' }));
    await store.refresh(at('2026-10-02T00:00:05'));
    expect(store.getEntry(at('2026-10-02')).timings.Maghrib).toBe('18:49 (PDT)');
  });

  test('changing the location rebuilds the cache from the new request', async () => {
    await make(fakeHttp()).refresh(at('2026-10-02T00:00:05'));
    const http = fakeHttp();
    await make(http, { ...LOCATION, school: 1 }).refresh(at('2026-10-02T09:00:00'));
    expect(http.get).toHaveBeenCalledTimes(3);
    expect(http.get.mock.calls[0][0]).toContain('/calendarByCity/2026?');
    expect(http.get.mock.calls[1][0]).toContain('school=1');
  });

  test('Jan 1 with Aladhan down never serves last year\'s Jan 1 entry', async () => {
    await make(fakeHttp()).refresh(at('2026-12-31T00:00:05'));
    const store = make(fakeHttp({ failCalendar: true, failDay: true }));
    await store.refresh(at('2027-01-01T00:00:05'));
    expect(store.getEntry(at('2026-01-01'))).not.toBeNull();
    expect(store.getEntry(at('2027-01-01'))).toBeNull();
  });

  test('failure log lines never read as a smoke-test failure count', async () => {
    const lines = [];
    const store = new PrayerScheduleStore({
      location: LOCATION, timezone: TZ, filePath, http: fakeHttp({ failCalendar: true, failDay: true }),
      log: (m) => lines.push(m),
    });
    await store.refresh(at('2026-10-03T00:00:05'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toMatch(/\d+\s+failed/i);
  });

  test('year rollover: no cross-year tomorrow on Dec 31, new calendar on Jan 1', async () => {
    const http = fakeHttp();
    const store = make(http);
    await store.refresh(at('2026-12-31T00:00:05'));
    expect(http.get).toHaveBeenCalledTimes(2); // calendar + today only

    http.get.mockClear();
    await store.refresh(at('2027-01-01T00:00:05'));
    expect(http.get.mock.calls[0][0]).toContain('/calendarByCity/2027?');
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).year).toBe('2027');
    expect(store.getEntry(at('2027-01-01')).timings.Maghrib).toBe('18:50');
  });
});
