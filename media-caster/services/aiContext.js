const fs = require('fs');
const { DateTime } = require('luxon');

const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

function getDayEntry(scheduleFilePath, day) {
  const annual = JSON.parse(fs.readFileSync(scheduleFilePath, 'utf8'));
  const monthData = annual && annual.data && annual.data[day.month.toString()];
  return Array.isArray(monthData)
    ? monthData.find((d) => parseInt(d && d.date && d.date.gregorian && d.date.gregorian.day, 10) === day.day)
    : null;
}

function parsePrayerTimes(entry, day) {
  const out = [];
  if (!entry || !entry.timings) return out;
  for (const p of PRAYERS) {
    const t = String(entry.timings[p] || '').split(' ')[0];
    const [h, m] = t.split(':').map((x) => parseInt(x, 10));
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    out.push({ prayer: p, time: t, dt: day.set({ hour: h, minute: m, second: 0, millisecond: 0 }) });
  }
  return out;
}

// The next prayer (rolling into tomorrow's Fajr after Isha). Pure computation —
// used both for the deterministic /api/ask fallback and inside the LLM context.
function getNextPrayer(scheduleFilePath, timezone) {
  const now = DateTime.now().setZone(timezone);
  try {
    const times = parsePrayerTimes(getDayEntry(scheduleFilePath, now), now);
    const upcoming = times.find((t) => t.dt > now);
    if (upcoming) {
      return { prayer: upcoming.prayer, time: upcoming.time, minutesUntil: Math.round(upcoming.dt.diff(now, 'minutes').minutes), tomorrow: false };
    }
    const tomorrow = now.plus({ days: 1 });
    const tTimes = parsePrayerTimes(getDayEntry(scheduleFilePath, tomorrow), tomorrow);
    const fajr = tTimes.find((t) => t.prayer === 'Fajr');
    if (fajr) {
      return { prayer: 'Fajr', time: fajr.time, minutesUntil: Math.round(fajr.dt.diff(now, 'minutes').minutes), tomorrow: true };
    }
  } catch {
    /* schedule unreadable */
  }
  return null;
}

function humanizeMinutes(mins) {
  if (!Number.isFinite(mins)) return 'unknown';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Pre-computed, explicit "time until each prayer" so the 1B model never has to
// do clock arithmetic (it's bad at it and otherwise reuses the next-prayer
// figure for the wrong prayer). For prayers already finished today, it rolls to
// tomorrow's same prayer.
function buildUpcomingList(scheduleFilePath, timezone) {
  const now = DateTime.now().setZone(timezone);
  let today;
  let tomorrow;
  try {
    today = parsePrayerTimes(getDayEntry(scheduleFilePath, now), now);
    const tdt = now.plus({ days: 1 });
    tomorrow = parsePrayerTimes(getDayEntry(scheduleFilePath, tdt), tdt);
  } catch {
    return [];
  }
  const tmap = {};
  for (const t of tomorrow) tmap[t.prayer] = t;
  const out = [];
  for (const t of today) {
    if (t.dt > now) {
      out.push(`${t.prayer} ${t.time} → in ${humanizeMinutes(Math.round(t.dt.diff(now, 'minutes').minutes))}`);
    } else {
      const tm = tmap[t.prayer];
      out.push(
        tm
          ? `${t.prayer} finished today → next ${tm.time} tomorrow, in ${humanizeMinutes(Math.round(tm.dt.diff(now, 'minutes').minutes))}`
          : `${t.prayer} finished today`,
      );
    }
  }
  return out;
}

// Compact plain-text snapshot of system status, fed to Gemma as grounding so it
// never invents times. Reuses PlaybackLogger query methods for today's results.
function buildStatusContext(scheduleFilePath, timezone, playbackLogger) {
  const now = DateTime.now().setZone(timezone);
  const lines = [`Current local time: ${now.toFormat('cccc, LLL d yyyy, h:mm a')} (${timezone}).`];

  let entry = null;
  let times = [];
  try {
    entry = getDayEntry(scheduleFilePath, now);
    times = parsePrayerTimes(entry, now);
  } catch {
    /* ignore */
  }

  if (entry && entry.date && entry.date.hijri) {
    const h = entry.date.hijri;
    lines.push(`Hijri date: ${h.day} ${h.month.en} ${h.year}.`);
  }
  if (times.length) {
    lines.push(`Today's prayer times: ${times.map((t) => `${t.prayer} ${t.time}`).join(', ')}.`);
  }

  const next = getNextPrayer(scheduleFilePath, timezone);
  if (next) {
    lines.push(`Next prayer: ${next.prayer} at ${next.time}${next.tomorrow ? ' (tomorrow)' : ''}, in ${humanizeMinutes(next.minutesUntil)}.`);
  }

  const upcoming = buildUpcomingList(scheduleFilePath, timezone);
  if (upcoming.length) {
    lines.push(`Time until each prayer (already computed — use these exact values): ${upcoming.join('; ')}.`);
  }

  if (playbackLogger) {
    try {
      const stats = playbackLogger.getDailyStats(now.toISODate());
      const perPrayer = Object.entries(stats.prayers || {})
        .map(([p, v]) => `${p}=${v.status}`)
        .join(', ');
      lines.push(
        `Today's playback: ${stats.played} played, ${stats.recovered} recovered, ${stats.failed} failed, ${stats.pending} pending${perPrayer ? ` (${perPrayer})` : ''}.`,
      );
      const diagnosed = (playbackLogger.getTodayEvents() || []).filter((e) => e.aiDiagnosis);
      for (const e of diagnosed) {
        lines.push(`Diagnosis for ${e.prayer} (${e.failureReason || 'failure'}): ${e.aiDiagnosis}`);
      }
    } catch {
      /* ignore */
    }
  }

  return lines.join('\n');
}

module.exports = { buildStatusContext, getNextPrayer, buildUpcomingList, humanizeMinutes, PRAYERS };
