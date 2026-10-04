const fs = require('fs');
const os = require('os');
const path = require('path');
const schedule = require('node-schedule');
const { DateTime } = require('luxon');
const CoreScheduler = require('../services/CoreScheduler');
const PrayerScheduleStore = require('../services/PrayerScheduleStore');

const TZ = 'America/Los_Angeles';
const BASE = { Fajr: '05:53', Sunrise: '07:05', Dhuhr: '12:57', Asr: '16:17', Maghrib: '18:50', Isha: '20:01' };

const pdt = (hhmmss) => Date.parse(`2026-10-02T${hhmmss}-07:00`);
const at = (hhmm) => DateTime.fromISO(`2026-10-02T${hhmm}`, { zone: TZ });

const entryWith = (timings) => ({
  timings: { ...timings },
  date: { readable: '02 Oct 2026', gregorian: { date: '02-10-2026', day: '02' } },
});

// In-memory stand-in for PrayerScheduleStore. `answer` is what Aladhan returns on
// the next fetchEntry; null makes that fetch fail. commitEntry is what stores it.
function makeStore(timings = BASE) {
  const store = {
    current: entryWith(timings),
    fetchedAt: null,
    answer: null,
    refresh: jest.fn(async () => {}),
    fetchEntry: jest.fn(async () => {
      if (!store.answer) throw new Error('503');
      return entryWith(store.answer);
    }),
    commitEntry: jest.fn((day, entry, fetchedAt) => {
      store.current = entry;
      store.fetchedAt = fetchedAt;
      return true;
    }),
    getEntry: jest.fn(() => store.current),
    lastFetchedAt: jest.fn(() => store.fetchedAt),
  };
  return store;
}

function makeScheduler(store, options = {}, extraConfig = {}) {
  const config = {
    timezone: TZ,
    location: { city: 'Sunnyvale' },
    audio: { fajrCurrent: 'fajr', regularCurrent: 'generic_3' },
    ...extraConfig,
  };
  const s = new CoreScheduler(config, null, null, null, '/nonexistent/annual_schedule.json', null, null, options);
  s.scheduleStore = store;
  s.log = () => {};
  s._restorePendingRetries = () => {};
  return s;
}

const jobsOf = (spy) =>
  spy.mock.calls.map(([when, fn]) => ({ at: DateTime.fromJSDate(when).setZone(TZ).toFormat('HH:mm:ss'), fn }));
const timesOf = (spy) => jobsOf(spy).map((j) => j.at);
const jobAt = (spy, hhmmss) => jobsOf(spy).find((j) => j.at === hhmmss);

describe('CoreScheduler pre-prayer revalidation', () => {
  let scheduler;
  let spy;

  beforeEach(() => {
    jest.useFakeTimers({ now: pdt('08:00:00'), doNotFake: ['nextTick'] });
    spy = jest.spyOn(schedule, 'scheduleJob');
  });
  afterEach(() => {
    if (scheduler) scheduler._scheduledJobs.forEach((job) => job && job.cancel());
    scheduler = null;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('arms a revalidation at T-45 for each future prayer only', async () => {
    scheduler = makeScheduler(makeStore());
    const revalidate = jest.spyOn(scheduler, 'revalidateToday').mockResolvedValue({ changed: false });

    await scheduler.scheduleToday();

    const times = timesOf(spy);
    expect(times).toEqual(expect.arrayContaining(['12:12:00', '15:32:00', '18:05:00', '19:16:00']));
    expect(times).not.toContain('05:08:00'); // Fajr already passed

    await jobAt(spy, '15:32:00').fn();
    expect(revalidate).toHaveBeenCalledWith('pre-Asr', expect.any(Object));
    const { prayerTime, retryAt } = revalidate.mock.calls[0][1];
    expect(prayerTime.toFormat('HH:mm')).toBe('16:17');
    expect(retryAt.toFormat('HH:mm')).toBe('15:42'); // one retry at T-35
  });

  test('armed between T-45 and T-30, it runs shortly unless today was fetched at or after T-50', async () => {
    jest.setSystemTime(pdt('15:40:00')); // Asr 16:17: past T-45 (15:32), before T-30 (15:47)
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    expect(timesOf(spy)).toContain('15:40:30');

    const rearm = async (fetchedAt) => {
      scheduler._scheduledJobs.forEach((job) => job && job.cancel());
      spy.mockClear();
      store.fetchedAt = fetchedAt;
      await scheduler.scheduleToday();
      return timesOf(spy);
    };
    expect(await rearm(at('15:26:59'))).toContain('15:40:30'); // before T-50: stale
    expect(await rearm(at('15:27'))).not.toContain('15:40:30'); // at T-50: fresh

    jest.setSystemTime(pdt('15:47:00')); // at T-30: too late
    expect((await rearm(null)).sort()[0]).toBe('16:12:00'); // the earliest job is Asr's preflight
  });

  // The check is due any time before T-30 (rule v2, item 1), so a boot in the
  // last minute before T-30 still samples the prayer.
  test.each([
    ['15:45:30', '15:46:00'], // 30 s later
    ['15:46:10', '15:46:35'], // halfway to T-30 (15:47) is sooner than 30 s
    ['15:46:50', '15:46:55'],
    ['15:46:59', '15:46:59.500'],
  ])('booted at %s, under a minute before T-30, it still catches up before T-30 (at %s)', async (now, runAt) => {
    jest.setSystemTime(pdt(now));
    const store = makeStore();
    store.fetchedAt = at('00:00:05'); // the day-start fetch, long before Asr's T-50
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();

    const runs = spy.mock.calls
      .map(([when, fn]) => ({ at: DateTime.fromJSDate(when).setZone(TZ), fn }))
      .filter((j) => j.at > at(now) && j.at < at('15:47'));
    expect(runs.map((j) => j.at.toFormat('HH:mm:ss.SSS'))).toEqual([at(runAt).toFormat('HH:mm:ss.SSS')]);

    store.answer = { ...BASE };
    jest.setSystemTime(runs[0].at.toMillis());
    await expect(runs[0].fn()).resolves.toEqual({ changed: false });
    expect(store.fetchEntry).toHaveBeenCalledTimes(1);
    expect(store.fetchedAt.toMillis()).toBe(runs[0].at.toMillis());
  });

  test('a prayer already fetched for at or after its T-50 gets no T-45 job', async () => {
    jest.setSystemTime(pdt('15:30:00'));
    const store = makeStore();
    store.fetchedAt = at('15:29'); // e.g. the first boot of the day fetched just now
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    const times = timesOf(spy);
    expect(times).not.toContain('15:32:00'); // Asr's T-45
    expect(times).toEqual(expect.arrayContaining(['18:05:00', '19:16:00'])); // Maghrib, Isha
  });

  test('unchanged times: records the fetch only and keeps every job', async () => {
    const store = makeStore();
    const onScheduleChanged = jest.fn();
    scheduler = makeScheduler(store, { onScheduleChanged });
    await scheduler.scheduleToday();
    const jobs = [...scheduler._scheduledJobs];

    store.answer = { ...BASE };
    await expect(scheduler.revalidateToday('morning')).resolves.toEqual({ changed: false });

    expect(store.fetchEntry).toHaveBeenCalledTimes(1);
    expect(store.commitEntry).toHaveBeenCalledTimes(1); // the fetch time is recorded
    expect(store.fetchedAt.toISO()).toBe(at('08:00').toISO());
    expect(scheduler._scheduledJobs).toHaveLength(jobs.length);
    expect(scheduler._scheduledJobs.every((job, i) => job === jobs[i])).toBe(true);
    expect(jobs.every((job) => job.nextInvocation() !== null)).toBe(true);
    expect(onScheduleChanged).not.toHaveBeenCalled();
  });

  test('the calendar suffix alone is not a change', async () => {
    const store = makeStore({ ...BASE, Asr: '16:17 (PDT)' });
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    store.answer = { ...BASE };
    await expect(scheduler.revalidateToday('morning')).resolves.toEqual({ changed: false });
  });

  test('changed Asr re-arms at the new time and never re-arms a passed prayer', async () => {
    jest.setSystemTime(pdt('14:00:00'));
    const store = makeStore();
    const onScheduleChanged = jest.fn(async () => {});
    scheduler = makeScheduler(store, { onScheduleChanged });
    await scheduler.scheduleToday();
    const oldJobs = [...scheduler._scheduledJobs];
    spy.mockClear();

    store.answer = { ...BASE, Asr: '16:16' };
    const result = await scheduler.revalidateToday('morning');

    expect(result).toEqual({ changed: true, changes: { Asr: { from: '16:17', to: '16:16' } } });
    expect(oldJobs.every((job) => job.nextInvocation() === null)).toBe(true);
    const times = timesOf(spy);
    expect(times).toEqual(expect.arrayContaining(['16:11:00', '16:16:00', '16:16:30', '15:31:00']));
    expect(times).not.toContain('16:12:00');
    expect(times).not.toContain('16:17:00');
    // Fajr and Dhuhr already fired: nothing re-armed for them.
    for (const t of ['05:48:00', '05:53:00', '12:52:00', '12:57:00', '12:57:30']) expect(times).not.toContain(t);
    // Maghrib and Isha are re-armed unchanged.
    expect(times).toEqual(expect.arrayContaining(['18:45:00', '19:56:00']));

    const cast = jest.spyOn(scheduler, 'executePreFlightAndCast').mockResolvedValue();
    jobAt(spy, '16:11:00').fn();
    expect(cast).toHaveBeenCalledWith('Asr', 'generic_3.mp3', expect.anything(), store.current);
    expect(cast.mock.calls[0][2].toFormat('HH:mm:ss')).toBe('16:16:00');

    expect(onScheduleChanged).toHaveBeenCalledWith(expect.objectContaining({
      date: '2026-10-02',
      reason: 'morning',
      changes: { Asr: { from: '16:17', to: '16:16' } },
    }));
  });

  // adhan-ce's revalidationCrossesNow (lib/schedule.js) rejects both of these
  // answers whole; the Pi must too, or the two apps fire at different times.
  test.each([
    ['a fired prayer moved later', { Dhuhr: '14:45' }], // was 12:57, fired an hour ago
    ['a pending prayer moved into the past', { Asr: '13:50' }], // was 16:17
  ])('an answer that moves a prayer across now is rejected and not stored (%s)', async (_, moved) => {
    jest.setSystemTime(pdt('14:00:00'));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    const jobs = [...scheduler._scheduledJobs];
    spy.mockClear();

    store.answer = { ...BASE, ...moved };
    await expect(scheduler.revalidateToday('morning', { retryAt: at('14:10') })).resolves.toEqual({ changed: false, failed: true });

    expect(store.commitEntry).not.toHaveBeenCalled();
    expect(store.current.timings).toEqual(BASE);
    expect(scheduler._armed.times).toEqual(BASE);
    expect(scheduler._scheduledJobs.slice(0, jobs.length)).toEqual(jobs);
    expect(jobs.every((job) => job.nextInvocation() !== null)).toBe(true);
    expect(timesOf(spy)).toEqual(['14:10:00']); // only the retry
  });

  test('a large change that crosses nothing is still applied', async () => {
    jest.setSystemTime(pdt('14:00:00'));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    spy.mockClear();

    store.answer = { ...BASE, Asr: '15:00' };
    await expect(scheduler.revalidateToday('morning')).resolves.toEqual({
      changed: true,
      changes: { Asr: { from: '16:17', to: '15:00' } },
    });
    expect(timesOf(spy)).toEqual(expect.arrayContaining(['14:55:00', '15:00:00', '15:00:30']));
  });

  test('revalidationCrossesNow matches adhan-ce', () => {
    const now = at('14:00');
    expect(CoreScheduler.revalidationCrossesNow(BASE, { ...BASE, Asr: '16:16' }, now)).toEqual([]);
    expect(CoreScheduler.revalidationCrossesNow(BASE, { ...BASE, Asr: '13:50' }, now)).toEqual(['Asr']);
    expect(CoreScheduler.revalidationCrossesNow(BASE, { ...BASE, Dhuhr: '14:45' }, now)).toEqual(['Dhuhr']);
    expect(CoreScheduler.revalidationCrossesNow(BASE, { ...BASE, Dhuhr: '13:30' }, now)).toEqual([]);
    expect(CoreScheduler.revalidationCrossesNow(BASE, { ...BASE, Sunrise: '14:30' }, now)).toEqual([]); // not a prayer
    const { Isha: _isha, ...noIsha } = BASE;
    expect(CoreScheduler.revalidationCrossesNow(noIsha, BASE, now)).toEqual(['Isha']);
    // A prayer exactly at now counts as upcoming, as _armToday arms it.
    expect(CoreScheduler.revalidationCrossesNow(BASE, { ...BASE, Dhuhr: '14:00' }, now)).toEqual(['Dhuhr']);
  });

  test('skips while an Adhan is casting or a window-retry is pending', async () => {
    jest.setSystemTime(pdt('14:00:00'));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    store.answer = { ...BASE, Asr: '16:16' };

    scheduler.activeRuns.add('Dhuhr');
    await expect(scheduler.revalidateToday('morning')).resolves.toMatchObject({ changed: false, skipped: expect.any(String) });
    scheduler.activeRuns.delete('Dhuhr');

    scheduler._pendingRetries = new Map([['Dhuhr', { retryAtMs: Date.now() + 60000 }]]);
    await expect(scheduler.revalidateToday('morning')).resolves.toMatchObject({ changed: false, skipped: expect.any(String) });

    expect(store.fetchEntry).not.toHaveBeenCalled();
  });

  test('skips while a full reschedule is running', async () => {
    jest.setSystemTime(pdt('14:00:00'));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    store.answer = { ...BASE, Asr: '16:16' };

    scheduler._schedulingToday = true;
    await expect(scheduler.revalidateToday('morning')).resolves.toEqual({
      changed: false,
      skipped: 'a full reschedule is running',
    });
    expect(store.fetchEntry).not.toHaveBeenCalled();
  });

  test('a cast that starts during the fetch blocks applying, and nothing is stored', async () => {
    jest.setSystemTime(pdt('14:00:00'));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    const jobs = [...scheduler._scheduledJobs];
    spy.mockClear();

    store.fetchEntry.mockImplementationOnce(async () => {
      scheduler.activeRuns.add('Asr'); // e.g. a manual /api/trigger/prayer
      return entryWith({ ...BASE, Asr: '16:16' });
    });
    await expect(scheduler.revalidateToday('morning')).resolves.toEqual({
      changed: false,
      skipped: 'a cast is in progress (Asr)',
    });

    expect(store.commitEntry).not.toHaveBeenCalled();
    expect(scheduler._armed.times.Asr).toBe('16:17');
    expect(scheduler._scheduledJobs).toEqual(jobs);
    expect(jobs.every((job) => job.nextInvocation() !== null)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a reschedule that lands during the fetch wins; the fetched answer is dropped', async () => {
    jest.setSystemTime(pdt('14:00:00'));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();

    store.fetchEntry.mockImplementationOnce(async () => {
      await scheduler.scheduleToday(); // e.g. the midnight job or a clock-jump recovery
      return entryWith({ ...BASE, Asr: '16:16' });
    });
    await expect(scheduler.revalidateToday('morning')).resolves.toEqual({
      changed: false,
      skipped: 'rescheduled meanwhile',
    });
    expect(store.commitEntry).not.toHaveBeenCalled();
    expect(scheduler._armed.times.Asr).toBe('16:17');
  });

  test('only one revalidation runs at a time', async () => {
    jest.setSystemTime(pdt('14:00:00'));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    store.answer = { ...BASE, Asr: '16:16' };

    const [first, second] = await Promise.all([
      scheduler.revalidateToday('pre-Asr'),
      scheduler.revalidateToday('morning'),
    ]);
    expect(first).toMatchObject({ changed: true });
    expect(second).toEqual({ changed: false, skipped: 'another revalidation is running' });
    expect(store.fetchEntry).toHaveBeenCalledTimes(1);
  });

  test('an answer missing a prayer is refused and changes nothing', async () => {
    jest.setSystemTime(pdt('14:00:00'));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    const jobs = [...scheduler._scheduledJobs];

    const { Isha: _isha, ...noIsha } = BASE;
    store.answer = { ...noIsha, Asr: '16:16' };
    scheduler.log = jest.fn();
    await expect(scheduler.revalidateToday('morning')).resolves.toEqual({ changed: false, failed: true });

    expect(scheduler.log).toHaveBeenCalledWith(expect.stringContaining('no usable entry for today'));
    expect(store.commitEntry).not.toHaveBeenCalled();
    expect(scheduler._armed.times).toEqual(BASE);
    expect(scheduler._scheduledJobs).toEqual(jobs);
    expect(jobs.every((job) => job.nextInvocation() !== null)).toBe(true);
  });

  test('an answer that cannot be stored is not applied', async () => {
    jest.setSystemTime(pdt('14:00:00'));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    const jobs = [...scheduler._scheduledJobs];

    store.answer = { ...BASE, Asr: '16:16' };
    store.commitEntry.mockReturnValueOnce(false);
    await expect(scheduler.revalidateToday('morning')).resolves.toEqual({ changed: false, failed: true });
    expect(scheduler._armed.times.Asr).toBe('16:17');
    expect(jobs.every((job) => job.nextInvocation() !== null)).toBe(true);
  });

  test.each([
    ['15:50:00', '27 min before Asr'],
    ['16:25:00', '8 min after Asr'],
  ])('skips at %s (%s)', async (now) => {
    jest.setSystemTime(pdt(now));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    store.answer = { ...BASE, Maghrib: '18:51' };

    await expect(scheduler.revalidateToday('morning')).resolves.toMatchObject({ changed: false, skipped: expect.stringContaining('Asr') });
    expect(store.fetchEntry).not.toHaveBeenCalled();
  });

  test('a failed fetch keeps the times and retries once at T-35', async () => {
    jest.setSystemTime(pdt('15:32:00'));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    const jobs = [...scheduler._scheduledJobs];
    spy.mockClear();

    store.answer = null;
    const result = await scheduler.revalidateToday('pre-Asr', { prayerTime: at('16:17'), retryAt: at('15:42') });

    expect(result).toEqual({ changed: false, failed: true });
    expect(store.current.timings.Asr).toBe('16:17');
    expect(jobs.every((job) => job.nextInvocation() !== null)).toBe(true);
    expect(timesOf(spy)).toEqual(['15:42:00']);

    // The retry tries again, and does not chain another retry.
    const retry = jobAt(spy, '15:42:00');
    spy.mockClear();
    jest.setSystemTime(pdt('15:42:00'));
    await expect(retry.fn()).resolves.toEqual({ changed: false, failed: true });
    expect(store.fetchEntry).toHaveBeenCalledTimes(2); // attempt + retry
    expect(store.commitEntry).not.toHaveBeenCalled();
    expect(timesOf(spy)).toEqual([]);
  });

  test.each([
    ['later', '16:19', '15:34:00'], // new T-45 still ahead
    ['earlier', '16:16', '15:31:00'], // new T-45 already passed, before T-30
  ])('after its own pre-prayer check moves the prayer %s, the re-armed check never fetches again', async (_, moved, newT45) => {
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    const preAsr = jobAt(spy, '15:32:00');

    jest.setSystemTime(pdt('15:32:00'));
    store.answer = { ...BASE, Asr: moved };
    spy.mockClear();
    await expect(preAsr.fn()).resolves.toMatchObject({ changed: true });
    expect(store.fetchEntry).toHaveBeenCalledTimes(1);

    // Fetched at 15:32, at or after the moved Asr's T-50: no redundant job, not
    // even a catch-up one...
    const times = timesOf(spy);
    expect(times).not.toContain(newT45);
    expect(times).not.toContain('15:32:30');
    expect(times).toEqual(expect.arrayContaining(['18:05:00', '19:16:00'])); // Maghrib, Isha keep theirs

    // ...and a check for it anyway (any trigger) finds today fresh.
    jest.setSystemTime(pdt('15:34:00'));
    const prayerTime = at(moved);
    await expect(scheduler.revalidateToday('pre-Asr', { prayerTime, retryAt: prayerTime.minus({ minutes: 35 }) })).resolves.toEqual({ changed: false });
    expect(store.fetchEntry).toHaveBeenCalledTimes(1);
  });

  test('a cache rewritten since arming is applied by the next check without re-fetching', async () => {
    jest.setSystemTime(pdt('15:32:00'));
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();

    store.current = entryWith({ ...BASE, Isha: '20:02' });
    store.fetchedAt = at('15:30'); // after Asr's T-50 (15:27)
    await expect(scheduler.revalidateToday('pre-Asr', { prayerTime: at('16:17') })).resolves.toEqual({
      changed: true,
      changes: { Isha: { from: '20:01', to: '20:02' } },
    });
    expect(store.fetchEntry).not.toHaveBeenCalled();
    expect(store.commitEntry).not.toHaveBeenCalled();
  });

  test('never throws: store errors and hook errors resolve', async () => {
    jest.setSystemTime(pdt('14:00:00'));
    const store = makeStore();
    scheduler = makeScheduler(store, { onScheduleChanged: async () => { throw new Error('firestore down'); } });
    await scheduler.scheduleToday();

    store.answer = { ...BASE, Asr: '16:16' };
    await expect(scheduler.revalidateToday('morning')).resolves.toMatchObject({ changed: true });

    store.answer = { ...BASE, Asr: '16:15' };
    store.commitEntry.mockImplementationOnce(() => { throw new Error('disk full'); });
    await expect(scheduler.revalidateToday('morning')).resolves.toEqual({ changed: false, failed: true });
    expect(scheduler._armed.times.Asr).toBe('16:16');
  });

  test('skips when today has not been scheduled', async () => {
    scheduler = makeScheduler(makeStore());
    await expect(scheduler.revalidateToday('morning')).resolves.toMatchObject({ changed: false, skipped: expect.any(String) });
  });

  describe('shared rule v2 (the same moments as adhan-ce)', () => {
    const ASR = () => at('16:17');
    const preAsr = (opts = {}) => scheduler.revalidateToday('pre-Asr', { prayerTime: ASR(), retryAt: at('15:42'), ...opts });
    const setup = async (now, fetchedAt = null) => {
      jest.setSystemTime(pdt(now));
      const store = makeStore();
      store.fetchedAt = fetchedAt;
      scheduler = makeScheduler(store);
      await scheduler.scheduleToday();
      store.answer = { ...BASE };
      spy.mockClear();
      return store;
    };

    test('a pre-prayer check runs until just before T-30', async () => {
      const store = await setup('15:46:59');
      await expect(preAsr()).resolves.toEqual({ changed: false });
      expect(store.fetchEntry).toHaveBeenCalledTimes(1);
    });

    test('at or after T-30 a pre-prayer check skips, without a retry', async () => {
      const store = await setup('15:47:00');
      await expect(preAsr()).resolves.toEqual({ changed: false, skipped: 'the pre-prayer window closed at 3:47 PM' });
      expect(store.fetchEntry).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    });

    test.each([
      ['15:27:00', 'at T-50', 0],
      ['15:26:59', 'just before T-50', 1],
    ])('fetched at %s (%s): fetches %i time(s)', async (fetchedAt, _, fetches) => {
      const store = await setup('15:32:00', at(fetchedAt));
      await expect(preAsr()).resolves.toEqual({ changed: false });
      expect(store.fetchEntry).toHaveBeenCalledTimes(fetches);
    });

    test('a held answer (a prayer would cross now) is retried once at T-35', async () => {
      const store = await setup('15:32:00');
      store.answer = { ...BASE, Dhuhr: '15:40' }; // fired at 12:57; would fire again
      await expect(preAsr()).resolves.toEqual({ changed: false, failed: true });
      expect(store.commitEntry).not.toHaveBeenCalled();
      expect(timesOf(spy)).toEqual(['15:42:00']);
    });

    test('quiet only for 10 min after a prayer (ts <= now < ts + 10 min)', async () => {
      const store = await setup('16:17:00');
      await expect(scheduler.revalidateToday('morning')).resolves.toEqual({
        changed: false,
        skipped: 'Asr (16:17) was less than 10 min ago',
      });
      jest.setSystemTime(pdt('16:26:59'));
      await expect(scheduler.revalidateToday('morning')).resolves.toMatchObject({ skipped: expect.stringContaining('Asr') });
      expect(store.fetchEntry).not.toHaveBeenCalled();

      jest.setSystemTime(pdt('16:27:00'));
      await expect(scheduler.revalidateToday('morning')).resolves.toEqual({ changed: false });
      expect(store.fetchEntry).toHaveBeenCalledTimes(1);
    });

    test('a quiet-period skip still retries', async () => {
      await setup('16:20:00');
      await expect(scheduler.revalidateToday('morning', { retryAt: at('16:30') })).resolves.toMatchObject({ skipped: expect.any(String) });
      expect(timesOf(spy)).toEqual(['16:30:00']);
    });

    // The gates apply to pre-prayer checks too, not only to the morning one.
    test('a pre-prayer T-45 inside the previous prayer\'s quiet period skips and retries at T-35', async () => {
      // Maghrib 18:50, Isha 19:40: Isha's T-45 (18:55) falls in Maghrib's quiet period.
      jest.setSystemTime(pdt('18:30:00'));
      const store = makeStore({ ...BASE, Isha: '19:40' });
      scheduler = makeScheduler(store);
      await scheduler.scheduleToday();
      const preIsha = jobAt(spy, '18:55:00');
      expect(preIsha).toBeDefined();
      store.answer = { ...BASE, Isha: '19:41' };
      spy.mockClear();

      jest.setSystemTime(pdt('18:55:00'));
      await expect(preIsha.fn()).resolves.toEqual({
        changed: false,
        skipped: 'Maghrib (18:50) was less than 10 min ago',
      });
      expect(store.fetchEntry).not.toHaveBeenCalled();
      expect(scheduler._armed.times.Isha).toBe('19:40');
      expect(timesOf(spy)).toEqual(['19:05:00']); // Isha's T-35

      // The retry lands after the quiet period and samples Isha.
      const retry = jobAt(spy, '19:05:00');
      jest.setSystemTime(pdt('19:05:00'));
      await expect(retry.fn()).resolves.toEqual({ changed: true, changes: { Isha: { from: '19:40', to: '19:41' } } });
      expect(store.fetchEntry).toHaveBeenCalledTimes(1);
    });

    test('a pre-prayer check only samples the next upcoming prayer', async () => {
      // Maghrib 18:50, Isha 19:28 (38 min apart): Isha's T-45 (18:43) comes before
      // Maghrib. It must not run then — it could move Maghrib inside its last 30 min.
      jest.setSystemTime(pdt('18:00:00'));
      const store = makeStore({ ...BASE, Isha: '19:28' });
      scheduler = makeScheduler(store);
      await scheduler.scheduleToday();
      const preIsha = jobAt(spy, '18:43:00');
      expect(preIsha).toBeDefined();
      store.answer = { ...BASE, Maghrib: '18:49', Isha: '19:27' };
      spy.mockClear();

      jest.setSystemTime(pdt('18:43:00'));
      await expect(preIsha.fn()).resolves.toEqual({ changed: false, skipped: 'Maghrib (18:50) comes first' });
      expect(store.fetchEntry).not.toHaveBeenCalled();
      expect(scheduler._armed.times.Maghrib).toBe('18:50');
      expect(spy).not.toHaveBeenCalled(); // no retry: Maghrib's own check owns this window
    });

    test.each([
      ['a cast is running', (s) => s.activeRuns.add('Dhuhr'), 'a cast is in progress (Dhuhr)'],
      ['a cast retry is pending', (s) => { s._pendingRetries = new Map([['Dhuhr', { retryAtMs: Date.now() + 60000 }]]); }, 'a window-retry is pending (Dhuhr)'],
    ])('a pre-prayer check skips while %s, and retries at T-35', async (_, block, why) => {
      const store = await setup('15:32:00');
      store.answer = { ...BASE, Asr: '16:18' };
      block(scheduler);
      await expect(preAsr()).resolves.toEqual({ changed: false, skipped: why });
      expect(store.fetchEntry).not.toHaveBeenCalled();
      expect(scheduler._armed.times.Asr).toBe('16:17');
      expect(timesOf(spy)).toEqual(['15:42:00']);
    });

    test.each([
      ['15:27:00', 'Asr (16:17) is sampled by its own pre-prayer check'], // T-50
      ['15:32:00', 'Asr (16:17) is sampled by its own pre-prayer check'], // T-45
      ['15:46:59', 'Asr (16:17) is sampled by its own pre-prayer check'],
      ['15:47:00', 'Asr (16:17) is less than 30 min away'], // T-30
      ['16:16:59', 'Asr (16:17) is less than 30 min away'],
    ])('the morning check skips at %s, without a retry', async (now, why) => {
      const store = await setup(now);
      await expect(scheduler.revalidateToday('morning', { retryAt: at('16:40') })).resolves.toEqual({ changed: false, skipped: why });
      expect(store.fetchEntry).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    });

    test('the morning check runs just before a prayer\'s T-50', async () => {
      const store = await setup('15:26:59');
      await expect(scheduler.revalidateToday('morning')).resolves.toEqual({ changed: false });
      expect(store.fetchEntry).toHaveBeenCalledTimes(1);
    });

    test('the PRAYER_MORNING_REFRESH job inside a prayer window logs why and does not retry', async () => {
      const store = await setup('15:00:00');
      scheduler.log = jest.fn();
      scheduler.armMorningRevalidation('15:30');
      const morning = spy.mock.calls[spy.mock.calls.length - 1][1];
      spy.mockClear();
      try {
        jest.setSystemTime(pdt('15:30:00'));
        await expect(morning()).resolves.toMatchObject({ changed: false, skipped: expect.stringContaining('Asr') });
        expect(scheduler.log).toHaveBeenCalledWith('🔄 Revalidation (morning) skipped: Asr (16:17) is sampled by its own pre-prayer check.');
        expect(store.fetchEntry).not.toHaveBeenCalled();
        expect(spy).not.toHaveBeenCalled();
      } finally {
        scheduler._morningRevalidationJob.cancel();
      }
    });

    test('the schedule-change hook runs after the lock is released, in order, never blocking a revalidation', async () => {
      jest.setSystemTime(pdt('14:00:00'));
      const store = makeStore();
      let releaseFirst;
      const onScheduleChanged = jest.fn(() => (onScheduleChanged.mock.calls.length === 1
        ? new Promise((resolve) => { releaseFirst = resolve; })
        : Promise.resolve()));
      scheduler = makeScheduler(store, { onScheduleChanged });
      await scheduler.scheduleToday();

      store.answer = { ...BASE, Asr: '16:16' };
      await expect(scheduler.revalidateToday('morning')).resolves.toEqual({
        changed: true,
        changes: { Asr: { from: '16:17', to: '16:16' } },
      });
      await Promise.resolve();
      expect(onScheduleChanged).toHaveBeenCalledTimes(1); // still pending...
      expect(scheduler._revalidating).toBe(false); // ...but the lock is free

      store.answer = { ...BASE, Asr: '16:15' };
      await expect(scheduler.revalidateToday('morning')).resolves.toMatchObject({ changed: true });
      expect(store.fetchEntry).toHaveBeenCalledTimes(2);
      await Promise.resolve();
      expect(onScheduleChanged).toHaveBeenCalledTimes(1); // queued behind the first

      releaseFirst();
      await scheduler._scheduleChangedQueue;
      expect(onScheduleChanged).toHaveBeenCalledTimes(2);
      expect(onScheduleChanged.mock.calls[1][0]).toMatchObject({ changes: { Asr: { from: '16:16', to: '16:15' } } });
    });

    test('schedule-change hook errors, sync or async, are logged and do not stop the queue', async () => {
      jest.setSystemTime(pdt('14:00:00'));
      const store = makeStore();
      const onScheduleChanged = jest.fn()
        .mockImplementationOnce(() => { throw new Error('sync boom'); })
        .mockImplementationOnce(async () => { throw new Error('firestore down'); })
        .mockImplementation(async () => {});
      scheduler = makeScheduler(store, { onScheduleChanged });
      await scheduler.scheduleToday();
      scheduler.log = jest.fn();

      for (const asr of ['16:16', '16:15', '16:14']) {
        store.answer = { ...BASE, Asr: asr };
        await expect(scheduler.revalidateToday('morning')).resolves.toMatchObject({ changed: true });
      }
      await scheduler._scheduleChangedQueue;
      expect(onScheduleChanged).toHaveBeenCalledTimes(3);
      expect(scheduler.log).toHaveBeenCalledWith('⚠️ Revalidation (morning): schedule-change hook failed: sync boom');
      expect(scheduler.log).toHaveBeenCalledWith('⚠️ Revalidation (morning): schedule-change hook failed: firestore down');
    });
  });

  describe('morning clips on a Sunrise move', () => {
    const scenes = (ishraqOffsetSec = 1200) => ({
      sunrise: { enabled: true, offsetSec: 0, prebakeSec: 600, clipSeconds: 12 },
      ishraq: { enabled: true, offsetSec: ishraqOffsetSec, prebakeSec: 600, clipSeconds: 12 },
    });

    test('a clip still ahead is re-armed at the new time', async () => {
      jest.setSystemTime(pdt('06:30:00'));
      const store = makeStore();
      scheduler = makeScheduler(store, {}, scenes());
      await scheduler.scheduleToday();
      expect(timesOf(spy)).toEqual(expect.arrayContaining(['06:55:00', '07:05:00', '07:15:00', '07:25:00']));
      spy.mockClear();

      store.answer = { ...BASE, Sunrise: '07:06' };
      await expect(scheduler.revalidateToday('morning')).resolves.toMatchObject({ changed: true });
      const times = timesOf(spy);
      expect(times).toEqual(expect.arrayContaining(['06:56:00', '07:06:00', '07:16:00', '07:26:00']));
      for (const t of ['06:55:00', '07:05:00', '07:15:00', '07:25:00']) expect(times).not.toContain(t);
    });

    test('a clip that already played is not cast again when Sunrise moves later', async () => {
      jest.setSystemTime(pdt('08:00:00'));
      const store = makeStore();
      // Ishraq at Sunrise + 54:30 = 07:59:30, which played 30s ago.
      scheduler = makeScheduler(store, {}, scenes(3270));
      await scheduler.scheduleToday();
      spy.mockClear();

      store.answer = { ...BASE, Sunrise: '07:06' }; // new Ishraq would be 08:00:30
      await expect(scheduler.revalidateToday('morning')).resolves.toMatchObject({ changed: true });
      const times = timesOf(spy);
      expect(times).not.toContain('08:00:30');
      expect(times).not.toContain('07:06:00');
      expect(times).not.toContain('07:50:30'); // its bake
    });

    test('a clip that had not played but moved into the past casts now instead of being dropped', async () => {
      jest.setSystemTime(pdt('07:04:30'));
      const store = makeStore();
      scheduler = makeScheduler(store, {}, scenes());
      await scheduler.scheduleToday();
      expect(timesOf(spy)).toContain('07:05:00');
      spy.mockClear();

      store.answer = { ...BASE, Sunrise: '07:04' };
      await expect(scheduler.revalidateToday('morning')).resolves.toEqual({
        changed: true,
        changes: { Sunrise: { from: '07:05', to: '07:04' } },
      });
      const times = timesOf(spy);
      expect(times).toContain('07:04:32'); // Sunrise, now
      expect(times).not.toContain('07:05:00');
      expect(times).toEqual(expect.arrayContaining(['07:14:00', '07:24:00'])); // Ishraq bake + cast, still ahead

      const cast = jest.spyOn(scheduler, 'castScene').mockResolvedValue();
      jobAt(spy, '07:04:32').fn();
      expect(cast).toHaveBeenCalledWith('sunrise', expect.any(String));
    });
  });
});

describe('CoreScheduler.armMorningRevalidation', () => {
  let scheduler;
  let spy;

  beforeEach(() => {
    jest.useFakeTimers({ now: pdt('07:00:00'), doNotFake: ['nextTick'] });
    spy = jest.spyOn(schedule, 'scheduleJob');
  });
  afterEach(() => {
    if (scheduler) {
      scheduler._scheduledJobs.forEach((job) => job && job.cancel());
      if (scheduler._morningRevalidationJob) scheduler._morningRevalidationJob.cancel();
    }
    scheduler = null;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const nextRun = (job) => job.nextInvocation().toDate().toISOString();

  test.each([
    [undefined, '2026-10-02T15:00:00.000Z'], // default 08:00 PDT
    ['08:00', '2026-10-02T15:00:00.000Z'],
    ['7:30', '2026-10-02T14:30:00.000Z'],
    ['06:15', '2026-10-03T13:15:00.000Z'], // already past today: tomorrow
  ])('PRAYER_MORNING_REFRESH=%p runs next at %s (in TIMEZONE)', (raw, expected) => {
    scheduler = makeScheduler(makeStore());
    scheduler.log = jest.fn();
    expect(nextRun(scheduler.armMorningRevalidation(raw))).toBe(expected);
    expect(scheduler.log).not.toHaveBeenCalledWith(expect.stringContaining('not HH:MM'));
  });

  test('the time is read in the prayer timezone, not the machine one', () => {
    // Any zone other than this machine's, so a rule without tz would run at the wrong instant.
    // Now is 14:00Z: 03:00 on the 3rd in Auckland (NZDT), 19:00 on the 2nd in Karachi.
    const [zone, expected] = Intl.DateTimeFormat().resolvedOptions().timeZone === 'Pacific/Auckland'
      ? ['Asia/Karachi', '2026-10-03T03:00:00.000Z']
      : ['Pacific/Auckland', '2026-10-02T19:00:00.000Z'];
    scheduler = makeScheduler(makeStore(), {}, { timezone: zone });
    expect(nextRun(scheduler.armMorningRevalidation('08:00'))).toBe(expected);
  });

  test('an invalid value warns and falls back to 08:00', () => {
    scheduler = makeScheduler(makeStore());
    scheduler.log = jest.fn();
    expect(nextRun(scheduler.armMorningRevalidation('8am'))).toBe('2026-10-02T15:00:00.000Z');
    expect(scheduler.log).toHaveBeenCalledWith(expect.stringContaining('PRAYER_MORNING_REFRESH="8am" is not HH:MM'));
  });

  test('runs a morning revalidation that re-fetches, with one retry 10 minutes later', async () => {
    const store = makeStore();
    scheduler = makeScheduler(store);
    await scheduler.scheduleToday();
    scheduler.armMorningRevalidation('08:00');
    const morning = spy.mock.calls[spy.mock.calls.length - 1][1];
    spy.mockClear();

    jest.setSystemTime(pdt('08:00:00'));
    store.answer = null; // Aladhan down
    await expect(morning()).resolves.toEqual({ changed: false, failed: true });
    expect(store.fetchEntry).toHaveBeenCalledTimes(1);
    expect(timesOf(spy)).toEqual(['08:10:00']);

    jest.setSystemTime(pdt('08:10:00'));
    store.answer = { ...BASE, Asr: '16:16' };
    await expect(jobAt(spy, '08:10:00').fn()).resolves.toMatchObject({ changed: true });
  });

  test('survives scheduleToday, and arming again replaces the old job', async () => {
    scheduler = makeScheduler(makeStore());
    const first = scheduler.armMorningRevalidation('08:00');
    await scheduler.scheduleToday();
    expect(first.nextInvocation()).not.toBeNull();

    const second = scheduler.armMorningRevalidation('09:00');
    expect(first.nextInvocation()).toBeNull();
    expect(nextRun(second)).toBe('2026-10-02T16:00:00.000Z');
  });
});

describe('CoreScheduler revalidation with the real PrayerScheduleStore', () => {
  let dir;
  let scheduler;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revalidate-'));
    jest.useFakeTimers({ now: pdt('08:00:00'), doNotFake: ['nextTick'] });
  });
  afterEach(() => {
    if (scheduler) scheduler._scheduledJobs.forEach((job) => job && job.cancel());
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Fake Aladhan: the calendar says BASE; the daily answer is BASE plus `aladhan.moved`.
  const aladhan = { moved: {}, fail: false };
  const dayEntry = (day, timings) => ({
    timings,
    date: { readable: day.toFormat('dd LLL yyyy'), gregorian: { date: day.toFormat('dd-MM-yyyy'), day: day.toFormat('dd') } },
    meta: { timezone: TZ },
  });
  const http = {
    get: jest.fn(async (url) => {
      if (aladhan.fail) throw new Error('503');
      const cal = url.match(/\/calendarByCity\/(\d{4})\?/);
      if (cal) {
        const data = {};
        for (let m = 1; m <= 12; m++) {
          const first = DateTime.fromObject({ year: Number(cal[1]), month: m, day: 1 }, { zone: TZ });
          data[m] = Array.from({ length: first.daysInMonth }, (_, i) => dayEntry(first.plus({ days: i }), { ...BASE }));
        }
        return { data: { data } };
      }
      const day = DateTime.fromFormat(url.match(/timingsByCity\/([\d-]+)/)[1], 'dd-MM-yyyy', { zone: TZ });
      return { data: { data: dayEntry(day, { ...BASE, ...aladhan.moved }) } };
    }),
  };
  const makeRealScheduler = () => {
    const s = makeScheduler(null);
    s.scheduleStore = new PrayerScheduleStore({
      location: { city: 'Sunnyvale', state: 'California', country: 'United States', method: 2, school: 0 },
      timezone: TZ,
      filePath: path.join(dir, 'annual_schedule.json'),
      http,
      log: () => {},
    });
    return s;
  };

  beforeEach(() => {
    aladhan.moved = {};
    aladhan.fail = false;
    http.get.mockClear();
  });

  test('a moved Aladhan answer reaches the cache and the armed jobs; a failure is reported', async () => {
    const spy = jest.spyOn(schedule, 'scheduleJob');
    try {
      scheduler = makeRealScheduler();

      await expect(scheduler.scheduleToday()).resolves.toBe(true);
      expect(scheduler._armed.times.Asr).toBe('16:17');
      const preAsr = jobAt(spy, '15:32:00');
      expect(preAsr).toBeDefined();

      jest.setSystemTime(pdt('14:00:00'));
      aladhan.fail = true;
      await expect(scheduler.revalidateToday('morning')).resolves.toEqual({ changed: false, failed: true });
      expect(scheduler._armed.times.Asr).toBe('16:17');

      // The T-45 job itself.
      jest.setSystemTime(pdt('15:32:00'));
      aladhan.fail = false;
      aladhan.moved = { Asr: '16:16' };
      http.get.mockClear();
      spy.mockClear();
      await expect(preAsr.fn()).resolves.toMatchObject({ changed: true });
      expect(http.get).toHaveBeenCalledTimes(1); // today's timingsByCity only
      expect(scheduler._armed.times.Asr).toBe('16:16');
      expect(scheduler.scheduleStore.getEntry(at('12:00')).timings.Asr).toBe('16:16');
      expect(scheduler.scheduleStore.lastFetchedAt(at('12:00')).toISO()).toBe(at('15:32').toISO());
      // Fresh: no second pre-Asr check, neither at the new T-45 (15:31, already
      // past) nor as a catch-up (15:32:30) anywhere in the new [T-45, T-30).
      const times = timesOf(spy);
      expect(times).not.toContain('15:31:00');
      expect(times).not.toContain('15:32:30');
      expect(times.filter((t) => t >= '15:31:00' && t < '15:46:00')).toEqual([]);
      expect(times).toEqual(expect.arrayContaining(['16:11:00', '18:05:00', '19:16:00'])); // the re-arm did run
    } finally {
      spy.mockRestore();
    }
  });

  test('an answer without Sunrise is accepted and the morning clips stand down', async () => {
    scheduler = makeRealScheduler();
    scheduler.config.sunrise = { enabled: true, offsetSec: 0, prebakeSec: 600, clipSeconds: 12 };
    jest.setSystemTime(pdt('06:00:00'));
    await expect(scheduler.scheduleToday()).resolves.toBe(true);
    expect(scheduler._armed.times.Sunrise).toBe('07:05');

    jest.setSystemTime(pdt('06:30:00'));
    aladhan.moved = { Sunrise: undefined };
    const spy = jest.spyOn(schedule, 'scheduleJob');
    try {
      scheduler.log = jest.fn();
      await expect(scheduler.revalidateToday('morning')).resolves.toEqual({
        changed: true,
        changes: { Sunrise: { from: '07:05', to: null } },
      });
      expect(scheduler.scheduleStore.getEntry(at('12:00')).timings.Sunrise).toBeUndefined();
      expect(timesOf(spy)).not.toContain('07:05:00');
      expect(scheduler.log).toHaveBeenCalledWith(expect.stringContaining('Sunrise: no sunrise timing in schedule, skipped.'));
    } finally {
      spy.mockRestore();
    }
  });

  test('a malformed answer keeps the old times and nothing is stored', async () => {
    jest.setSystemTime(pdt('14:00:00'));
    scheduler = makeRealScheduler();
    await expect(scheduler.scheduleToday()).resolves.toBe(true);
    const before = fs.readFileSync(path.join(dir, 'annual_schedule.json'), 'utf8');

    aladhan.moved = { Asr: '16:16 pm' };
    await expect(scheduler.revalidateToday('morning')).resolves.toEqual({ changed: false, failed: true });
    expect(scheduler._armed.times.Asr).toBe('16:17');
    expect(fs.readFileSync(path.join(dir, 'annual_schedule.json'), 'utf8')).toBe(before);
  });

  test('a rejected answer never reaches the cache, so a restart does not re-fire a prayer', async () => {
    jest.setSystemTime(pdt('12:00:00'));
    scheduler = makeRealScheduler();
    await expect(scheduler.scheduleToday()).resolves.toBe(true);
    const fetchedAt = scheduler.scheduleStore.lastFetchedAt(at('12:00')).toISO();

    // Dhuhr fires at 12:57; at 14:00 Aladhan moves it to 14:45.
    jest.setSystemTime(pdt('14:00:00'));
    aladhan.moved = { Dhuhr: '14:45' };
    await expect(scheduler.revalidateToday('morning')).resolves.toEqual({ changed: false, failed: true });
    expect(scheduler.scheduleStore.getEntry(at('12:00')).timings.Dhuhr).toBe('12:57');
    expect(scheduler.scheduleStore.lastFetchedAt(at('12:00')).toISO()).toBe(fetchedAt);
    scheduler._scheduledJobs.forEach((job) => job && job.cancel());

    // pm2 restart / deploy at 14:10: the new process arms from the cache.
    jest.setSystemTime(pdt('14:10:00'));
    const spy = jest.spyOn(schedule, 'scheduleJob');
    try {
      scheduler = makeRealScheduler();
      await expect(scheduler.scheduleToday()).resolves.toBe(true);
      expect(scheduler._armed.times.Dhuhr).toBe('12:57');
      const times = timesOf(spy);
      expect(times).not.toContain('14:40:00');
      expect(times).not.toContain('14:45:00');
      expect(times).toContain('16:12:00'); // Asr
    } finally {
      spy.mockRestore();
    }
  });
});

describe('CoreScheduler.parseClockTime', () => {
  test.each([
    ['08:00', { hour: 8, minute: 0 }],
    ['7:30', { hour: 7, minute: 30 }],
    [' 23:59 ', { hour: 23, minute: 59 }],
  ])('%s', (raw, expected) => expect(CoreScheduler.parseClockTime(raw)).toEqual(expected));

  test.each(['', '8', '24:00', '08:60', '8am', '08:00:00', undefined])('rejects %p', (raw) => {
    expect(CoreScheduler.parseClockTime(raw)).toBeNull();
  });
});
