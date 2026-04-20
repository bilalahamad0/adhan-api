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
}

module.exports = MediaService;
