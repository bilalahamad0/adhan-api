// Adhan Caster Pro — popup UI logic.
import { formatCountdown } from './lib/schedule.js';
import { searchPlaces } from './lib/geocode.js';

const $ = (id) => document.getElementById(id);
let st = null;
let tickTimer = null;

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

// ---- location search (Open-Meteo geocoding) ----
// One field resolves city + state/province + country from a real place.
let selectedPlace = null; // {city,state,country,lat,lon,label} or null until a real place is picked
let searchTimer = null;
let searchAbort = null;

function placeLabel(p) {
  return [p.city, p.state, p.country].filter(Boolean).join(', ');
}

function renderCityResults(items) {
  const box = $('cityResults');
  box.innerHTML = '';
  if (!items.length) {
    box.hidden = true;
    return;
  }
  for (const p of items) {
    const div = document.createElement('div');
    div.className = 'suggest-item';
    div.textContent = p.label;
    div.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus so blur doesn't close before the click
      choosePlace(p);
    });
    box.appendChild(div);
  }
  box.hidden = false;
}

function choosePlace(p) {
  selectedPlace = p;
  $('city').value = p.label;
  $('locLabel').textContent = p.label;
  $('cityResults').hidden = true;
}

async function doCitySearch() {
  const q = $('city').value;
  selectedPlace = null; // typing invalidates a prior pick (forces re-validation)
  if (q.trim().length < 2) {
    $('cityResults').hidden = true;
    return;
  }
  try {
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    const items = await searchPlaces(q, { signal: searchAbort.signal });
    renderCityResults(items.slice(0, 8));
  } catch (_) {
    /* aborted or offline — leave prior results */
  }
}

async function load() {
  st = await send({ type: 'GET_STATE' });
  renderAll();
}

function renderAll() {
  if (!st) return;
  const { settings, schedule, nextPrayer, paused } = st;

  $('enabled').checked = settings.enabled !== false;
  $('focusMode').checked = settings.focusMode === true;
  // Treat the saved location as already selected so Save works without re-picking.
  const place = settings.city
    ? {
        city: settings.city,
        state: settings.state || '',
        country: settings.country || '',
        lat: settings.lat,
        lon: settings.lon,
      }
    : null;
  if (place) place.label = placeLabel(place);
  selectedPlace = place;
  $('city').value = place ? place.label : '';
  $('resumeMin').value = settings.autoResumeMinutes != null ? settings.autoResumeMinutes : 5;
  $('leadSeconds').value = String(settings.leadSeconds || 30);
  $('locLabel').textContent = place ? place.label : '—';

  if (paused && paused.active) {
    $('pausedBanner').hidden = false;
    $('pausedText').textContent = `Media paused for ${paused.prayer || 'prayer'}`;
    $('focusBtn').hidden = paused.focus === true;
  } else {
    $('pausedBanner').hidden = true;
  }

  renderNext();
  renderList();

  $('updated').textContent =
    schedule && schedule.fetchedAt
      ? 'Updated ' + new Date(schedule.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
}

function renderNext() {
  const np = st.nextPrayer;
  if (!np) {
    $('nextName').textContent = '—';
    $('nextTime').textContent = 'No schedule';
    $('nextCountdown').textContent = '';
    return;
  }
  $('nextName').textContent = np.name;
  $('nextTime').textContent = np.time;
  $('nextCountdown').textContent = 'in ' + formatCountdown(np.ts - Date.now());
}

function renderList() {
  const wrap = $('list');
  wrap.innerHTML = '';
  const sched = st.schedule;
  if (!sched || !sched.prayers) return;
  const now = Date.now();
  const nextName = st.nextPrayer && st.nextPrayer.name;
  sched.prayers.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'row';
    const past = p.ts < now;
    if (past) row.classList.add('past');
    if (p.name === nextName) row.classList.add('next');
    const tomorrow = p.name === nextName && past;
    const pname = document.createElement('span');
    pname.className = 'pname';
    pname.textContent = p.name;
    const ptime = document.createElement('span');
    ptime.className = 'ptime';
    ptime.textContent = p.time;
    if (tomorrow) {
      const em = document.createElement('em');
      em.textContent = 'tomorrow';
      ptime.appendChild(document.createTextNode(' '));
      ptime.appendChild(em);
    }
    row.appendChild(pname);
    row.appendChild(ptime);
    wrap.appendChild(row);
  });
}

function startTick() {
  stopTick();
  tickTimer = setInterval(() => {
    if (st && st.nextPrayer) {
      $('nextCountdown').textContent = 'in ' + formatCountdown(st.nextPrayer.ts - Date.now());
    }
  }, 1000);
}
function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
}

$('resumeBtn').addEventListener('click', async () => {
  await send({ type: 'RESUME_NOW' });
  await load();
});

$('focusBtn').addEventListener('click', async () => {
  await send({ type: 'FOCUS_NOW' });
  await load();
});

$('testBtn').addEventListener('click', async () => {
  $('testMsg').textContent = '';
  const res = await send({ type: 'TEST_ADHAN', seconds: 30 });
  if (res && res.ok) {
    $('testMsg').textContent = 'Adhan in 30s — switch to a tab with media';
    setTimeout(() => ($('testMsg').textContent = ''), 6000);
  } else {
    $('testMsg').textContent = (res && res.error) || 'Unavailable';
  }
});

$('save').addEventListener('click', async () => {
  // Require a real, geocoded place — blocks invalid combos like "Sunnyvale, Morocco".
  if (!selectedPlace || $('city').value.trim() !== selectedPlace.label) {
    $('saveMsg').textContent = 'Pick a location from the suggestions';
    $('city').focus();
    setTimeout(() => ($('saveMsg').textContent = ''), 3000);
    return;
  }
  const settings = {
    enabled: $('enabled').checked,
    focusMode: $('focusMode').checked,
    country: selectedPlace.country || 'United States',
    state: selectedPlace.state || '',
    city: selectedPlace.city,
    lat: selectedPlace.lat,
    lon: selectedPlace.lon,
    autoResumeMinutes: Math.max(0, parseInt($('resumeMin').value, 10) || 5),
    leadSeconds: parseInt($('leadSeconds').value, 10) || 30,
  };
  $('save').disabled = true;
  $('save').textContent = 'Saving…';
  const res = await send({ type: 'SAVE_SETTINGS', settings });
  $('save').disabled = false;
  $('save').textContent = 'Save';
  if (res && res.ok) {
    $('saveMsg').textContent = 'Saved';
    await load();
  } else {
    $('saveMsg').textContent = res && res.error ? 'Error: ' + res.error : 'Error';
  }
  setTimeout(() => ($('saveMsg').textContent = ''), 2500);
});

$('gear').addEventListener('click', () => {
  $('settings').hidden = !$('settings').hidden;
});

$('refresh').addEventListener('click', async (e) => {
  e.preventDefault();
  $('refresh').textContent = 'Refreshing…';
  await send({ type: 'REFRESH' });
  await load();
  $('refresh').textContent = 'Refresh';
});

// The Test Adhan trigger is a dev-only affordance; hidden in store-installed builds.
try {
  document.querySelector('.dev-row').hidden = 'update_url' in chrome.runtime.getManifest();
} catch (_) {}

// Debounced location autocomplete (Open-Meteo geocoding).
$('city').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doCitySearch, 300);
});
$('city').addEventListener('focus', (e) => {
  e.target.select(); // select the resolved label so typing replaces it
  if ($('cityResults').children.length) $('cityResults').hidden = false;
});
$('city').addEventListener('blur', () => setTimeout(() => ($('cityResults').hidden = true), 150));

load().then(startTick);
