// ===========================================================================
// Adhan — Next Prayer  ·  iPhone Home-Screen widget (Scriptable)
// ===========================================================================
//
// A REAL Home-Screen widget (not just an icon) showing the next prayer and a
// live countdown, fed by your authoritative Firestore schedule
// (meta/prayerSchedule in project adhan-79908 — the same data your dashboard
// uses, already in your timezone). A web page added to the Home Screen can
// only ever be an icon on iOS; Scriptable supplies the native WidgetKit host
// that makes a true widget possible.
//
// INSTALL (one time):
//   1. Install "Scriptable" from the App Store (free).
//   2. Open Scriptable → tap "+" → paste this whole file → name it
//      "Adhan Next Prayer" → Done. Tap ▶ once to confirm it previews.
//   3. Home Screen → long-press empty area → "+" → search "Scriptable" →
//      pick Small or Medium → Add Widget.
//   4. Long-press the new widget → "Edit Widget" → Script: "Adhan Next Prayer".
//
// NOTE: iOS controls how often the script re-runs (~every 15–60 min). The
// countdown stays smooth between runs because it is rendered with an
// OS-animated timer (addDate + applyTimerStyle), not redrawn text.
// ===========================================================================

const PROJECT = "adhan-79908";
const API_KEY = "AIzaSyCmxmrW4uXjA7RxrQhDzOugy8GjILIexWs"; // public Firestore web key
const DOC_URL =
  `https://firestore.googleapis.com/v1/projects/${PROJECT}` +
  `/databases/(default)/documents/meta/prayerSchedule?key=${API_KEY}`;

const ORDER = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
const GREEN_TOP = new Color("#1f8a5b");
const GREEN_BOT = new Color("#0b6b43");
const WHITE = new Color("#ffffff");
const DIM = new Color("#cdeadd");

async function loadSchedule() {
  const req = new Request(DOC_URL);
  req.timeoutInterval = 15;
  const data = await req.loadJSON();
  const f = (data && data.fields) || {};
  const mapTimes = (node) => {
    const out = {};
    const fields = node && node.mapValue && node.mapValue.fields ? node.mapValue.fields : {};
    for (const p of ORDER) if (fields[p]) out[p] = fields[p].stringValue;
    return out;
  };
  let nextDay = null;
  if (f.nextDay && f.nextDay.mapValue) {
    const nf = f.nextDay.mapValue.fields || {};
    nextDay = { date: nf.date && nf.date.stringValue, times: mapTimes(nf.times) };
  }
  return {
    date: f.date && f.date.stringValue,
    timezone: f.timezone && f.timezone.stringValue,
    times: mapTimes(f.times),
    nextDay,
  };
}

// Build a Date for an HH:mm clock time today (+dayOffset), in device-local time.
// Assumes the phone shares the schedule's timezone (true for personal use).
function dateAt(hhmm, dayOffset = 0) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
}

function computeNext(sched) {
  const now = new Date();
  for (const p of ORDER) {
    if (!sched.times[p]) continue;
    const t = dateAt(sched.times[p]);
    if (t.getTime() > now.getTime()) return { name: p, date: t, tomorrow: false };
  }
  const fajr = (sched.nextDay && sched.nextDay.times && sched.nextDay.times.Fajr) || sched.times.Fajr;
  return { name: "Fajr", date: dateAt(fajr, 1), tomorrow: true };
}

function fmt12(date) {
  let h = date.getHours();
  const m = String(date.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

function buildWidget(sched, next, family) {
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [GREEN_TOP, GREEN_BOT];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(14, 16, 14, 16);

  const header = w.addText("☾  NEXT PRAYER");
  header.font = Font.semiboldSystemFont(10);
  header.textColor = DIM;
  w.addSpacer(4);

  const name = w.addText(next.name + (next.tomorrow ? "  (tomorrow)" : ""));
  name.font = Font.boldSystemFont(family === "small" ? 22 : 26);
  name.textColor = WHITE;

  const at = w.addText(fmt12(next.date));
  at.font = Font.mediumSystemFont(13);
  at.textColor = DIM;

  w.addSpacer(6);

  // OS-animated countdown — ticks every second without the script re-running.
  const timer = w.addDate(next.date);
  timer.applyTimerStyle();
  timer.font = Font.boldSystemFont(family === "small" ? 26 : 32);
  timer.textColor = WHITE;

  if (family !== "small") {
    w.addSpacer(10);
    for (const p of ORDER) {
      if (!sched.times[p]) continue;
      const row = w.addStack();
      row.layoutHorizontally();
      const isNext = p === next.name && !next.tomorrow;
      const lbl = row.addText(p);
      lbl.font = isNext ? Font.semiboldSystemFont(13) : Font.systemFont(13);
      lbl.textColor = isNext ? WHITE : DIM;
      row.addSpacer();
      const tv = row.addText(fmt12(dateAt(sched.times[p])));
      tv.font = isNext ? Font.semiboldSystemFont(13) : Font.systemFont(13);
      tv.textColor = isNext ? WHITE : DIM;
      w.addSpacer(2);
    }
  }

  // Ask iOS to re-run by the next prayer (rolls over), or within ~15 min.
  const soon = Date.now() + 15 * 60 * 1000;
  w.refreshAfterDate = new Date(Math.min(next.date.getTime(), soon));
  return w;
}

function errorWidget(message) {
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [GREEN_TOP, GREEN_BOT];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(16, 16, 16, 16);
  const t = w.addText("Adhan");
  t.font = Font.boldSystemFont(18);
  t.textColor = WHITE;
  w.addSpacer(6);
  const e = w.addText(message);
  e.font = Font.systemFont(12);
  e.textColor = DIM;
  w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);
  return w;
}

async function main() {
  let widget;
  try {
    const sched = await loadSchedule();
    if (!sched.times || Object.keys(sched.times).length === 0) {
      widget = errorWidget("No schedule available yet.");
    } else {
      const family = config.widgetFamily || "medium";
      widget = buildWidget(sched, computeNext(sched), family);
    }
  } catch (err) {
    widget = errorWidget("Couldn’t load prayer times.\n" + (err && err.message ? err.message : ""));
  }

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentMedium();
  }
  Script.complete();
}

main();
