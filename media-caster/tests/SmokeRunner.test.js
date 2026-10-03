const SmokeRunner = require('../services/SmokeRunner');

describe('SmokeRunner._summarize', () => {
  const runner = new SmokeRunner({ log: () => {} });

  test('reads counts from the summary line, not from earlier log lines', () => {
    const output = [
      '⚠️ Aladhan fetch for 2026-10-03 failed (timeout); keeping the cached entry.',
      '  ✅ Media Server',
      '💨 SMOKE TEST COMPLETE: 31 passed, 0 failed.',
    ].join('\n');
    const r = runner._summarize(output, 1000, 'OK', 0);
    expect(r).toMatchObject({ passed: 31, failed: 0, ok: true });
  });

  test('still reports failures from the summary line', () => {
    const output = '  ❌ FAIL: Annual Schedule File — ENOENT\n💨 SMOKE TEST COMPLETE: 30 passed, 1 failed.';
    const r = runner._summarize(output, 1000, 'EXIT_1', 1);
    expect(r).toMatchObject({ passed: 30, failed: 1, ok: false, failedChecks: ['Annual Schedule File'] });
  });

  test('falls back to the generic pattern when the summary line is missing', () => {
    expect(runner._summarize('2 failed', 1000, 'TIMEOUT')).toMatchObject({ failed: 2, ok: false });
    expect(runner._summarize('', 1000, 'TIMEOUT')).toMatchObject({ failed: 1, ok: false });
  });
});
