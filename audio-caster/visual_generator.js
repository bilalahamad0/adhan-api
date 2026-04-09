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

  async getWeather() {
    const now = Date.now();
    if (this.weatherCache.data && (now - this.weatherCache.lastFetch < this.weatherCache.ttl)) {
       return this.weatherCache.data;
    }

    try {
      // Open-Meteo for Sunnyvale (Celsius) + is_day
      const url = `https://api.open-meteo.com/v1/forecast?latitude=37.3688&longitude=-122.0363&current=temperature_2m,weather_code,is_day&temperature_unit=celsius&timezone=auto`;
      const res = await axios.get(url);
      const current = res.data.current;
      
      this.weatherCache.data = {
        temp: Math.round(current.temperature_2m) + '°C',
        code: current.weather_code,
        isDay: current.is_day, // 1 = Day, 0 = Night
      };
      this.weatherCache.lastFetch = now;
      
      return this.weatherCache.data;
    } catch (e) {
      console.error('⚠️ Weather fetch failed:', e.message);
      // If we have old data, return it instead of fallback
      if (this.weatherCache.data) return this.weatherCache.data;
      return { temp: '--°C', code: 0, isDay: 1 };
    }
  }

  getWeatherIcon(code, isDay) {
    // Night overwrites for clear/partly cloudy
    if (isDay === 0) {
      if (code === 0) return '☾'; // Basic Crescent Moon (Safe U+263E) - Kept per user request
      if (code === 1 || code === 2) return '☁️'; // Cloud (Emoji)
    }

    // WMO Weather interpretation codes (WW)
    // Reverted to Emojis for "Beautiful" look (Sun/Cloud), except Moon
    const icons = {
      0: '☀️',
      1: '🌤️',
      2: '⛅',
      3: '☁️',
      45: '🌫️',
      48: '🌫️',
      51: '☔',
      53: '☔',
      55: '☔',
      61: '🌧️',
      63: '🌧️',
      65: '🌧️',
      71: '❄️',
      73: '❄️',
      75: '❄️',
      80: '🌦️',
      81: '🌦️',
      82: '🌧️',
      95: '⛈️',
      96: '⛈️',
      99: '⛈️',
    };

    // Simplify logic
    if (code >= 51 && code <= 57) return '☔'; // Drizzle -> Umbrella (Rain without heavy cloud)
    if (code >= 61 && code <= 67) return '🌧️';
    if (code >= 71 && code <= 77) return '❄️';

    return icons[code] || '🌡️';
  }

  async generateDashboard(prayerName, prayerTime, hijriDate, context = {}) {
    await this.init();

    const canvas = createCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');

    // 1. Select & Draw Background
    const bgFile = this.selectBackgroundImage(prayerName, context);

    let image;
    try {
      image = await loadImage(bgFile);
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
    const icon = this.getWeatherIcon(weather.code, weather.isDay);

    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'right';

    // Temp (Moved Down)
    ctx.font = '75px sans-serif';
    const tempText = weather.temp;
    ctx.fillText(tempText, this.width - PADDING, TOP_BASE);

    // Icon - Draw to left of Temp
    const tempWidth = ctx.measureText(tempText).width;
    ctx.textAlign = 'right';

    ctx.font = '50px sans-serif';

    // Reduced gap from 60 to 25 to bring closer
    ctx.fillText(icon, this.width - PADDING - tempWidth - 25, TOP_BASE);

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
    // Cover the canvas perfectly
    const scale = Math.max(this.width / image.width, this.height / image.height) + 0.001;
    const x = this.width / 2 - (image.width / 2) * scale;
    const y = this.height / 2 - (image.height / 2) * scale;
    ctx.drawImage(image, x, y, image.width * scale, image.height * scale);

    return canvas.toBuffer('image/jpeg', { quality: 0.95 });
  }
}

module.exports = VisualGenerator;
