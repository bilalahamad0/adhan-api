const schedule = require('node-schedule');
const { DateTime } = require('luxon');

class CoreScheduler {
  constructor(config, hardwareService, mediaService, castService, scheduleFilePath) {
    this.config = config;
    this.hardware = hardwareService;
    this.media = mediaService;
    this.cast = castService;
    this.scheduleFilePath = scheduleFilePath;
    this.log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  /**
   * Reads external schedule
   */
  getAnnualData() {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.scheduleFilePath)) {
        return JSON.parse(fs.readFileSync(this.scheduleFilePath));
      }
    } catch (e) {
      this.log('⚠️ Local schedule corrupt.');
    }
    return null;
  }

  /**
   * Verifies Network Preflight
   */
  async runNetworkPreFlight() {
    const isOnline = await this.hardware.ping('8.8.8.8');
    if (!isOnline) {
      this.log(`🚨 CRITICAL: Network Down (Gateway Unreachable). Rebooting System...`);
      if (process.platform === 'linux' && !process.argv.includes('--test')) {
        await this.hardware.rebootOS();
      }
      return false;
    }
    this.log(`✅ Network Check Passed (Gateway Reachable).`);
    return true;
  }

  /**
   * Main casting flow decoupled
   */
  async executePreFlightAndCast(prayerName, audioFileName, targetTimeObj) {
    if (!(await this.runNetworkPreFlight())) return;

    this.log(`🚀 TRIGGER: ${prayerName} Time! Starting sequence...`);

    // 0. Late Execution Guard
    if (targetTimeObj) {
      const now = Date.now();
      const scheduledTime = targetTimeObj.toMillis();
      const diff = now - scheduledTime;
      if (diff > 10 * 60 * 1000) {
        this.log(`⚠️ SKIPPING: Too late for ${prayerName} (Delayed). System likely slept.`);
        return;
      }
    }

    // 1. Generate Video
    const path = require('path');
    const fs = require('fs');
    const outputVideoPath = path.join(
      __dirname,
      '..',
      '..',
      'images',
      'generated',
      `${prayerName.toLowerCase()}.mp4`
    );
    const audioPath = path.join(__dirname, '..', 'audio', audioFileName);
    const imgPath = path.join(__dirname, '..', '..', 'images', 'generated', 'current_dashboard.jpg');

    try {
      // a. Generate Image Overlay
      const VisualGenerator = require('../visual_generator.js');
      const vg = new VisualGenerator(this.config);
      const timeString = targetTimeObj ? targetTimeObj.toFormat('h:mm a') : 'Now';
      const imgBuffer = await vg.generateDashboard(prayerName, timeString, null, {});
      
      fs.mkdirSync(path.dirname(imgPath), { recursive: true });
      fs.writeFileSync(imgPath, imgBuffer);
      this.log(`🖼️  Dashboard image generated at ${imgPath}`);

      // b. Encode Video via FFmpeg
      await this.media.encodeVideoFromImageAndAudio(imgPath, audioPath, outputVideoPath);
    } catch (e) {
      this.log(`❌ Video Generation Failed: ${e.message}`);
      return;
    }

    if (targetTimeObj) {
      const delay = targetTimeObj.toMillis() - Date.now();
      if (delay > 0) {
        this.log(`⏳ Video Ready. Waiting ${Math.round(delay / 1000)}s for precise prayer time...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    const localIp = this.hardware.getLocalIp();
    const castUrl = `http://${localIp}:${this.config.serverPort}/images/generated/${prayerName.toLowerCase()}.mp4?t=${Date.now()}`;

    // Casting logic using the injected service
    this.log(`📡 Ready to Cast: ${castUrl}`);

    // 2.5 Intercept Sony TV Audio (ADB PAUSE)
    const tvIp = process.env.TV_IP;
    let tvWasInterrupted = false;
    let tvWasMuted = false;

    if (tvIp) {
      try {
        const sessionOutput = await this.hardware.adbCommand(tvIp, 'shell dumpsys media_session');
        const isPlaying = sessionOutput && (sessionOutput.includes('state=3') || sessionOutput.includes('state=Playing'));

        if (isPlaying) {
          this.log(`📺 Sony TV is PLAYING. Sending ADB PAUSE (keyevent 127)...`);
          await this.hardware.adbCommand(tvIp, 'shell input keyevent 127');
          await new Promise(r => setTimeout(r, 1000));
          
          // Verify
          const verifyOutput = await this.hardware.adbCommand(tvIp, 'shell dumpsys media_session');
          if (verifyOutput && (verifyOutput.includes('state=3') || verifyOutput.includes('state=Playing'))) {
             this.log(`⚠️ TV ignored PAUSE. Force Muting (keyevent 164)...`);
             await this.hardware.adbCommand(tvIp, 'shell input keyevent 164');
             tvWasMuted = true;
          } else {
             tvWasInterrupted = true;
          }
        }
      } catch (e) {
        this.log(`⚠️ ADB TV Pause Failed: ${e.message}`);
      }
    }

    // 3. Connect & Cast
    this.cast.startScanner(async (friendlyName) => {
      if (friendlyName === this.config.device.name) {
        const device = this.cast.findDevice(friendlyName);
        if (device) {
          try {
            await this.cast.castMedia(device, castUrl);
            try {
              // Wait for play to initiate a session before setting volume
              await new Promise(res => setTimeout(res, 2000));
              await this.cast.setVolume(device, this.config.device.targetVolume);
            } catch (volErr) {
              this.log(`⚠️ Volume Set Error: ${volErr.message}`);
            }
            this.log(`🎉 Playing ${prayerName} on ${friendlyName}`);
            
            // Revert TV after 5 minutes (mocking duration of adhan) Wait, standard cast library has `finished` events. 
            // We use timeout for TV recovery since cast events can be flaky
            setTimeout(async () => {
               if (tvWasMuted) {
                 this.log(`🔊 Unmuting Sony TV...`);
                 await this.hardware.adbCommand(tvIp, 'shell input keyevent 164');
               } else if (tvWasInterrupted) {
                 this.log(`▶️ Resuming Sony TV...`);
                 await this.hardware.adbCommand(tvIp, 'shell input keyevent 126'); // Play
               }
            }, 300000); // 5 minutes

          } catch (err) {
            this.log(`❌ Cast Error: ${err.message}`);
          }
        }
      }
    });
  }
}

module.exports = CoreScheduler;
