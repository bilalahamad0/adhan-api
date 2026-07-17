const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');

class MediaService {
  /**
   * Ensures the MP3 files are cached logically
   */
  async cacheAudioSources(configs, audioDirPath) {
    if (!fs.existsSync(audioDirPath)) fs.mkdirSync(audioDirPath, { recursive: true });

    const downloads = Object.keys(configs.audio.options).map((key) => ({
      name: `${key}.mp3`,
      url: configs.audio.options[key],
    }));

    for (const file of downloads) {
      const filePath = path.join(audioDirPath, file.name);
      if (!fs.existsSync(filePath)) {
        try {
          const response = await axios.get(file.url, { responseType: 'stream' });
          await pipeline(response.data, fs.createWriteStream(filePath));
        } catch (err) {
          // Failure to download is logged but won't crash sync caching completely
          console.error(`MediaService: Cache failed for ${file.name} - ${err.message}`);
        }
      }
    }
  }

  /**
   * Writes image buffer to disk
   */
  writeImageBuffer(filePath, buffer) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buffer);
  }

  /**
   * Encodes a static image and audio into a lopped MP4 video via fluent-ffmpeg
   * Restores Phase 16 High-Fidelity Weather Filters (Rain/Snow/Fog)
   * Returns an object { promise, abort } for timeout management
   */
  encodeVideoFromImageAndAudio(imagePath, audioPath, outputVideoPath, weatherCode = 0) {
    console.log(`🎬 Encoding Video: ${path.basename(outputVideoPath)} (Weather Code: ${weatherCode})...`);
    
    // Select Procedural Weather Filter (from legacy Phase 16 Master Bake)
    let weatherFilter = 'color=black:s=1280x800'; // Default constant black block (Clear)
    
    if (weatherCode >= 51 && weatherCode <= 67) {
        console.log('🌧️  Applying RAIN procedural filter...');
        weatherFilter = 'color=black:s=1280x800,noise=alls=100:allf=t+u,dblur=90:60';
    } else if (weatherCode >= 71 && weatherCode <= 77) {
        console.log('❄️  Applying SNOW procedural filter...');
        weatherFilter = 'color=black:s=1280x800,noise=alls=100:allf=t+u,scale=64:40:flags=neighbor,scale=1280:800:flags=neighbor,gblur=15,setpts=4.0*PTS';
    } else if (weatherCode >= 45 && weatherCode <= 48) {
        console.log('≡  Applying FOG procedural filter...');
        weatherFilter = 'color=black:s=1280x800,noise=alls=100:allf=t+u,scale=32:20:flags=neighbor,scale=1280:800:flags=neighbor,boxblur=50,scroll=h=0.03';
    }

    let command;
    const promise = new Promise((resolve, reject) => {
      command = ffmpeg()
        .input(imagePath)
        .inputOptions(['-loop 1'])
        .input(audioPath)
        .complexFilter([
          '[0:v]scale=1280:800,setsar=1,format=yuv420p[base]',
          `${weatherFilter},format=yuv420p[mask]`,
          '[base][mask]lut2=c0=\'x+y\':c1=\'x\':c2=\'x\',format=yuv420p[v]',
          // 1.5s silent lead-in absorbs Chromecast initial buffering (fixes audio chop + black flash)
          '[1:a]adelay=1500|1500[a]'
        ])
        .outputOptions([
          '-map [v]',
          '-map [a]',
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-preset ultrafast',
          '-profile:v baseline',
          '-level 3.0',
          '-r 10',
          '-g 10',
          '-movflags +faststart',
          '-shortest',
        ])
        .save(outputVideoPath)
        .on('end', () => {
          console.log('✅ Video Encoding Complete.');
          resolve(outputVideoPath);
        })
        .on('error', (err) => {
          if (err.message && err.message.includes('ffmpeg was killed')) {
             console.log('⚠️ Video Encoding Aborted (Timeout).');
             return; // Don't reject if we killed it intentionally
          }
          console.error('❌ Video Encoding Error:', err.message);
          reject(err);
        });
    });

    return {
       promise,
       abort: () => { if (command) command.kill('SIGKILL'); }
    };
  }

  // --- Procedural Morning Clips (Shuruq / Ishraq) -----------------------------
  // Two decorative dawn scenes cast to the display: Sunrise (Shuruq) and, ~20min
  // later, Ishraq — the moment the voluntary Duha prayer becomes permissible.
  // Both are built here and share one composer, one silent audio bed, and one
  // mosque silhouette; only the sky, the sun, and the rise differ. Deliberately
  // shares NO filter lines with encodeVideoFromImageAndAudio above: that graph is
  // on the Adhan critical path and a decorative clip must never touch it.

  static SUNRISE_HORIZON_Y = 596;   // px, where sky meets ground in a 1280x800 frame
  static SUNRISE_FPS = 10;          // same as the Adhan ladder

  /**
   * The clips are SILENT by design. They play in the early morning, when someone
   * may still be asleep, so they must never make a sound — the display lights up,
   * nothing more. The track is silent rather than absent: Cast is happier with an
   * audio stream present, and it keeps the -map/duration handling uniform.
   */
  static SUNRISE_AUDIO =
    'anullsrc=r=44100:cl=stereo,asetnsamples=n=1024:p=0,' +
    'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a]';

  /**
   * Mosque silhouette, shared by both scenes: ground, base, dome, finial, two
   * minarets with caps and spires. Summed terms act as a logical OR inside if().
   * `rgb` lets each scene tint it (darker against a bright daylight sky).
   */
  static _mosqueAlphaExpr() {
    const H = MediaService.SUNRISE_HORIZON_Y;
    return `if(gt(Y,${H})` +
      `+between(X,505,775)*gt(Y,565)` +
      `+lt(hypot(X-640,(Y-565)*1.02),88)*lt(Y,567)` +
      `+between(X,636,644)*between(Y,452,480)` +
      `+lt(hypot(X-640,Y-448),9)` +
      `+between(X,486,502)*gt(Y,430)` +
      `+between(X,778,794)*gt(Y,430)` +
      `+lt(hypot(X-494,(Y-430)*1.2),13)` +
      `+lt(hypot(X-786,(Y-430)*1.2),13)` +
      `+between(X,492,496)*between(Y,406,430)` +
      `+between(X,784,788)*between(Y,406,430)` +
      `,255,0)`;
  }

  /**
   * Scene descriptors. Each returns the sky/sun expressions and the rise geometry
   * for one moment. `sky(H)`/`sun(r)` are functions so the geometry constants stay
   * in one place. `rayRotateRate > 0` slowly spins the sun sprite, which only
   * moves the rays (the core is radially symmetric) — used for Ishraq's radiance.
   */
  static get MORNING_SCENES() {
    return {
      // Shuruq: sun emerges from behind the horizon into a dawn indigo->gold sky.
      sunrise: {
        file: 'sunrise.mp4',
        emoji: '🌅',
        spriteSize: 420,
        yStart: 560, yEnd: 210,
        lead: 1.5, hold: 2.5,
        brightnessGain: 0.07,
        rayRotateRate: 0,
        landRgb: "r='11':g='16':b='32'",
        // Bilingual caption: "Sunrise (Shurūq)" up top in the open sky, Arabic +
        // tagline at the bottom. titleY/titleSize place the top title clear of
        // the risen sun (which for sunrise tops out ~y280, leaving room). `tag`
        // is the default tagline (env-overridable).
        en: 'Sunrise', ar: 'شروق', tr: 'Shurūq', tag: 'A new day begins',
        titleY: 150, titleSize: 88,
        // Dawn gradient, normalised to the HORIZON so the golden band lands at
        // the skyline rather than washing out mid-frame.
        sky: (H) =>
          `r='clip(16+239*pow(min(Y/${H},1),2.4),0,255)':` +
          `g='clip(22+154*pow(min(Y/${H},1),3.1),0,255)':` +
          `b='clip(64+26*pow(min(Y/${H},1),0.5)-74*pow(min(Y/${H},1),3.5),0,255)'`,
        // White-gold core with a quartic alpha falloff to a warm halo.
        sun: (r) =>
          `r='255':` +
          `g='clip(248-118*(hypot(X-${r},Y-${r})/${r}),0,255)':` +
          `b='clip(214-214*(hypot(X-${r},Y-${r})/150),0,255)':` +
          `a='clip(255*exp(-pow(hypot(X-${r},Y-${r})/112,4)),0,255)'`,
      },
      // Ishraq: the sun is already up and climbs high into a bright daylight sky,
      // rays radiating — Duha, the forenoon prayer, has begun.
      ishraq: {
        file: 'ishraq.mp4',
        emoji: '🌤️',
        spriteSize: 480,
        yStart: 330, yEnd: 90,
        lead: 1.2, hold: 2.5,
        brightnessGain: 0.05,
        rayRotateRate: 0.18,
        landRgb: "r='20':g='28':b='48'",
        // Title matched to sunrise's size/position for consistency; the rays
        // settle below y150 so it stays clear of the sun.
        en: 'Sunshine', ar: 'إشراق', tr: 'Ishrāq', tag: 'The morning shines',
        titleY: 150, titleSize: 88,
        // Full-morning gradient: clear daylight blue top -> pale warm gold horizon.
        sky: (H) =>
          `r='clip(60+195*pow(min(Y/${H},1),2.2),0,255)':` +
          `g='clip(120+118*pow(min(Y/${H},1),2.0),0,255)':` +
          `b='clip(196-40*pow(min(Y/${H},1),1.4),0,255)'`,
        // Tight white-gold core plus a 12-fold rayed halo (cos(12*angle)).
        sun: (r) =>
          `r='255':` +
          `g='clip(254-66*(hypot(X-${r},Y-${r})/${r}),0,255)':` +
          `b='clip(236-150*(hypot(X-${r},Y-${r})/150),0,255)':` +
          `a='clip(255*exp(-pow(hypot(X-${r},Y-${r})/86,4))` +
          `+150*exp(-pow(hypot(X-${r},Y-${r})/150,3))*(0.62+0.38*cos(12*atan2(Y-${r},X-${r}))),0,255)'`,
      },
    };
  }

  /**
   * Builds a morning-scene filter graph. Pure (no I/O) so the geometry is
   * unit-testable without invoking ffmpeg.
   *
   * Two properties are load-bearing for Raspberry Pi cost:
   *  - Each sprite source renders exactly ONE frame (d=0.1 at r=10) and is then
   *    replayed by `loop`. So each `geq` is evaluated once, not once per frame.
   *  - Motion comes from an `overlay` y-expression (and, for Ishraq, a cheap
   *    per-frame `rotate` of the 480px sun sprite), not per-frame pixel maths.
   * Together these keep a 12s 1280x800 bake at ~1s on an M-series / ~2.5s
   * single-threaded on a Pi 4. A per-frame geq instead is ~20x slower.
   *
   * Every source is declared inside the filter graph rather than as a `-f lavfi`
   * input: fluent-ffmpeg parses `ffmpeg -formats` with a regex that can't match
   * device-flagged entries ("D d lavfi"), so it rejects lavfi inputs as
   * unavailable. Sources-in-graph sidesteps that, and matches the `color=` mask
   * source already used by the weather filters above.
   *
   * @param {string} sceneKey  'sunrise' | 'ishraq'
   * @param {{durationSec?: number}} opts
   */
  static buildSceneFilters(sceneKey = 'sunrise', { durationSec = 12 } = {}) {
    const scene = MediaService.MORNING_SCENES[sceneKey] || MediaService.MORNING_SCENES.sunrise;
    const d = MediaService.clampSunriseDuration(durationSec);
    const fr = MediaService.SUNRISE_FPS;
    const lead = scene.lead;
    // Rise must shrink with duration or a short clip never reaches the top.
    const rise = Math.max(2, d - lead - scene.hold);
    const travel = scene.yStart - scene.yEnd;
    const H = MediaService.SUNRISE_HORIZON_Y;
    const r = scene.spriteSize / 2;

    // d=0.1 at r=10 yields exactly one frame, so geq runs once; `loop` then
    // replays that cached frame. `post` appends per-frame filters (rotate) after
    // the loop, for the scenes that need them.
    const sprite = (size, fmt, expr, label, post = '') =>
      `color=c=black:s=${size}:d=0.1:r=${fr},format=${fmt},geq=${expr},` +
      `loop=loop=-1:size=1:start=0,trim=duration=${d},setpts=N/${fr}/TB${post}[${label}]`;

    const sky = sprite('1280x800', 'rgb24', scene.sky(H), 'sky');

    const sz = scene.spriteSize;
    const rayPost = scene.rayRotateRate
      ? `,rotate=a='${scene.rayRotateRate}*t':c=none:ow=${sz}:oh=${sz}`
      : '';
    const sun = sprite(`${sz}x${sz}`, 'rgba', scene.sun(r), 'sun', rayPost);

    const land = sprite('1280x800', 'rgba',
      `${scene.landRgb}:a='${MediaService._mosqueAlphaExpr()}'`, 'land');

    // Normalised rise progress, clamped so the sun holds at the top.
    const p = `clip((t-${lead})/${rise}\\,0\\,1)`;
    // Ease-out: fast off the horizon, settling as it reaches its rest height.
    const yExpr = `${scene.yStart}-${travel}*(1-pow(1-${p}\\,2))`;

    return {
      durationSec: d,
      riseSec: rise,
      leadSec: lead,
      frameRate: fr,
      complexFilter: [
        sky,
        sun,
        land,
        `[sky][sun]overlay=x=(W-w)/2:y='${yExpr}':eval=frame[rise]`,
        '[rise][land]overlay=x=0:y=0[scene]',
        // Sky lifts as the sun climbs — subtle, and free next to the overlay.
        `[scene]eq=brightness='${scene.brightnessGain}*${p}':eval=frame,format=yuv420p[v]`,
        MediaService.SUNRISE_AUDIO,
      ],
    };
  }

  /** Back-compat alias: the sunrise scene. */
  static buildSunriseFilters(opts = {}) {
    return MediaService.buildSceneFilters('sunrise', opts);
  }

  /**
   * Duration is user-supplied via env; clamp rather than trust.
   * Floor is 5s, not lower: with the lead-in and a 2s minimum rise, anything
   * shorter ends before the sun finishes rising (and 5s barely clears Cast
   * buffering as it is).
   */
  static clampSunriseDuration(durationSec) {
    const n = Number(durationSec);
    if (!Number.isFinite(n)) return 12;
    return Math.min(20, Math.max(5, n));
  }

  /**
   * Registers the bundled Amiri font (once) so canvas renders Arabic + Latin
   * identically on every platform — the Raspberry Pi has no Arabic system font,
   * so relying on one would blank the Arabic text. Best-effort: if the font or
   * canvas is unavailable, the caption falls back to a default face rather than
   * failing the bake.
   */
  static _registerCaptionFonts() {
    if (MediaService._captionFontsReady) return;
    MediaService._captionFontsReady = true; // set first so a failure doesn't retry every bake
    try {
      const { registerFont } = require('canvas');
      const dir = path.join(__dirname, '..', 'assets', 'fonts');
      const reg = path.join(dir, 'Amiri-Regular.ttf');
      const bold = path.join(dir, 'Amiri-Bold.ttf');
      if (fs.existsSync(reg)) registerFont(reg, { family: 'Amiri' });
      if (fs.existsSync(bold)) registerFont(bold, { family: 'Amiri', weight: 'bold' });
    } catch (_) { /* caption will fall back to a default face */ }
  }

  /**
   * Renders the bilingual caption for a scene to a transparent 1280x800 PNG
   * buffer, split top-and-bottom around the scene:
   *  - TOP: the large "English (Transliteration)" title, in the open sky above
   *    the risen sun (per-scene titleY/titleSize keep it clear of the disc/rays).
   *    A soft dark shadow keeps white legible on the bright ishraq sky.
   *  - BOTTOM: the Arabic title (correctly shaped + RTL via canvas/pango) over
   *    the mosque and ground, then the tagline, on a soft scrim.
   * Pure text render, no scene pixels.
   */
  static renderSceneCaption(sceneKey = 'sunrise', { tagline } = {}) {
    const scene = MediaService.MORNING_SCENES[sceneKey] || MediaService.MORNING_SCENES.sunrise;
    MediaService._registerCaptionFonts();
    const { createCanvas } = require('canvas');
    const W = 1280, H = 800;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.textAlign = 'center';
    const cx = W / 2;

    // TOP — English title in the open sky, above the sun. Shadow for contrast.
    ctx.save();
    ctx.shadowColor = 'rgba(4,7,16,0.6)';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#f6f1e6';
    ctx.font = `bold ${scene.titleSize}px Amiri`;
    ctx.fillText(`${scene.en} (${scene.tr})`, cx, scene.titleY);
    ctx.restore();

    // Soft scrim over the ground so the tagline reads on the dark band.
    const bandTop = 600;
    const grad = ctx.createLinearGradient(0, bandTop, 0, H);
    grad.addColorStop(0, 'rgba(6,9,20,0)');
    grad.addColorStop(0.45, 'rgba(6,9,20,0.5)');
    grad.addColorStop(1, 'rgba(6,9,20,0.9)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, bandTop, W, H - bandTop);

    // Arabic title — sits in the lower mosque dome / at its base (the dome is a
    // half-circle centred at ~(640,565)). Its own dark shadow keeps the gold
    // legible where the word overhangs the dome onto the bright horizon.
    ctx.save();
    ctx.shadowColor = 'rgba(4,7,16,0.7)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#f5b820';
    ctx.font = '92px Amiri';
    ctx.fillText(scene.ar, cx, 650);
    ctx.restore();

    // Tagline — over the ground below the dome.
    ctx.fillStyle = '#cfd4ea';
    ctx.font = '40px Amiri';
    ctx.fillText(tagline || scene.tag, cx, 750);

    return canvas.toBuffer('image/png');
  }

  /**
   * Encodes a procedural morning clip (sunrise or ishraq) with its bilingual
   * caption. The scene itself is fully synthetic; the only on-disk asset is the
   * caption PNG, generated at bake time next to the clip (both re-created on a
   * cache miss).
   * Returns { promise, abort } to match encodeVideoFromImageAndAudio.
   */
  encodeSceneClip(outputVideoPath, sceneKey = 'sunrise', opts = {}) {
    const scene = MediaService.MORNING_SCENES[sceneKey] || MediaService.MORNING_SCENES.sunrise;
    const spec = MediaService.buildSceneFilters(sceneKey, opts);
    console.log(`${scene.emoji} Encoding ${sceneKey} clip: ${spec.durationSec}s (silent)...`);

    // Render the caption to a sidecar PNG; it becomes ffmpeg input [0:v]. This is
    // best-effort: if canvas/font rendering fails on some platform, fall back to
    // the (still valid) caption-less clip rather than losing the whole clip — it
    // is decorative, and a silent sunrise beats no sunrise.
    let captionPath = null;
    let filters = spec.complexFilter;
    let videoMap = '[v]';
    try {
      captionPath = path.join(path.dirname(outputVideoPath), `.caption-${sceneKey}.png`);
      fs.writeFileSync(captionPath, MediaService.renderSceneCaption(sceneKey, { tagline: opts.tagline }));
      // Caption fades in as the sun clears the horizon, then holds to the end.
      const fadeSt = (spec.leadSec + spec.riseSec * 0.2).toFixed(2);
      filters = spec.complexFilter.concat([
        `[0:v]format=rgba,fade=t=in:st=${fadeSt}:d=1.0:alpha=1[cap]`,
        '[v][cap]overlay=x=0:y=0,format=yuv420p[vout]',
      ]);
      videoMap = '[vout]';
    } catch (e) {
      console.warn(`⚠️ ${sceneKey} caption skipped (${e.message}); encoding without it.`);
      captionPath = null;
      filters = spec.complexFilter;
      videoMap = '[v]';
    }

    let command;
    const promise = new Promise((resolve, reject) => {
      // At most one real input: the caption PNG ([0:v]). All scene sources live
      // in the graph (see buildSceneFilters), so no lavfi input is ever declared.
      // -loop 1 turns the still PNG into a continuous stream — without it the
      // input is a single frame at t=0, so the timed fade-in never has later
      // frames to reveal and the caption stays invisible.
      command = ffmpeg();
      if (captionPath) command = command.input(captionPath).inputOptions(['-loop 1']);
      command
        .complexFilter(filters)
        .outputOptions([
          `-map ${videoMap}`,
          '-map [a]',
          // Output ladder mirrors the Adhan encode: this is the envelope Nest
          // Hub is known to accept. Baseline/yuv420p/faststart are not optional.
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-preset ultrafast',
          '-profile:v baseline',
          '-level 3.0',
          `-r ${spec.frameRate}`,
          `-g ${spec.frameRate}`,
          '-c:a aac',
          '-b:a 128k',
          '-movflags +faststart',
          // Pin duration explicitly. -shortest would clamp to the audio bed.
          `-t ${spec.durationSec}`,
        ])
        .save(outputVideoPath)
        .on('end', () => {
          console.log(`✅ ${sceneKey} clip encoded.`);
          resolve(outputVideoPath);
        })
        .on('error', (err) => {
          if (err.message && err.message.includes('ffmpeg was killed')) {
            console.log(`⚠️ ${sceneKey} encoding aborted (timeout).`);
            return;
          }
          console.error(`❌ ${sceneKey} encoding error:`, err.message);
          reject(err);
        });
    });

    return {
      promise,
      abort: () => { if (command) command.kill('SIGKILL'); },
    };
  }

  /** Back-compat alias: encodes the sunrise scene. */
  encodeSunriseClip(outputVideoPath, opts = {}) {
    return this.encodeSceneClip(outputVideoPath, 'sunrise', opts);
  }

  getFileSizeMB(filePath) {
    try {
      const stats = fs.statSync(filePath);
      return (stats.size / 1024 / 1024).toFixed(2);
    } catch {
      return '0.00';
    }
  }

  /**
   * Returns the duration of a media file in seconds (via ffprobe).
   * @param {string} filePath
   * @returns {Promise<number|null>}
   */
  getMediaDuration(filePath) {
    return new Promise((resolve) => {
      exec(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
        { timeout: 10000 },
        (err, stdout) => {
          if (err) {
            console.error(`⚠️ ffprobe error for ${filePath}: ${err.message}`);
            resolve(null);
            return;
          }
          const dur = parseFloat(stdout);
          resolve(Number.isFinite(dur) ? dur : null);
        }
      );
    });
  }

  /** Nominal full Adhan audio length (seconds): Fajr ~4 min, other prayers ~2 min */
  static NOMINAL_ADHAN_SEC_FAJR = 4 * 60;
  static NOMINAL_ADHAN_SEC_REGULAR = 2 * 60;

  /**
   * Nominal duration for this prayer (exact schedule intent).
   * @param {string} prayerName
   * @returns {number}
   */
  static getNominalAdhanSeconds(prayerName) {
    return (prayerName || '').toLowerCase() === 'fajr'
      ? MediaService.NOMINAL_ADHAN_SEC_FAJR
      : MediaService.NOMINAL_ADHAN_SEC_REGULAR;
  }

  /**
   * Pre-encoding floor (seconds): ffprobe must be at least this long or we treat source/encode as bad.
   * Slightly under nominal to allow MP3 rounding, ffprobe variance, and the ~1.5s adelay in the graph
   * (encoded MP4 can be a few seconds longer than raw audio).
   * @param {string} prayerName
   */
  static getMinExpectedDuration(prayerName) {
    const nominal = MediaService.getNominalAdhanSeconds(prayerName);
    const slack = nominal === MediaService.NOMINAL_ADHAN_SEC_FAJR ? 12 : 10;
    return nominal - slack;
  }

  /**
   * Runtime: if Cast reports FINISHED (or implicit end) with wall time under this many seconds, treat as failure.
   * Set to one half of nominal (2 min → 60s, 4 min → 120s).
   * @param {string} prayerName
   */
  static getPlaybackTooShortThresholdSeconds(prayerName) {
    return Math.floor(MediaService.getNominalAdhanSeconds(prayerName) / 2);
  }

  /**
   * Wall-clock cap for ffmpeg encode (libx264 + weather overlay). Fajr runs ~4× longer than
   * regular prayers; a fixed short timeout falsely triggers SMART_RECOVERY on slow hosts.
   * @param {string} prayerName
   * @param {number|null|undefined} audioDurationSec from ffprobe, or null if unknown
   * @returns {number}
   */
  static getEncodingTimeoutMs(prayerName, audioDurationSec) {
    const nominal = MediaService.getNominalAdhanSeconds(prayerName);
    const base =
      Number.isFinite(audioDurationSec) && audioDurationSec > 0 ? audioDurationSec : nominal;
    const ms = Math.round(base * 1000 * 4 + 90_000);
    return Math.min(25 * 60 * 1000, Math.max(120_000, ms));
  }
}

module.exports = MediaService;
