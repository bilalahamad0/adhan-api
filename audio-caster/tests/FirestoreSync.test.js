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
