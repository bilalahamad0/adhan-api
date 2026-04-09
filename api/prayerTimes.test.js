import { jest } from '@jest/globals';

jest.unstable_mockModule('axios', () => ({
  default: {
    get: jest.fn().mockResolvedValue({
      data: {
        data: {
          timings: {
            Fajr: '05:00',
            Dhuhr: '13:00',
            Asr: '17:00',
            Maghrib: '20:00',
            Isha: '21:30',
          },
        },
      },
    }),
  },
}));

describe('prayerTimes handler', () => {
  it('should successfully return prayer times', async () => {
    const req = { query: { country: 'US', city: 'Sunnyvale' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const { default: handler } = await import('./prayerTimes.js');
    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalled();
  });
});
