const { createCanvas, loadImage, registerFont } = require('canvas');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { DateTime } = require('luxon');

class VisualGenerator {
  constructor(config) {
    this.config = config;
    // Adjusted for Google Nest Hub Max (16:10 Aspect Ratio) to remove black bars
    this.width = 1280;
    this.height = 800;
    this.cacheDir = path.join(__dirname, 'audio'); // For generated outputs (served by Express)
    this.bgPath = path.join(__dirname, '../images/default.jpg'); // Source default background
    
    // Weather Cache to prevent 429 Rate Limiting
    this.weatherCache = {
       data: null,
       lastFetch: 0,
       ttl: 15 * 60 * 1000 // 15 Minutes
    };
  }

  /**
   * Open-Meteo returns is_day as 0|1; coerce so strict equality works (avoids "0" string → wrong sun at night).
   * @param {unknown} v
   * @returns {0|1}
   */
  static normalizeIsDay(v) {
    const n = Number(v);
    return n === 0 ? 0 : 1;
  }

  /**
   * When the API fails, avoid showing clear-day (code 0) at night — that was the misleading sun + "--°C" case.
   * Rough civil heuristic: local 06:00–19:59 treated as "day" for icon purposes only.
   */
  inferApproxIsDayFromClock() {
    const h = DateTime.now().setZone(this.config.timezone || 'UTC').hour;
    return h >= 6 && h <= 19 ? 1 : 0;
  }

  /**
   * If current conditions show measurable precip but WMO code is only clouds/clear, bias icon toward rain.
   */
  static adjustCodeForPrecipitation(code, precipitationMm, rainMm) {
    const c = Number(code);
    if (!Number.isFinite(c)) return 3;
    const p = Number(precipitationMm) || 0;
    const r = Number(rainMm) || 0;
    if ((p > 0.05 || r > 0.05) && c >= 0 && c <= 48) return 61;
    return c;
  }

  // ... (methods remain same) use lines from original file for context ...

  async init() {
    // Ensure cache dir exists for outputs
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    // Ensure default background exists
    if (!fs.existsSync(this.bgPath)) {
      await this.downloadDefaultBackground();
    }
  }

  async downloadDefaultBackground() {
    // High quality Blue Mosque from Pexels (Verified Static Link)
    const url = 'https://images.pexels.com/photos/3223552/pexels-photo-3223552.jpeg';
    console.log('⬇️  Downloading new default background (Pexels)...');
    try {
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      // Ensure images dir exists
      const imgDir = path.dirname(this.bgPath);
      if (!fs.existsSync(imgDir)) {
        fs.mkdirSync(imgDir, { recursive: true });
      }
      fs.writeFileSync(this.bgPath, response.data);
      console.log('✅ Default background saved to images directory.');
    } catch (error) {
      console.error('❌ Error downloading background:', error.message);
    }
  }

  selectBackgroundImage(prayer, context) {
    const imagesDir = path.join(__dirname, '../images');
    if (!fs.existsSync(imagesDir)) {
      console.warn('⚠️ Images directory not found. Using default.');
      return this.bgPath;
    }

    const files = fs.readdirSync(imagesDir);
    let candidates = [];

    // 1. Eid Logic (Specific to Dhuhr usually, or applied generally if user wants)
    // User said: "Exception: Used for respective Eid day" (Implies Dhuhr as per filenames)
    if (prayer === 'Dhuhr' && context?.holidays) {
      if (context.holidays.includes('Eid-ul-Fitr')) {
        return path.join(imagesDir, 'Dhuhr_Eid_ul_Fitr.png');
      }
      if (context.holidays.includes('Eid-ul-Adha')) {
        return path.join(imagesDir, 'Dhuhr_Eid_ul_Adha.png');
      }
    }

    // 2. Friday Logic (Dhuhr only)
    if (prayer === 'Dhuhr' && context?.isFriday) {
      candidates = files.filter((f) => f.startsWith('Dhuhr_Jumma'));
      // Should match Dhuhr_Jumma.png, Dhuhr_Jumma_2.png
    }
    // 3. Standard Logic
    else {
      candidates = files.filter((f) => {
        // Must start with Prayer Name (e.g. "Fajr")
        if (!f.startsWith(prayer)) return false;

        // Exclude special cases if we are in standard mode
        if (prayer === 'Dhuhr') {
          if (f.includes('Jumma') || f.includes('Eid')) return false;
        }
        return true;
      });
    }

    if (candidates.length === 0) {
      console.warn(`⚠️ No images found for ${prayer}. Using default.`);
      return this.bgPath;
    }

    // Random Pick
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    console.log(`🖼️ Selected Background: ${picked}`);
    return path.join(imagesDir, picked);
  }

  async geolocateCity(city, country) {
    console.log(`🌐 Smart Geocoding: Resolving coordinates for "${city}, ${country}"...`);
    try {
      const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
      const res = await axios.get(url, { timeout: 5000 });
      if (res.data.results && res.data.results.length > 0) {
        const result = res.data.results[0];
        console.log(`✅ Geolocated: ${result.name} (${result.admin1}) -> ${result.latitude}, ${result.longitude}`);
        return { lat: result.latitude, lon: result.longitude };
      }
    } catch (e) {
      console.warn('⚠️ Geocoding failed:', e.message);
    }
    return null;
  }

  async getWeather() {
    const now = Date.now();
    if (this.weatherCache.data && (now - this.weatherCache.lastFetch < this.weatherCache.ttl)) {
       return this.weatherCache.data;
    }

    console.log('☁️  Fetching latest weather...');
    const httpOpts = {
      timeout: 12000,
      headers: {
        'User-Agent': 'adhan-api/visual-generator (https://github.com/bilalahamad0/adhan-api)',
        Accept: 'application/json',
      },
      validateStatus: (s) => s >= 200 && s < 300,
    };

    const weatherFallback = () => {
      const isDay = this.inferApproxIsDayFromClock();
      // Cloudy unknown — never "clear sky" sun at night when API is down
      return { temp: '\u2014 °C', code: 3, isDay };
    };

    try {
      let lat = this.config.location.lat;
      let lon = this.config.location.lon;

      // Smart Recovery: Detect placeholders (Default 0,0 or the AlAdhan 8.8, 7.7 bug)
      const isPlaceholder = !lat || !lon || 
        (parseFloat(lat) === 0 && parseFloat(lon) === 0) ||
        (parseFloat(lat).toFixed(4) === '8.8889' && parseFloat(lon).toFixed(4) === '7.7778') ||
        (parseFloat(lat) === 8.8888888 && parseFloat(lon) === 7.7777777);

      if (isPlaceholder) {
        const resolved = await this.geolocateCity(this.config.location.city, this.config.location.country);
        if (resolved) {
          lat = resolved.lat;
          lon = resolved.lon;
          // Cache it in config for this instance's lifetime
          this.config.location.lat = lat;
          this.config.location.lon = lon;
        }
      }

      // Final fallback to 0,0 if all else fails
      lat = lat || '0.0';
      lon = lon || '0.0';

      const tz = encodeURIComponent(this.config.timezone || 'UTC');
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        '&current=temperature_2m,weather_code,is_day,precipitation,rain' +
        '&temperature_unit=celsius' +
        `&timezone=${tz}`;

      let lastErr = null;
      let res = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await axios.get(url, httpOpts);
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
      if (!res) throw lastErr || new Error('Open-Meteo: no response');

      const current = res.data?.current;
      if (!current || typeof current !== 'object') {
        throw new Error('Open-Meteo: missing current block');
      }

      const codeRaw = current.weather_code;
      const codeNum = Number(codeRaw);
      if (!Number.isFinite(codeNum)) {
        throw new Error('Open-Meteo: invalid weather_code');
      }

      const precip = current.precipitation;
      const rain = current.rain;
      const code = VisualGenerator.adjustCodeForPrecipitation(codeNum, precip, rain);

      const tRaw = current.temperature_2m;
      const temp =
        tRaw != null && Number.isFinite(Number(tRaw))
          ? `${Math.round(Number(tRaw))}°C`
          : '\u2014 °C';

      const isDay = VisualGenerator.normalizeIsDay(current.is_day);

      this.weatherCache.data = {
        temp,
        code,
        isDay,
      };
      this.weatherCache.lastFetch = now;

      console.log(`✅ Weather Updated: ${this.weatherCache.data.temp} (code ${code}, isDay ${isDay})`);
      return this.weatherCache.data;
    } catch (e) {
      console.warn('⚠️ Weather fetch failed or timed out:', e.message);
      // If we have old data, return it instead of fallback
      if (this.weatherCache.data) return this.weatherCache.data;
      return weatherFallback();
    }
  }

  getWeatherIcon(code, isDay) {
    const day = VisualGenerator.normalizeIsDay(isDay);
    // Night Overwrite
    if (day === 0) {
      if (code === 0) return '☾'; // Crescent Moon (U+263E)
      if (code <= 3) return '☁'; // Night Cloud (Standard Unicode)
    }

    // Mapping using Standard Unicode Symbols (Non-emoji versions for high compatibility)
    const icons = {
      0: '☀', // Clear Sun (U+2600)
      1: '⛅', // Partly Cloudy (U+26C5)
      2: '⛅',
      3: '☁', // Overcast (U+2601)
      45: '≡', // Fog (U+2261)
      48: '≡',
      51: '☔', // Drizzle (U+2614)
      61: '☔', // Rain
      71: '❄', // Snow (U+2744)
      80: '☔', // Showers
      95: '⚡', // Thunder (U+26A1)
    };

    if (code >= 51 && code <= 67) return '☔';
    if (code >= 71 && code <= 77) return '❄';
    if (code >= 80 && code <= 82) return '☔';
    if (code >= 95 && code <= 99) return '⚡';

    return icons[code] || '🌡'; 
  }

  drawWeatherIcon(ctx, code, isDay, cx, cy, size) {
    ctx.save();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    const r = size / 2;
    const isNight = VisualGenerator.normalizeIsDay(isDay) === 0;

    const fillCircle = (x, y, radius, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    };

    const drawCloudShape = (x, y, w) => {
      ctx.fillStyle = '#E8E8E8';
      ctx.beginPath();
      ctx.arc(x - w * 0.2, y + w * 0.05, w * 0.22, 0, Math.PI * 2);
      ctx.arc(x + w * 0.12, y - w * 0.12, w * 0.28, 0, Math.PI * 2);
      ctx.arc(x + w * 0.38, y + w * 0.05, w * 0.2, 0, Math.PI * 2);
      ctx.rect(x - w * 0.42, y + w * 0.05, w * 0.8, w * 0.17);
      ctx.fill();
    };

    const drawRainDrops = (x, y, w) => {
      ctx.strokeStyle = '#87CEEB';
      ctx.lineWidth = Math.max(1.5, w * 0.05);
      ctx.lineCap = 'round';
      [[-0.15, 0.30, -0.22, 0.48],
       [ 0.10, 0.35,  0.03, 0.53],
       [ 0.32, 0.30,  0.25, 0.48]].forEach(([x1, y1, x2, y2]) => {
        ctx.beginPath();
        ctx.moveTo(x + x1 * w, y + y1 * w);
        ctx.lineTo(x + x2 * w, y + y2 * w);
        ctx.stroke();
      });
    };

    if (code === 0) {
      if (isNight) {
        // 5-point star
        ctx.fillStyle = '#F5E6A3';
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const angle = (Math.PI * 2 * i) / 10 - Math.PI / 2;
          const rad = i % 2 === 0 ? r * 0.6 : r * 0.25;
          const px = cx + Math.cos(angle) * rad;
          const py = cy + Math.sin(angle) * rad;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        // Sun: circle + 8 rays
        fillCircle(cx, cy, r * 0.3, '#FFD700');
        ctx.strokeStyle = '#FFD700';
        ctx.lineWidth = Math.max(1.5, r * 0.08);
        ctx.lineCap = 'round';
        for (let i = 0; i < 8; i++) {
          const a = (Math.PI / 4) * i;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * r * 0.45, cy + Math.sin(a) * r * 0.45);
          ctx.lineTo(cx + Math.cos(a) * r * 0.7, cy + Math.sin(a) * r * 0.7);
          ctx.stroke();
        }
      }
    } else if (code <= 3) {
      if (!isNight && code <= 2) {
        fillCircle(cx - r * 0.25, cy - r * 0.25, r * 0.2, '#FFD700');
      }
      drawCloudShape(cx + r * 0.05, cy + r * 0.1, r * 1.1);
    } else if (code >= 45 && code <= 48) {
      // Fog: horizontal bars
      ctx.strokeStyle = 'rgba(220,220,220,0.8)';
      ctx.lineWidth = Math.max(2, r * 0.1);
      ctx.lineCap = 'round';
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.6, cy + i * r * 0.35);
        ctx.lineTo(cx + r * 0.6, cy + i * r * 0.35);
        ctx.stroke();
      }
    } else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
      // Rain
      drawCloudShape(cx, cy - r * 0.15, r);
      drawRainDrops(cx, cy - r * 0.15, r);
    } else if (code >= 71 && code <= 77) {
      // Snow: cloud + dots
      drawCloudShape(cx, cy - r * 0.15, r);
      [[-0.12, 0.38], [0.12, 0.45], [0.35, 0.38]].forEach(([dx, dy]) => {
        fillCircle(cx + dx * r, cy - r * 0.15 + dy * r, r * 0.06, '#FFFFFF');
      });
    } else if (code >= 95) {
      // Thunder: cloud + bolt
      drawCloudShape(cx, cy - r * 0.2, r);
      ctx.fillStyle = '#FFD700';
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.05, cy + r * 0.15);
      ctx.lineTo(cx - r * 0.1,  cy + r * 0.35);
      ctx.lineTo(cx + r * 0.05, cy + r * 0.32);
      ctx.lineTo(cx - r * 0.08, cy + r * 0.55);
      ctx.lineTo(cx + r * 0.18, cy + r * 0.28);
      ctx.lineTo(cx + r * 0.02, cy + r * 0.3);
      ctx.closePath();
      ctx.fill();
    } else {
      // Fallback: circle outline (thermometer)
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  async generateDashboard(prayerName, prayerTime, hijriDate, context = {}) {
    await this.init();

    const canvas = createCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');

    // 1. Select & Draw Background
    const bgFile = this.selectBackgroundImage(prayerName, context);
    console.log(`🎨 Drawing Dashboard for ${prayerName}...`);

    let image;
    try {
      image = await loadImage(bgFile);
      console.log(`✅ Image Loaded: ${path.basename(bgFile)}`);
    } catch (e) {
      console.error(`❌ Failed to load ${bgFile}, falling back to default.`);
      // Ensure default exists
      if (!fs.existsSync(this.bgPath)) await this.downloadDefaultBackground();
      image = await loadImage(this.bgPath);
    }

    // Draw image covering canvas (cover compliant)
    // Add 0.01 to scale to prevent sub-pixel rounding errors causing black lines
    const scale = Math.max(this.width / image.width, this.height / image.height) + 0.001;
    const x = this.width / 2 - (image.width / 2) * scale;
    const y = this.height / 2 - (image.height / 2) * scale;
    ctx.drawImage(image, x, y, image.width * scale, image.height * scale);

    // 2. Overlay (Adjusted for Readability with Huge Fonts)
    const gradient = ctx.createLinearGradient(0, 0, 0, this.height);
    gradient.addColorStop(0, 'rgba(0,0,0,0.3)');
    gradient.addColorStop(0.5, 'rgba(0,0,0,0.5)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.9)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);

    // 3. Typography
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';

    // -- Main Content (Middle) - Scaled for 1280x800
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = 3;
    ctx.shadowOffsetY = 3;

    // Prayer Name
    // Moved UP to fix overlap with time
    ctx.font = 'bold 210px Georgia, "Times New Roman", serif';
    ctx.fillText(prayerName, this.width / 2, this.height / 2 - 60);

    // Prayer Time
    // Moved DOWN to create gap
    ctx.font = '110px Georgia, "Times New Roman", serif';
    ctx.fillText(prayerTime, this.width / 2, this.height / 2 + 100);

    // -- Footer Info (Bottom) - Symmetrical Layout
    ctx.textAlign = 'left';
    const PADDING = 40;

    // Baselines
    const BOTTOM_BASE = this.height - 40; // Hijri & City
    const TOP_BASE = this.height - 110; // Date & Temp (Aligned)

    // Date (Bottom Left - Primary)
    const now = DateTime.now().setZone(this.config.timezone);
    const dateStr = now.toFormat('EEEE, MMMM d');

    // Match Temp Size
    ctx.font = '75px sans-serif';
    ctx.fillText(dateStr, PADDING, TOP_BASE);

    // Hijri (Bottom Left - Secondary)
    if (hijriDate) {
      ctx.fillStyle = '#E0E0E0';
      // Match City Size
      ctx.font = 'italic 40px serif';
      ctx.fillText(hijriDate, PADDING, BOTTOM_BASE);
    }

    // Weather (Bottom Right)
    const weather = await this.getWeather();

    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'right';

    ctx.font = '75px sans-serif';
    const tempText = weather.temp;
    ctx.fillText(tempText, this.width - PADDING, TOP_BASE);

    // Canvas-drawn weather icon (font-independent, guaranteed to render)
    const tempWidth = ctx.measureText(tempText).width;
    const iconSize = 50;
    const iconCenterX = this.width - PADDING - tempWidth - 25 - iconSize / 2;
    const iconCenterY = TOP_BASE - iconSize * 0.35;
    this.drawWeatherIcon(ctx, weather.code, weather.isDay, iconCenterX, iconCenterY, iconSize);

    // City (Matched with Hijri)
    ctx.font = '40px sans-serif';
    ctx.fillText(this.config.location.city, this.width - PADDING, BOTTOM_BASE);

    return canvas.toBuffer('image/jpeg', { quality: 0.95 });
  }

  async generateDua(duaPath) {
    await this.init();
    const canvas = createCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');

    const image = await loadImage(duaPath);
    // Forced Stretch: Match canvas exactly (ignoring aspect ratio)
    // This fills the screen vertically without cropping the sides.
    ctx.drawImage(image, 0, 0, this.width, this.height);

    return canvas.toBuffer('image/jpeg', { quality: 0.95 });
  }
}

module.exports = VisualGenerator;
