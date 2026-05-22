jest.mock('axios');
jest.mock('child_process', () => ({
  exec: jest.fn((cmd, cb) => {
    if (cb) cb(null, 'success', '');
  })
}));
const { exec } = require('child_process');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DateTime } = require('luxon');
const axios = require('axios');

const OllamaService = require('../services/OllamaService');
const aiContext = require('../services/aiContext');

const flush = () => new Promise((r) => setImmediate(r));

// Build a one-day annual_schedule.json fixture anchored to `now`.
function writeSchedule(now, timings) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adhan-sched-')), 'annual_schedule.json');
  const entry = {
    date: { gregorian: { day: String(now.day) }, hijri: { day: '1', month: { en: 'Muharram' }, year: '1447' } },
    timings,
  };
  fs.writeFileSync(file, JSON.stringify({ year: now.toFormat('yyyy'), data: { [now.month.toString()]: [entry] } }));
  return file;
}

describe('OllamaService.parseJson', () => {
  it('strips ```json fences', () => {
    expect(OllamaService.parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('strips bare ``` fences', () => {
    expect(OllamaService.parseJson('```\n{"b":2}\n```')).toEqual({ b: 2 });
  });
  it('extracts a JSON object surrounded by prose', () => {
    expect(OllamaService.parseJson('Sure! {"c":3} hope that helps')).toEqual({ c: 3 });
  });
  it('returns null on unparseable text', () => {
    expect(OllamaService.parseJson('not json at all')).toBeNull();
    expect(OllamaService.parseJson(null)).toBeNull();
  });
});

describe('OllamaService.ask', () => {
  let svc;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = new OllamaService({ timezone: 'America/Los_Angeles' });
  });

  it('returns trimmed response text on success', async () => {
    axios.post.mockResolvedValue({ data: { response: '  hello  ' } });
    await expect(svc.ask('sys', 'ctx')).resolves.toBe('hello');
  });

  it('returns null when the request throws (timeout/down)', async () => {
    axios.post.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(svc.ask('sys', 'ctx')).resolves.toBeNull();
  });

  it('serializes concurrent calls (single-flight)', async () => {
    let resolveFirst;
    const first = new Promise((res) => { resolveFirst = res; });
    axios.post
      .mockImplementationOnce(() => first.then(() => ({ data: { response: 'one' } })))
      .mockImplementationOnce(() => Promise.resolve({ data: { response: 'two' } }));

    const a = svc.ask('sys', '1');
    const b = svc.ask('sys', '2');

    await flush();
    expect(axios.post).toHaveBeenCalledTimes(1); // second call gated until first settles

    resolveFirst();
    const [r1, r2] = await Promise.all([a, b]);
    expect(r1).toBe('one');
    expect(r2).toBe('two');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it('one failure does not poison the queue', async () => {
    axios.post
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ data: { response: 'recovered' } });
    const a = await svc.ask('sys', '1');
    const b = await svc.ask('sys', '2');
    expect(a).toBeNull();
    expect(b).toBe('recovered');
  });
});

describe('OllamaService.isAvailable', () => {
  let svc;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = new OllamaService();
  });
  it('true on 200', async () => {
    axios.get.mockResolvedValue({ status: 200 });
    await expect(svc.isAvailable()).resolves.toBe(true);
  });
  it('false when unreachable', async () => {
    axios.get.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(svc.isAvailable()).resolves.toBe(false);
  });
  it('does not reset consecutive failures if circuit is CLOSED', async () => {
    svc._consecutiveFailures = 1;
    svc._state = 'CLOSED';
    axios.get.mockResolvedValue({ status: 200 });
    await expect(svc.isAvailable()).resolves.toBe(true);
    expect(svc._consecutiveFailures).toBe(1);
    expect(svc._state).toBe('CLOSED');
  });
  it('recovers on success if circuit is HALF_OPEN', async () => {
    const s = new OllamaService({ failureThreshold: 2 });
    s._consecutiveFailures = 2;
    s._state = 'HALF_OPEN';
    axios.get.mockResolvedValue({ status: 200 });
    const isAvail = await s.isAvailable();
    expect(isAvail).toBe(true);
    expect(s._state).toBe('CLOSED');
    expect(s._consecutiveFailures).toBe(0);
  });
});

describe('OllamaService quiet-window guard', () => {
  const tz = 'America/Los_Angeles';
  const now = DateTime.fromObject({ year: 2026, month: 5, day: 21, hour: 12, minute: 0 }, { zone: tz });

  it('isQuiet=false when within a prayer critical window', () => {
    // Dhuhr at 12:03 → 3 min before prayer → inside the window.
    const file = writeSchedule(now, { Dhuhr: '12:03' });
    const svc = new OllamaService({ scheduleFilePath: file, timezone: tz });
    expect(svc.isNearPrayer(now)).toBe(true);
    expect(svc.isQuiet(now)).toBe(false);
  });

  it('isQuiet=true when far from any prayer', () => {
    const file = writeSchedule(now, { Fajr: '05:00', Maghrib: '20:00' });
    const svc = new OllamaService({ scheduleFilePath: file, timezone: tz });
    expect(svc.isNearPrayer(now)).toBe(false);
    expect(svc.isQuiet(now)).toBe(true);
  });

  it('fails safe (treats as near-prayer) when schedule is unreadable', () => {
    const svc = new OllamaService({ scheduleFilePath: '/no/such/schedule.json', timezone: tz });
    expect(svc.isNearPrayer(now)).toBe(true);
  });
});

describe('aiContext.getNextPrayer (deterministic fallback core)', () => {
  const tz = 'America/Los_Angeles';

  it('returns the next upcoming prayer today', () => {
    const now = DateTime.now().setZone(tz);
    const later = now.plus({ hours: 2 });
    const file = writeSchedule(now, { Asr: later.toFormat('HH:mm') });
    const next = aiContext.getNextPrayer(file, tz);
    expect(next).toBeTruthy();
    expect(next.prayer).toBe('Asr');
    expect(next.tomorrow).toBe(false);
    expect(next.minutesUntil).toBeGreaterThan(0);
  });

  it('returns null when schedule is missing', () => {
    expect(aiContext.getNextPrayer('/no/such/file.json', tz)).toBeNull();
  });
});

describe('OllamaService Circuit Breaker and Watchdog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('trips the circuit after consecutive failures and enters OPEN state', async () => {
    const svc = new OllamaService({ failureThreshold: 2, cooldownDurationMs: 1000, restartCmd: 'restart-cmd' });
    axios.post.mockRejectedValue(new Error('timeout'));
    
    // First failure
    await svc.ask('sys', 'ctx');
    expect(svc._state).toBe('CLOSED');
    expect(svc._consecutiveFailures).toBe(1);
    expect(exec).not.toHaveBeenCalled();

    // Second failure
    await svc.ask('sys', 'ctx');
    expect(svc._state).toBe('OPEN');
    expect(svc._consecutiveFailures).toBe(2);
    expect(exec).toHaveBeenCalledWith('restart-cmd', expect.any(Function));
  });

  it('fails-fast during cooldown without calling axios.post or axios.get', async () => {
    const svc = new OllamaService({ failureThreshold: 1, cooldownDurationMs: 5000, restartCmd: 'restart-cmd' });
    axios.post.mockRejectedValue(new Error('timeout'));
    
    // Trip it
    await svc.ask('sys', 'ctx');
    expect(svc._state).toBe('OPEN');
    
    // Try asking again while OPEN
    jest.clearAllMocks();
    const res = await svc.ask('sys', 'ctx');
    expect(res).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();

    // Try checking availability while OPEN
    const isAvail = await svc.isAvailable();
    expect(isAvail).toBe(false);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('transitions to HALF_OPEN after cooldown expires and recovers on success', async () => {
    const svc = new OllamaService({ failureThreshold: 1, cooldownDurationMs: 100, restartCmd: 'restart-cmd' });
    axios.post.mockRejectedValue(new Error('timeout'));
    
    // Trip it
    await svc.ask('sys', 'ctx');
    expect(svc._state).toBe('OPEN');

    // Wait for cooldown to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Next call should run in HALF_OPEN and transition to CLOSED on success
    axios.post.mockResolvedValue({ data: { response: 'recovered!' } });
    jest.clearAllMocks();
    
    const res = await svc.ask('sys', 'ctx');
    expect(res).toBe('recovered!');
    expect(axios.post).toHaveBeenCalled();
    expect(svc._state).toBe('CLOSED');
    expect(svc._consecutiveFailures).toBe(0);
  });

  it('trips again if HALF_OPEN probe fails', async () => {
    const svc = new OllamaService({ failureThreshold: 1, cooldownDurationMs: 100, restartCmd: 'restart-cmd' });
    axios.post.mockRejectedValue(new Error('timeout'));
    
    // Trip it
    await svc.ask('sys', 'ctx');
    expect(svc._state).toBe('OPEN');

    // Wait for cooldown to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Next call should run in HALF_OPEN and fail
    axios.post.mockRejectedValue(new Error('still down'));
    jest.clearAllMocks();
    
    const res = await svc.ask('sys', 'ctx');
    expect(res).toBeNull();
    expect(axios.post).toHaveBeenCalled();
    expect(svc._state).toBe('OPEN');
    expect(svc._consecutiveFailures).toBe(2);
  });
});
