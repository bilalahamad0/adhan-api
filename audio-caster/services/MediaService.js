const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
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
   * Returns an object { promise, abort } for timeout management
   */
  encodeVideoFromImageAndAudio(imagePath, audioPath, outputVideoPath) {
    console.log(`🎬 Encoding Video: ${path.basename(outputVideoPath)}...`);
    let command;
    const promise = new Promise((resolve, reject) => {
      command = ffmpeg()
        .input(imagePath)
        .inputOptions(['-loop 1'])
        .input(audioPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioFrequency(44100)
        .outputOptions([
          '-pix_fmt yuv420p',
          '-preset ultrafast',
          '-profile:v baseline',
          '-level 3.0',
          '-r 10',
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
}

module.exports = MediaService;
