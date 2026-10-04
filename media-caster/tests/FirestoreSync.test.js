const FirestoreSync = require('../services/FirestoreSync');

describe('FirestoreSync static helpers', () => {
  test('extractPrayerTimesHHmm parses tokens, pads values, and clamps out-of-range time parts', () => {
    const entry = {
      timings: {
        Fajr: '4:5 (PDT)',
        Dhuhr: '24:75',
        Asr: 'not-a-time',
        Maghrib: '19:07',
        Isha: null,
      },
    };

    const times = FirestoreSync.extractPrayerTimesHHmm(entry);

    expect(times).toEqual({
      Fajr: '04:05',
      Dhuhr: '23:59',
      Maghrib: '19:07',
    });
  });

  test('flattenScheduleFields keeps only supported prayer keys', () => {
    const flat = FirestoreSync.flattenScheduleFields({
      Fajr: '05:01',
      Maghrib: '19:55',
      Sunrise: '06:20',
    });

    expect(flat).toEqual({
      st_Fajr: '05:01',
      st_Maghrib: '19:55',
    });
    expect(flat.st_Sunrise).toBeUndefined();
  });
});

describe('FirestoreSync ensureTodayScheduleOnFirestore', () => {
  test('merges scheduledTimes and top-level st_* fields onto dailyMetrics', async () => {
    const sync = new FirestoreSync('encoded-key', 'America/Los_Angeles', '/tmp/annual_schedule.json');
    const prayerTimes = { Fajr: '05:00', Isha: '20:13' };
    const set = jest.fn().mockResolvedValue(undefined);
    const db = {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({ set })),
      })),
    };

    jest.spyOn(sync, '_getScheduledTimesForISODate').mockReturnValue(prayerTimes);
    jest.spyOn(sync, '_initFirestore').mockReturnValue(db);
    jest.spyOn(sync, 'publishPrayerSchedule').mockResolvedValue(true);

    const ok = await sync.ensureTodayScheduleOnFirestore('2026-04-22');

    expect(ok).toBe(true);
    expect(sync.publishPrayerSchedule).toHaveBeenCalledWith('2026-04-22', prayerTimes);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        date: '2026-04-22',
        scheduledTimes: prayerTimes,
        st_Fajr: '05:00',
        st_Isha: '20:13',
        scheduleUpdatedAt: expect.any(String),
      }),
      { merge: true },
    );
  });

  test('returns false when no schedule times resolve for the day', async () => {
    const sync = new FirestoreSync('encoded-key', 'America/Los_Angeles', '/tmp/annual_schedule.json');

    jest.spyOn(sync, '_getScheduledTimesForISODate').mockReturnValue({});
    jest.spyOn(sync, '_initFirestore');
    jest.spyOn(sync, 'publishPrayerSchedule');

    const ok = await sync.ensureTodayScheduleOnFirestore('2026-04-22');

    expect(ok).toBe(false);
    expect(sync._initFirestore).not.toHaveBeenCalled();
    expect(sync.publishPrayerSchedule).not.toHaveBeenCalled();
  });
});

describe('FirestoreSync _writeDay', () => {
  test('writes dailyMetrics with merge=true to avoid dropping previously set fields', async () => {
    const sync = new FirestoreSync('encoded-key', 'America/Los_Angeles', '/tmp/annual_schedule.json');
    const batch = {
      set: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    };
    const db = {
      batch: jest.fn(() => batch),
      collection: jest.fn((name) => ({
        doc: jest.fn((id) => `${name}/${id}`),
      })),
    };

    jest.spyOn(sync, '_getScheduledTimesForISODate').mockReturnValue({
      Fajr: '05:00',
      Dhuhr: '12:30',
    });

    await sync._writeDay(
      db,
      '2026-04-22',
      { total: 1, played: 1 },
      [{ prayer: 'Fajr', status: 'PLAYED' }],
      { updateLatest: false },
    );

    expect(batch.set).toHaveBeenNthCalledWith(
      1,
      'dailyMetrics/2026-04-22',
      expect.objectContaining({
        date: '2026-04-22',
        total: 1,
        played: 1,
        scheduledTimes: { Fajr: '05:00', Dhuhr: '12:30' },
        st_Fajr: '05:00',
        st_Dhuhr: '12:30',
        updatedAt: expect.any(String),
      }),
      { merge: true },
    );
    expect(batch.set).toHaveBeenNthCalledWith(
      2,
      'dailyEvents/2026-04-22',
      expect.objectContaining({
        date: '2026-04-22',
        events: [{ prayer: 'Fajr', status: 'PLAYED' }],
        updatedAt: expect.any(String),
      }),
    );
    expect(batch.set).toHaveBeenCalledTimes(2);
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });
});

describe('FirestoreSync next-day publish at Maghrib+5 (and its re-arm after a revalidation)', () => {
  const { DateTime } = require('luxon');
  const TZ = 'America/Los_Angeles';
  let sync;
  let times;

  // Sets the clock (node-schedule reads Date.now()) and returns that instant in TZ.
  const clock = (hhmmss, date = '2026-10-03') => {
    jest.setSystemTime(Date.parse(`${date}T${hhmmss}-07:00`));
    return DateTime.now().setZone(TZ);
  };
  const advanceTo = (hhmmss) => jest.advanceTimersByTime(Date.parse(`2026-10-03T${hhmmss}-07:00`) - Date.now());

  beforeEach(() => {
    jest.useFakeTimers({ now: Date.parse('2026-10-03T08:00:00-07:00'), doNotFake: ['nextTick'] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    times = { Fajr: '05:53', Maghrib: '18:50', Isha: '20:01' };
    sync = new FirestoreSync('encoded-key', TZ, '/tmp/annual_schedule.json');
    jest.spyOn(sync, '_getScheduledTimesForISODate').mockImplementation(() => ({ ...times }));
    jest.spyOn(sync, 'ensureTodayScheduleOnFirestore').mockResolvedValue(true);
    jest.spyOn(sync, 'ensureNextDayScheduleOnFirestore').mockResolvedValue(true);
  });
  afterEach(() => {
    if (sync._nextDayPublishJob) sync._nextDayPublishJob.cancel();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('scheduleNextDayPublish', () => {
    test('before Maghrib+5 it arms a job that publishes tomorrow then, not now', async () => {
      const armed = await sync.scheduleNextDayPublish(clock('12:00:00'));
      expect(armed.toFormat('HH:mm:ss')).toBe('18:55:00');
      expect(sync._getScheduledTimesForISODate).toHaveBeenCalledWith('2026-10-03');
      expect(sync.ensureNextDayScheduleOnFirestore).not.toHaveBeenCalled();

      advanceTo('18:54:59');
      expect(sync.ensureNextDayScheduleOnFirestore).not.toHaveBeenCalled();
      advanceTo('18:55:00');
      expect(sync.ensureNextDayScheduleOnFirestore).toHaveBeenCalledTimes(1);
      expect(sync.ensureNextDayScheduleOnFirestore).toHaveBeenCalledWith('2026-10-04');
      expect(sync._nextDayPublishJob).toBeNull();
    });

    test.each([
      ['from Maghrib+5', '18:55:00', { Maghrib: '18:50' }],
      ['without a Maghrib (as boot always did)', '12:00:00', {}],
    ])('%s it publishes tomorrow right away and arms nothing', async (_, now, today) => {
      times = today;
      await expect(sync.scheduleNextDayPublish(clock(now))).resolves.toBeNull();
      expect(sync.ensureNextDayScheduleOnFirestore).toHaveBeenCalledTimes(1);
      expect(sync.ensureNextDayScheduleOnFirestore).toHaveBeenCalledWith('2026-10-04');
      expect(sync._nextDayPublishJob).toBeNull();
    });

    test('calling it again replaces the armed job, so a moved Maghrib publishes once, at its own +5', async () => {
      await sync.scheduleNextDayPublish(clock('12:00:00'));
      const first = sync._nextDayPublishJob;

      // The pre-Maghrib check at 18:05 moves Maghrib 18:50 -> 18:56.
      times = { ...times, Maghrib: '18:56' };
      const armed = await sync.scheduleNextDayPublish(clock('18:05:00'));
      expect(armed.toFormat('HH:mm:ss')).toBe('19:01:00');
      expect(first.nextInvocation()).toBeNull();

      advanceTo('19:00:59');
      expect(sync.ensureNextDayScheduleOnFirestore).not.toHaveBeenCalled(); // not at the stale 18:55
      advanceTo('19:01:00');
      expect(sync.ensureNextDayScheduleOnFirestore).toHaveBeenCalledTimes(1);
    });

    test('defaults to now in the prayer timezone', async () => {
      clock('22:00:00'); // 05:00Z on the 4th
      await sync.scheduleNextDayPublish();
      expect(sync._getScheduledTimesForISODate).toHaveBeenCalledWith('2026-10-03');
      expect(sync.ensureNextDayScheduleOnFirestore).toHaveBeenCalledWith('2026-10-04');
    });
  });

  describe('republishTodaySchedule (after a revalidation moved today)', () => {
    test('before Maghrib+5 it republishes today and re-arms the next-day publish', async () => {
      await expect(sync.republishTodaySchedule(clock('18:54:59'))).resolves.toBe(true);
      expect(sync.ensureTodayScheduleOnFirestore).toHaveBeenCalledWith('2026-10-03');
      expect(sync.ensureNextDayScheduleOnFirestore).not.toHaveBeenCalled();
      expect(sync._nextDayPublishJob.nextInvocation().toISOString()).toBe('2026-10-04T01:55:00.000Z'); // 18:55 PDT
    });

    test('from Maghrib+5 it re-adds the nextDay field the today publish dropped', async () => {
      await sync.republishTodaySchedule(clock('18:55:00'));
      expect(sync.ensureTodayScheduleOnFirestore).toHaveBeenCalledWith('2026-10-03');
      expect(sync.ensureNextDayScheduleOnFirestore).toHaveBeenCalledWith('2026-10-04');
      // Today first: the today publish is what replaces meta/prayerSchedule.
      expect(sync.ensureTodayScheduleOnFirestore.mock.invocationCallOrder[0])
        .toBeLessThan(sync.ensureNextDayScheduleOnFirestore.mock.invocationCallOrder[0]);
    });

    test('a Maghrib moved later after its old +5 fired gets nextDay back at the new +5', async () => {
      await sync.scheduleNextDayPublish(clock('12:00:00'));
      advanceTo('18:55:00'); // the boot job publishes nextDay for Maghrib 18:50
      expect(sync.ensureNextDayScheduleOnFirestore).toHaveBeenCalledTimes(1);

      // The pre-Isha check at 19:00 moves Maghrib (already past) to 18:58; the
      // today publish drops nextDay, and 18:58+5 is still ahead.
      times = { ...times, Maghrib: '18:58' };
      await sync.republishTodaySchedule(clock('19:00:00'));
      expect(sync.ensureNextDayScheduleOnFirestore).toHaveBeenCalledTimes(1);
      advanceTo('19:03:00');
      expect(sync.ensureNextDayScheduleOnFirestore).toHaveBeenCalledTimes(2);
    });

    test('defaults to now in the prayer timezone', async () => {
      clock('22:00:00');
      sync.ensureTodayScheduleOnFirestore.mockResolvedValue(false);
      await expect(sync.republishTodaySchedule()).resolves.toBe(false);
      expect(sync.ensureTodayScheduleOnFirestore).toHaveBeenCalledWith('2026-10-03');
      expect(sync.ensureNextDayScheduleOnFirestore).toHaveBeenCalledWith('2026-10-04');
    });
  });
});
