const schedule = require('node-schedule');
const { DateTime } = require('luxon');
const CoreScheduler = require('../services/CoreScheduler');

const TZ = 'America/Los_Angeles';

// A timingsByCity entry: 24h HH:mm with no "(PDT)" suffix, unlike calendarByCity.
const todayEntry = {
  timings: { Fajr: '05:53', Sunrise: '07:05', Dhuhr: '12:57', Asr: '16:17', Maghrib: '18:50', Isha: '20:01' },
  date: { readable: '02 Oct 2026', gregorian: { date: '02-10-2026', day: '02' } },
};

function makeScheduler(store) {
  const config = {
    timezone: TZ,
    location: { city: 'Sunnyvale' },
    audio: { fajrCurrent: 'fajr', regularCurrent: 'generic_3' },
  };
  const s = new CoreScheduler(config, null, null, null, '/nonexistent/annual_schedule.json');
  s.scheduleStore = store;
  s.log = () => {};
  s._restorePendingRetries = () => {};
  return s;
}

describe('CoreScheduler.scheduleToday', () => {
  let scheduler;

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-10-02T15:00:00Z'), doNotFake: ['nextTick'] }); // 08:00 PDT
  });
  afterEach(() => {
    scheduler._scheduledJobs.forEach((job) => job.cancel());
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('schedules from the refreshed store entry', async () => {
    const store = { refresh: jest.fn(async () => {}), getEntry: jest.fn(() => todayEntry) };
    scheduler = makeScheduler(store);
    const spy = jest.spyOn(schedule, 'scheduleJob');

    await expect(scheduler.scheduleToday()).resolves.toBe(true);

    expect(store.refresh).toHaveBeenCalledTimes(1);
    const times = spy.mock.calls.map(([when]) => DateTime.fromJSDate(when).setZone(TZ).toFormat('HH:mm:ss'));
    expect(times).toEqual(expect.arrayContaining(['18:45:00', '18:50:00', '18:50:30']));
    expect(times).not.toContain('05:48:00'); // Fajr already passed
  });

  test('reports false and schedules nothing when no schedule is available', async () => {
    const store = { refresh: jest.fn(async () => {}), getEntry: jest.fn(() => null) };
    scheduler = makeScheduler(store);
    const spy = jest.spyOn(schedule, 'scheduleJob');

    await expect(scheduler.scheduleToday()).resolves.toBe(false);

    expect(spy).not.toHaveBeenCalled();
    expect(scheduler._scheduledJobs).toHaveLength(0);
  });
});
