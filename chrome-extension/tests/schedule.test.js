import {
  ymd,
  parseTimeToday,
  buildPrayers,
  computeNext,
  formatCountdown,
  PRAYER_ORDER,
  DAY_MS,
} from '../lib/schedule.js';

const ALL = { Fajr: '04:27 AM', Dhuhr: '01:05 PM', Asr: '04:56 PM', Maghrib: '08:17 PM', Isha: '09:43 PM' };
const BASE = new Date(2026, 4, 23); // 2026-05-23, local

describe('ymd', () => {
  it('formats local date as zero-padded YYYY-MM-DD', () => {
    expect(ymd(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(ymd(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('parseTimeToday', () => {
  it('parses AM and PM', () => {
    expect(new Date(parseTimeToday('05:00 AM', BASE)).getHours()).toBe(5);
    expect(new Date(parseTimeToday('06:30 PM', BASE)).getHours()).toBe(18);
    expect(new Date(parseTimeToday('06:30 PM', BASE)).getMinutes()).toBe(30);
  });
  it('treats 12 AM as midnight and 12 PM as noon', () => {
    expect(new Date(parseTimeToday('12:00 AM', BASE)).getHours()).toBe(0);
    expect(new Date(parseTimeToday('12:00 PM', BASE)).getHours()).toBe(12);
  });
  it('is case-insensitive and tolerant of spacing', () => {
    expect(new Date(parseTimeToday('7:05 pm', BASE)).getHours()).toBe(19);
  });
  it('anchors to the base date', () => {
    const d = new Date(parseTimeToday('01:05 PM', BASE));
    expect(ymd(d)).toBe('2026-05-23');
  });
  it('returns null for malformed input', () => {
    expect(parseTimeToday('not a time', BASE)).toBeNull();
    expect(parseTimeToday('13:00', BASE)).toBeNull(); // missing AM/PM
    expect(parseTimeToday('', BASE)).toBeNull();
  });
});

describe('buildPrayers', () => {
  it('builds ordered, timestamped entries', () => {
    const p = buildPrayers(ALL, BASE);
    expect(p.map((x) => x.name)).toEqual(PRAYER_ORDER);
    expect(p[0].ts).toBeLessThan(p[4].ts);
    expect(p[0].time).toBe('04:27 AM');
  });
  it('skips missing prayers and tolerates empty input', () => {
    expect(buildPrayers({ Fajr: '04:27 AM' }, BASE).map((x) => x.name)).toEqual(['Fajr']);
    expect(buildPrayers(undefined, BASE)).toEqual([]);
    expect(buildPrayers({}, BASE)).toEqual([]);
  });
});

describe('computeNext', () => {
  const prayers = buildPrayers(ALL, BASE);
  it('returns the first prayer strictly after the reference time', () => {
    const noon = new Date(2026, 4, 23, 12, 0).getTime();
    expect(computeNext(prayers, noon).name).toBe('Dhuhr');
    const earlyMorning = new Date(2026, 4, 23, 1, 0).getTime();
    expect(computeNext(prayers, earlyMorning).name).toBe('Fajr');
  });
  it('rolls over to tomorrow Fajr after the last prayer', () => {
    const lateNight = new Date(2026, 4, 23, 23, 0).getTime();
    const next = computeNext(prayers, lateNight);
    expect(next.name).toBe('Fajr');
    expect(next.ts).toBe(prayers[0].ts + DAY_MS);
  });
  it('returns null for an empty schedule', () => {
    expect(computeNext([], Date.now())).toBeNull();
  });
});

describe('default base date', () => {
  it('falls back to "now" when base is omitted', () => {
    expect(typeof ymd()).toBe('string');
    expect(parseTimeToday('12:00 PM')).toEqual(expect.any(Number));
    expect(buildPrayers(ALL).length).toBe(5);
  });
});

describe('formatCountdown', () => {
  it('formats h/m/s buckets', () => {
    expect(formatCountdown(3 * 3600e3 + 12 * 60e3)).toBe('3h 12m');
    expect(formatCountdown(5 * 60e3 + 30e3)).toBe('5m 30s');
    expect(formatCountdown(45e3)).toBe('45s');
  });
  it('clamps negatives to 0s', () => {
    expect(formatCountdown(-5000)).toBe('0s');
  });
});
