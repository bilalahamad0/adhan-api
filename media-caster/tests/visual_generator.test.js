const axios = require('axios');

jest.mock('canvas', () => ({
  createCanvas: jest.fn(() => ({
    getContext: jest.fn(() => ({})),
    toBuffer: jest.fn(() => Buffer.from('')),
  })),
  loadImage: jest.fn(),
  registerFont: jest.fn(),
}), { virtual: true });

const VisualGenerator = require('../visual_generator');

describe('VisualGenerator weather parsing', () => {
  let generator;
  let axiosGet;

  beforeEach(() => {
    jest.clearAllMocks();
    axiosGet = jest.spyOn(axios, 'get').mockReset();
    generator = new VisualGenerator({
      timezone: 'America/Los_Angeles',
      location: {
        lat: 8.8888888,
        lon: 7.7777777,
        city: 'San Jose',
        country: 'US',
      },
    });
  });

  test('geolocates placeholder coordinates and normalizes rainy night weather', async () => {
    axiosGet
      .mockResolvedValueOnce({
        data: {
          results: [{ name: 'San Jose', admin1: 'California', latitude: 37.3382, longitude: -121.8863 }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          current: {
            temperature_2m: '56.6',
            weather_code: '2',
            is_day: '0',
            precipitation: '0.2',
            rain: 0,
          },
        },
      });

    const weather = await generator.getWeather();

    expect(weather).toEqual({ temp: '57°C', code: 61, isDay: 0 });
    expect(generator.config.location.lat).toBe(37.3382);
    expect(generator.config.location.lon).toBe(-121.8863);
    expect(axiosGet).toHaveBeenLastCalledWith(
      expect.stringContaining('latitude=37.3382&longitude=-121.8863'),
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' }),
        timeout: 12000,
      }),
    );
  });

  test('falls back to cloudy unknown conditions when Open-Meteo payload is invalid', async () => {
    generator.config.location.lat = 37.3382;
    generator.config.location.lon = -121.8863;
    jest.spyOn(generator, 'inferApproxIsDayFromClock').mockReturnValue(0);
    axiosGet.mockResolvedValueOnce({ data: { current: { weather_code: 'not-a-code' } } });

    await expect(generator.getWeather()).resolves.toEqual({ temp: '\u2014 °C', code: 3, isDay: 0 });
  });

  test('serves cached weather without repeating Open-Meteo calls', async () => {
    generator.config.location.lat = 37.3382;
    generator.config.location.lon = -121.8863;
    axiosGet.mockResolvedValueOnce({
      data: {
        current: {
          temperature_2m: 21.2,
          weather_code: 0,
          is_day: 1,
        },
      },
    });

    const first = await generator.getWeather();
    const second = await generator.getWeather();

    expect(second).toBe(first);
    expect(axiosGet).toHaveBeenCalledTimes(1);
  });
});
