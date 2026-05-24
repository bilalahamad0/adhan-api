// Adhan Caster Pro — background service worker (MV3)
// Fetches the prayer schedule, fires the desktop notification + cross-tab media
// pause at prayer time, and arms auto-resume. The per-second T-15 countdown and
// the actual pausing/resuming of <video>/<audio> happen in content.js.

import { ymd, computeNext, buildPrayers } from './lib/schedule.js';

const API_BASE = 'https://adhan-api-mauve.vercel.app/api/prayerTimes';

const DEFAULT_SETTINGS = {
  enabled: true,
  country: 'United States',
  state: 'California',
  city: 'Sunnyvale',
  autoResumeMinutes: 5,
  leadSeconds: 30,
  focusMode: false,
};

const ALARM_PRAYER = 'adhan-prayer-fire';
const ALARM_RESUME = 'adhan-auto-resume';
const ALARM_TICK = 'adhan-tick';

// Store-installed builds get an `update_url` injected into the manifest;
// unpacked/dev builds do not. Used to keep the test trigger out of production.
function isDevBuild() {
  try {
    return !('update_url' in chrome.runtime.getManifest());
  } catch (_) {
    return false;
  }
}

// ---------- storage helpers ----------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function getState() {
  const data = await chrome.storage.local.get(['settings', 'schedule', 'nextPrayer', 'paused']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    schedule: data.schedule || null,
    nextPrayer: data.nextPrayer || null,
    paused: data.paused || { active: false },
  };
}

// ---------- schedule fetch ----------
async function fetchAndStoreSchedule() {
  const settings = await getSettings();
  let url = `${API_BASE}?country=${encodeURIComponent(settings.country)}&city=${encodeURIComponent(settings.city)}`;
  if (settings.state) url += `&state=${encodeURIComponent(settings.state)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  const base = new Date();
  const prayers = buildPrayers(data.all_prayers, base);
  const schedule = { date: ymd(base), prayers, fetchedAt: Date.now() };
  const nextPrayer = computeNext(prayers, Date.now());
  await chrome.storage.local.set({ schedule, nextPrayer });
  return { schedule, nextPrayer };
}

// Recompute "next" from the stored schedule; refetch if the day rolled over.
async function refreshNext() {
  const { schedule } = await chrome.storage.local.get('schedule');
  if (!schedule || schedule.date !== ymd()) {
    return fetchAndStoreSchedule();
  }
  const nextPrayer = computeNext(schedule.prayers, Date.now());
  await chrome.storage.local.set({ nextPrayer });
  return { schedule, nextPrayer };
}

// ---------- alarms ----------
async function armAlarms() {
  const { settings, nextPrayer } = await getState();
  await chrome.alarms.clear(ALARM_PRAYER);
  if (settings.enabled && nextPrayer) {
    chrome.alarms.create(ALARM_PRAYER, { when: Math.max(Date.now() + 500, nextPrayer.ts) });
  }
  // Self-healing heartbeat: recompute / refetch and re-arm periodically.
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 15 });
}

// ---------- broadcast to tabs ----------
async function broadcast(message) {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map((t) =>
      t.id != null ? chrome.tabs.sendMessage(t.id, message).catch(() => {}) : Promise.resolve()
    )
  );
}

async function setPausedBadge(on) {
  try {
    await chrome.action.setBadgeText({ text: on ? '❚❚' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ color: '#0b6b43' });
  } catch (_) {}
}

// ---------- prayer / resume handlers ----------
async function handlePrayerFire() {
  const { settings, nextPrayer } = await getState();
  if (!settings.enabled || !nextPrayer) return;

  const firedTs = nextPrayer.ts;
  const focus = settings.focusMode === true;
  const paused = { active: true, prayer: nextPrayer.name, time: nextPrayer.time, since: Date.now(), focus };
  await chrome.storage.local.set({ paused });

  try {
    await chrome.notifications.create(`adhan-${firedTs}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `🕌 ${nextPrayer.name} — Adhan time`,
      message: `It's time for ${nextPrayer.name} (${nextPrayer.time}). Media has been paused across your tabs.`,
      priority: 2,
      buttons: [{ title: 'Prayer focus' }, { title: 'Resume now' }],
    });
  } catch (_) {}

  await broadcast({ type: 'PRAYER_NOW', prayer: nextPrayer.name, time: nextPrayer.time, focus, since: paused.since });
  await setPausedBadge(true);

  // Arm auto-resume.
  chrome.alarms.create(ALARM_RESUME, { when: Date.now() + settings.autoResumeMinutes * 60 * 1000 });

  // Advance to the following prayer and re-arm.
  const { schedule } = await chrome.storage.local.get('schedule');
  if (schedule) {
    const next = computeNext(schedule.prayers, firedTs + 1000);
    await chrome.storage.local.set({ nextPrayer: next });
  }
  await armAlarms();
}

async function handleAutoResume() {
  const { paused } = await getState();
  if (!paused.active) return;
  await chrome.storage.local.set({ paused: { active: false } });
  await broadcast({ type: 'RESUME' });
  await setPausedBadge(false);
}

async function resumeNow() {
  await chrome.alarms.clear(ALARM_RESUME);
  await chrome.storage.local.set({ paused: { active: false } });
  await broadcast({ type: 'RESUME' });
  await setPausedBadge(false);
}

async function enableFocus() {
  const { paused } = await getState();
  if (!paused.active) return;
  await chrome.storage.local.set({ paused: { ...paused, focus: true } });
  await broadcast({ type: 'FOCUS_ON', prayer: paused.prayer, time: paused.time, since: paused.since });
}

async function disableFocus() {
  const { paused } = await getState();
  if (!paused.active) return;
  await chrome.storage.local.set({ paused: { ...paused, focus: false } });
  await broadcast({ type: 'FOCUS_OFF' });
}

async function toggleFocus() {
  const { paused } = await getState();
  if (!paused.active) return;
  if (paused.focus) await disableFocus();
  else await enableFocus();
}

// Dev/preview: fire a simulated Adhan after a short delay so the full flow
// (countdown → cross-tab pause → focus → auto-resume) can be seen on demand.
// 30s minimum because chrome.alarms clamps shorter delays, which made the
// notification appear to "not fire".
async function testAdhan(seconds = 30) {
  const { nextPrayer } = await getState();
  const ts = Date.now() + seconds * 1000;
  const name = (nextPrayer && nextPrayer.name) || 'Test';
  const time = new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  await chrome.storage.local.set({ nextPrayer: { name, time, ts, test: true } });
  chrome.alarms.create(ALARM_PRAYER, { when: ts });
}

// ---------- inject into already-open tabs (new installs) ----------
async function injectExistingTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    if (t.id == null) continue;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: t.id, allFrames: true }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content.js'] });
    } catch (_) {
      // restricted pages (chrome://, web store, PDF viewer, etc.) — ignore
    }
  }
}

// ---------- event wiring ----------
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await chrome.storage.local.set({ paused: { active: false } });
  try {
    await fetchAndStoreSchedule();
  } catch (e) {
    console.warn('Adhan: initial schedule fetch failed', e);
  }
  await armAlarms();
  await injectExistingTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await refreshNext();
  } catch (e) {
    console.warn('Adhan: startup refresh failed', e);
  }
  await armAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_PRAYER) handlePrayerFire();
  else if (alarm.name === ALARM_RESUME) handleAutoResume();
  else if (alarm.name === ALARM_TICK) {
    refreshNext()
      .then(armAlarms)
      .catch((e) => console.warn('Adhan: tick failed', e));
  }
});

chrome.notifications.onClicked.addListener(() => {
  chrome.action.openPopup?.().catch(() => {});
});

chrome.notifications.onButtonClicked.addListener((_id, btnIdx) => {
  if (btnIdx === 0) enableFocus();
  else if (btnIdx === 1) resumeNow();
});

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((cmd) => {
    if (cmd === 'toggle-focus') toggleFocus();
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'GET_STATE':
        sendResponse(await getState());
        break;
      case 'RESUME_NOW':
        await resumeNow();
        sendResponse({ ok: true });
        break;
      case 'FOCUS_NOW':
        await enableFocus();
        sendResponse({ ok: true });
        break;
      case 'TEST_ADHAN':
        if (!isDevBuild()) {
          sendResponse({ ok: false, error: 'dev only' });
          break;
        }
        await testAdhan(msg.seconds || 30);
        sendResponse({ ok: true });
        break;
      case 'SAVE_SETTINGS': {
        const current = await getSettings();
        const settings = { ...current, ...(msg.settings || {}) };
        await chrome.storage.local.set({ settings });
        try {
          await fetchAndStoreSchedule();
        } catch (e) {
          await armAlarms();
          sendResponse({ ok: false, error: String(e.message || e) });
          return;
        }
        await armAlarms();
        sendResponse({ ok: true });
        break;
      }
      case 'REFRESH':
        try {
          await fetchAndStoreSchedule();
          await armAlarms();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // async response
});
