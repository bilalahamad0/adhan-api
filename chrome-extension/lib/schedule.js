// Pure, dependency-free helpers shared by the service worker and popup.
// No chrome.* or DOM access here so this module is unit-testable under Node/Jest.

export const PRAYER_ORDER = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
export const DAY_MS = 24 * 60 * 60 * 1000;

// Local date as YYYY-MM-DD.
export function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// "06:30 PM" -> epoch ms on the given base date, in the local timezone. null if unparseable.
export function parseTimeToday(timeStr, base = new Date()) {
  const m = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, parseInt(m[2], 10), 0, 0).getTime();
}

// Build {name,time,ts} entries for today from an all_prayers map ("hh:mm a" strings).
export function buildPrayers(allPrayers, base = new Date()) {
  const all = allPrayers || {};
  return PRAYER_ORDER.filter((n) => all[n]).map((n) => ({
    name: n,
    time: all[n],
    ts: parseTimeToday(all[n], base),
  }));
}

// First prayer after fromTs; rolls over to tomorrow's Fajr when the day is done.
export function computeNext(prayers, fromTs) {
  for (const p of prayers) {
    if (p.ts > fromTs) return { name: p.name, time: p.time, ts: p.ts };
  }
  const fajr = (prayers || []).find((p) => p.name === 'Fajr');
  return fajr ? { name: 'Fajr', time: fajr.time, ts: fajr.ts + DAY_MS } : null;
}

// Human countdown: "3h 12m" / "5m 30s" / "45s". Clamps negatives to 0.
export function formatCountdown(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}
