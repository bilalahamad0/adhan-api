import handler from './updateCalendar.js';
import { jest } from '@jest/globals';

jest.unstable_mockModule('axios', () => ({
  default: {
    get: jest.fn().mockResolvedValue({
      data: {
        all_prayers: {
          Fajr: '05:00 AM',
          Dhuhr: '01:00 PM',
          Asr: '05:00 PM',
          Maghrib: '08:00 PM',
          Isha: '09:30 PM',
        },
      },
    }),
  },
}));

jest.unstable_mockModule('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn().mockImplementation(() => ({})),
    },
    calendar: jest.fn().mockReturnValue({
      events: {
        list: jest.fn().mockResolvedValue({
          data: {
            items: [], // No existing events
          },
        }),
        insert: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
    }),
  },
}));

describe('updateCalendar handler', () => {
  beforeEach(() => {
    process.env.GOOGLE_CALENDAR_ID = 'test-id';
    process.env.GOOGLE_SERVICE_KEY = Buffer.from(JSON.stringify({ client_email: 'test' })).toString(
      'base64'
    );
  });

  afterEach(() => {
    delete process.env.GOOGLE_CALENDAR_ID;
    delete process.env.GOOGLE_SERVICE_KEY;
  });

  it('should return 500 if missing env vars', async () => {
    delete process.env.GOOGLE_CALENDAR_ID;
    const req = {};
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    // dynamically import the module after mocking
    const module = await import('./updateCalendar.js');
    await module.default(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalled();
  });
});
