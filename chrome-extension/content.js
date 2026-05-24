// Adhan Caster Pro — content script (runs in every frame).
// Top visible frame: renders the bottom-right T-15s countdown overlay, the
// "media paused" card, and (opt-in) the full-screen prayer focus overlay.
// Every frame: pauses/resumes its own <video>/<audio> when prayer time hits.

(() => {
  const DEFAULT_LEAD_SECONDS = 30; // heads-up window before Adhan (configurable)
  const isTop = window.top === window;

  let state = { settings: null, nextPrayer: null, paused: { active: false } };
  let localPaused = false;
  let pausedEls = [];
  let currentPrayer = null;
  let lastHandledTs = 0;

  // ---- UI (shadow DOM, top frame only) ----
  let host = null;
  let els = null;
  let fhost = null; // full-screen prayer-focus overlay
  let fels = null;
  let focusLocked = false;

  function fmtMMSS(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Freeze page scrolling while the focus overlay is up.
  function lockScroll(on) {
    if (on === focusLocked) return;
    focusLocked = on;
    try {
      const el = document.documentElement;
      if (on) {
        el.dataset.adhanPrevOverflow = el.style.overflow || '';
        el.style.setProperty('overflow', 'hidden', 'important');
      } else {
        el.style.overflow = el.dataset.adhanPrevOverflow || '';
        delete el.dataset.adhanPrevOverflow;
      }
    } catch (_) {}
  }

  function ensureUI() {
    if (host || !isTop) return;
    host = document.createElement('div');
    host.id = 'adhan-ccp-host';
    host.style.cssText =
      'position:fixed!important;right:16px!important;bottom:16px!important;top:auto!important;left:auto!important;z-index:2147483647!important;pointer-events:none!important;margin:0!important;padding:0!important;border:0!important;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .card {
          display: flex; align-items: center; gap: 11px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 13px; line-height: 1.3; color: #fff; text-align: left;
          background: linear-gradient(135deg, #0f8a5f, #0a5c47);
          padding: 11px 13px; border-radius: 13px; min-width: 192px; max-width: 300px;
          box-shadow: 0 10px 30px rgba(0,0,0,.30); border: 1px solid rgba(255,255,255,.15);
          pointer-events: none; opacity: 0; transform: translateY(8px);
          transition: opacity .22s ease, transform .22s ease;
        }
        .card.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
        .card.paused { background: linear-gradient(135deg, #b4521f, #7c3312); }
        .icon { font-size: 22px; line-height: 1; flex: 0 0 auto; }
        .body { flex: 1 1 auto; min-width: 0; }
        .title { font-weight: 700; font-size: 13px; letter-spacing: .2px; }
        .sub { font-size: 12px; opacity: .92; margin-top: 1px; }
        .bar { height: 3px; border-radius: 3px; background: rgba(255,255,255,.25); margin-top: 7px; overflow: hidden; }
        .bar > i { display: block; height: 100%; width: 100%; background: #fff; border-radius: 3px; transition: width .9s linear; }
        .resume {
          flex: 0 0 auto; font: 600 12px/1 inherit; color: #7c3312; background: #fff;
          border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer;
        }
        .resume:hover { background: #ffe9dc; }
        .pulse { animation: pulse 1s ease-in-out infinite; }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .55 } }
      </style>
      <div class="card" id="card">
        <div class="icon" id="icon">🕌</div>
        <div class="body">
          <div class="title" id="title">Prayer</div>
          <div class="sub" id="sub"></div>
          <div class="bar" id="bar"><i id="barfill"></i></div>
        </div>
        <button class="resume" id="resume" hidden>Resume</button>
      </div>`;
    (document.documentElement || document.body).appendChild(host);
    els = {
      card: root.querySelector('#card'),
      icon: root.querySelector('#icon'),
      title: root.querySelector('#title'),
      sub: root.querySelector('#sub'),
      bar: root.querySelector('#bar'),
      barfill: root.querySelector('#barfill'),
      resume: root.querySelector('#resume'),
    };
    els.resume.addEventListener('click', onResumeClick);
  }

  function hideUI() {
    if (els) els.card.classList.remove('show');
  }

  function ensureFocusUI() {
    if (fhost || !isTop) return;
    fhost = document.createElement('div');
    fhost.id = 'adhan-ccp-focus-host';
    fhost.style.cssText =
      'position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;margin:0!important;';
    const root = fhost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .scrim {
          position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: radial-gradient(130% 130% at 50% 28%, rgba(15,138,95,.93), rgba(7,48,37,.97));
          -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
          opacity: 0; transition: opacity .28s ease; pointer-events: none;
        }
        .scrim.show { opacity: 1; pointer-events: auto; }
        .panel { text-align: center; color: #fff; padding: 28px; max-width: 460px; }
        .crescent { font-size: 58px; line-height: 1; }
        .ftitle { font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; opacity: .8; margin-top: 16px; }
        .fname { font-size: 42px; font-weight: 800; margin-top: 4px; }
        .ftime { font-size: 17px; opacity: .9; margin-top: 2px; }
        .fmsg { font-size: 14px; opacity: .85; margin-top: 16px; }
        .fauto { font-size: 12px; opacity: .7; margin-top: 18px; font-variant-numeric: tabular-nums; }
        .fresume {
          margin-top: 18px; border: 0; border-radius: 10px; cursor: pointer;
          font: 700 14px/1 inherit; color: #0a5c47; background: #fff; padding: 13px 28px;
        }
        .fresume:hover { background: #eafaf2; }
        .fhint { font-size: 11px; opacity: .6; margin-top: 12px; }
      </style>
      <div class="scrim" id="scrim" role="dialog" aria-modal="true" aria-label="Prayer focus">
        <div class="panel">
          <div class="crescent">🕌</div>
          <div class="ftitle">Time for prayer</div>
          <div class="fname" id="fname">Prayer</div>
          <div class="ftime" id="ftime"></div>
          <div class="fmsg">Media is paused. Take a moment for your prayer.</div>
          <div class="fauto" id="fauto"></div>
          <button class="fresume" id="fresume">Resume</button>
          <div class="fhint">Press Esc to resume</div>
        </div>
      </div>`;
    (document.documentElement || document.body).appendChild(fhost);
    fels = {
      scrim: root.querySelector('#scrim'),
      fname: root.querySelector('#fname'),
      ftime: root.querySelector('#ftime'),
      fauto: root.querySelector('#fauto'),
      fresume: root.querySelector('#fresume'),
    };
    fels.fresume.addEventListener('click', onFocusResume);
  }

  function hideFocusUI() {
    if (fels) fels.scrim.classList.remove('show');
    lockScroll(false);
  }

  function onFocusResume() {
    resumeMedia();
    state.paused = { active: false };
    hideFocusUI();
    render();
    chrome.runtime.sendMessage({ type: 'RESUME_NOW' }).catch(() => {});
  }

  function render() {
    if (!isTop) return;
    const now = Date.now();
    const np = state.nextPrayer;
    const isPaused = localPaused || (state.paused && state.paused.active);
    const wantFocus = !!(isPaused && state.paused && state.paused.focus);
    const isTest = !!(np && np.test);
    const leadSecs = (state.settings && state.settings.leadSeconds) || DEFAULT_LEAD_SECONDS;
    const windowMs = isTest ? 31000 : leadSecs * 1000;
    const maxSecs = isTest ? 30 : leadSecs;

    let mode = 'hidden';
    let secs = 0;
    if (wantFocus) {
      mode = 'focus';
    } else if (isPaused) {
      mode = 'paused';
    } else if (np && np.ts - now <= windowMs && np.ts - now > -1500) {
      mode = 'countdown';
      secs = Math.max(0, Math.ceil((np.ts - now) / 1000));
    }

    // Full-screen focus overlay (takes precedence over the corner card).
    if (mode === 'focus' && !document.hidden) {
      hideUI();
      ensureFocusUI();
      fels.fname.textContent = (state.paused && state.paused.prayer) || (np && np.name) || 'Prayer';
      fels.ftime.textContent = (state.paused && state.paused.time) || '';
      const mins = state.settings && state.settings.autoResumeMinutes;
      const since = state.paused && state.paused.since;
      const rem = mins != null && since ? since + mins * 60000 - now : -1;
      fels.fauto.textContent = rem > 0 ? `Auto-resumes in ${fmtMMSS(rem)}` : '';
      fels.scrim.classList.add('show');
      lockScroll(true);
      return;
    }
    hideFocusUI();

    if (mode === 'hidden' || mode === 'focus' || document.hidden) {
      hideUI();
      return;
    }
    ensureUI();

    if (mode === 'paused') {
      const name = currentPrayer || (state.paused && state.paused.prayer) || (np && np.name) || 'Prayer';
      const mins = state.settings && state.settings.autoResumeMinutes;
      const since = state.paused && state.paused.since;
      const rem = mins && since ? since + mins * 60000 - now : -1;
      els.card.classList.add('paused');
      els.icon.textContent = '🕌';
      els.title.textContent = name;
      els.sub.textContent = rem > 0 ? `Auto-resumes in ${fmtMMSS(rem)}` : 'Adhan time · media paused';
      els.sub.classList.remove('pulse');
      els.bar.style.display = 'none';
      els.resume.hidden = false;
    } else {
      els.card.classList.remove('paused');
      els.icon.textContent = '🕌';
      els.title.textContent = `${np.name} Adhan`;
      els.sub.textContent = secs > 0 ? `Starting in ${secs}s` : 'Starting now…';
      els.sub.classList.toggle('pulse', secs <= 0);
      els.bar.style.display = '';
      els.barfill.style.width = `${Math.min(100, (secs / maxSecs) * 100)}%`;
      els.resume.hidden = true;
    }
    els.card.classList.add('show');
  }

  // ---- media control (every frame) ----
  function pauseMediaFor(prayerName) {
    if (localPaused) return;
    const media = document.querySelectorAll('video, audio');
    pausedEls = [];
    media.forEach((el) => {
      if (!el.paused && !el.ended) {
        try {
          el.pause();
          pausedEls.push(el);
        } catch (_) {}
      }
    });
    localPaused = true;
    currentPrayer = prayerName || currentPrayer;
  }

  function resumeMedia() {
    if (!localPaused) return;
    pausedEls.forEach((el) => {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });
    pausedEls = [];
    localPaused = false;
  }

  function onResumeClick() {
    resumeMedia();
    state.paused = { active: false }; // optimistic; background confirms
    render();
    chrome.runtime.sendMessage({ type: 'RESUME_NOW' }).catch(() => {});
  }

  // ---- ticking + sync ----
  function tick() {
    const now = Date.now();
    const np = state.nextPrayer;
    const alreadyPaused = localPaused || (state.paused && state.paused.active);
    // Second-accurate fallback in case the background alarm/message is delayed.
    if (!alreadyPaused && np && now >= np.ts && now - np.ts < 90000 && lastHandledTs !== np.ts) {
      lastHandledTs = np.ts;
      pauseMediaFor(np.name);
      // Carry focus intent from settings so the full-screen focus takes over
      // immediately, without the corner "Resume" card flashing first.
      const focus = !!(state.settings && state.settings.focusMode);
      state.paused = { active: true, prayer: np.name, time: np.time, focus, since: now };
    }
    render();
  }

  function loadState() {
    chrome.storage.local.get(['settings', 'nextPrayer', 'paused'], (data) => {
      state.settings = data.settings || null;
      state.nextPrayer = data.nextPrayer || null;
      state.paused = data.paused || { active: false };
      render();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.nextPrayer) state.nextPrayer = changes.nextPrayer.newValue || null;
    if (changes.settings) state.settings = changes.settings.newValue || null;
    if (changes.paused) {
      state.paused = changes.paused.newValue || { active: false };
      if (state.paused.active && !localPaused) pauseMediaFor(state.paused.prayer);
      else if (!state.paused.active && localPaused) resumeMedia();
      if (!state.paused.active) hideFocusUI();
    }
    render();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'PRAYER_NOW') {
      pauseMediaFor(msg.prayer);
      state.paused = { active: true, prayer: msg.prayer, time: msg.time, focus: !!msg.focus, since: msg.since };
      render();
    } else if (msg.type === 'FOCUS_ON') {
      const prev = state.paused || {};
      state.paused = {
        active: true,
        prayer: msg.prayer || prev.prayer,
        time: msg.time || prev.time,
        focus: true,
        since: msg.since || prev.since,
      };
      render();
    } else if (msg.type === 'FOCUS_OFF') {
      if (state.paused) state.paused.focus = false;
      hideFocusUI();
      render();
    } else if (msg.type === 'RESUME') {
      resumeMedia();
      state.paused = { active: false };
      hideFocusUI();
      render();
    }
  });

  document.addEventListener('visibilitychange', render);

  if (isTop) {
    const blockScroll = (e) => {
      if (focusLocked && !document.hidden) e.preventDefault();
    };
    window.addEventListener('wheel', blockScroll, { passive: false, capture: true });
    window.addEventListener('touchmove', blockScroll, { passive: false, capture: true });
    window.addEventListener(
      'keydown',
      (e) => {
        if (!focusLocked || document.hidden) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          onFocusResume();
        } else if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar'].includes(e.key)) {
          e.preventDefault();
        }
      },
      { capture: true }
    );
  }

  loadState();
  setInterval(tick, 1000);
})();
