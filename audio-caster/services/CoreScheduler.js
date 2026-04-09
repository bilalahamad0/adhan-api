const schedule = require('node-schedule');
const { DateTime } = require('luxon');
const path = require('path');
const fs = require('fs');
const ChromecastAPI = require('chromecast-api');

class CoreScheduler {
  constructor(config, hardwareService, mediaService, castService, scheduleFilePath) {
    this.config = config;
    this.hardware = hardwareService;
    this.media = mediaService;
    this.cast = castService; // Kept for reference, but we will instantiate local clients for parity
    this.scheduleFilePath = scheduleFilePath;
    this.log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  getAnnualData() {
    try {
      if (fs.existsSync(this.scheduleFilePath)) {
        return JSON.parse(fs.readFileSync(this.scheduleFilePath));
      }
    } catch (e) {
      this.log('⚠️ Local schedule corrupt.');
    }
    return null;
  }

  async scheduleToday() {
    try {
      this.log("📅 Loading Schedule...");
      let annualData = this.getAnnualData();
      const currentYear = DateTime.now().setZone(this.config.timezone).toFormat('yyyy');

      if (!annualData || annualData.year !== currentYear) {
        this.log(`🔄 Initialzing Annual Data for ${currentYear}...`);
        try {
          const axios = require('axios');
          const url = `http://api.aladhan.com/v1/calendarByCity/${currentYear}?city=${this.config.location.city}&country=${this.config.location.country}&method=${this.config.location.method}&annual=true`;
          const response = await axios.get(url);
          annualData = { year: currentYear, data: response.data.data };
          fs.writeFileSync(this.scheduleFilePath, JSON.stringify(annualData, null, 2));
          this.log("💾 Annual Data Downloaded & Saved.");
        } catch (error) {
          this.log("❌ Fetch Error. Cannot Schedule.");
          return;
        }
      }

      if (!annualData || !annualData.data) return this.log('❌ Calendar Error: Data structure invalid.');

      const today = DateTime.now().setZone(this.config.timezone);
      const month = today.month.toString();
      const monthData = annualData.data[month];
      if (!monthData || !Array.isArray(monthData)) return this.log(`❌ Calendar Error: Month data missing.`);

      const todayEntry = monthData.find((d) => parseInt(d.date.gregorian.day) === today.day);
      if (!todayEntry) return this.log(`❌ Calendar Error: Day missing.`);

      const timings = todayEntry.timings;
      this.log(`✅ Today's Prayer Times (${todayEntry.date.readable}):`);

      const prayers = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
      prayers.forEach((prayer) => {
        let timeStr = timings[prayer].split(' ')[0];
        const [hours, minutes] = timeStr.split(':');
        const scheduleTime = today.set({ hour: parseInt(hours), minute: parseInt(minutes), second: 0 });

        if (scheduleTime < DateTime.now().setZone(this.config.timezone)) return;

        const audioKey = prayer === 'Fajr' ? this.config.audio.fajrCurrent : this.config.audio.regularCurrent;
        const audioFile = `${audioKey}.mp3`;

        let triggerTime = scheduleTime.minus({ minutes: 5 });
        if (triggerTime < DateTime.now().setZone(this.config.timezone)) {
          triggerTime = DateTime.now().setZone(this.config.timezone).plus({ seconds: 2 });
        }

        schedule.scheduleJob(triggerTime.toJSDate(), () => {
          this.executePreFlightAndCast(prayer, audioFile, scheduleTime);
        });

        this.log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')})`);
      });
    } catch (e) {
      this.log(`🚨 CRITICAL SCHEDULER ERROR: ${e.message}`);
    }
  }

  async runNetworkPreFlight() {
    const isOnline = await this.hardware.ping('8.8.8.8');
    if (!isOnline) {
      this.log(`🚨 CRITICAL: Network Down. Rebooting System...`);
      if (process.platform === 'linux' && !process.argv.includes('--test')) await this.hardware.rebootOS();
      return false;
    }
    this.log(`✅ Network Check Passed.`);
    return true;
  }

  /**
   * 1:1 Structural Parity with Legacy findAdhanSpeaker / executePreFlightAndCast
   */
  async executePreFlightAndCast(prayerName, audioFileName, targetTimeObj) {
    if (!(await this.runNetworkPreFlight())) return;

    this.log(`🚀 TRIGGER: ${prayerName} Time! Starting sequence...`);

    // 1. Hardware State (TV)
    const tvIp = process.env.TV_IP;
    let tvWasInterrupted = false;
    let tvWasMuted = false;

    if (tvIp) {
      try {
        const sessionOutput = await this.hardware.adbCommand(tvIp, 'shell dumpsys media_session');
        const isPlaying = sessionOutput && (sessionOutput.includes('state=3') || sessionOutput.includes('state=Playing'));
        if (isPlaying) {
          this.log(`📺 TV is PLAYING. Sending ADB PAUSE...`);
          await this.hardware.adbCommand(tvIp, 'shell input keyevent 127');
          await new Promise(r => setTimeout(r, 1000));
          const verify = await this.hardware.adbCommand(tvIp, 'shell dumpsys media_session');
          if (verify && (verify.includes('state=3') || verify.includes('state=Playing'))) {
            await this.hardware.adbCommand(tvIp, 'shell input keyevent 164');
            tvWasMuted = true;
          } else {
            tvWasInterrupted = true;
          }
        }
      } catch (e) { this.log(`⚠️ TV Error: ${e.message}`); }
    }

    // 2. Prepare Video
    const outputVideoPath = path.join(__dirname, '..', '..', 'images', 'generated', `${prayerName.toLowerCase()}.mp4`);
    const audioPath = path.join(__dirname, '..', 'audio', audioFileName);
    const imgPath = path.join(__dirname, '..', '..', 'images', 'generated', 'current_dashboard.jpg');

    try {
      const today = DateTime.now().setZone(this.config.timezone);
      const displayTime = targetTimeObj ? targetTimeObj.toFormat('h:mm a') : today.toFormat('h:mm a');
      const VisualGenerator = require('../visual_generator.js');
      const vg = new VisualGenerator(this.config);
      const imgBuffer = await vg.generateDashboard(prayerName, displayTime, null, {});
      fs.mkdirSync(path.dirname(imgPath), { recursive: true });
      fs.writeFileSync(imgPath, imgBuffer);
      await this.media.encodeVideoFromImageAndAudio(imgPath, audioPath, outputVideoPath);
    } catch (e) { this.log(`❌ Generation Failed: ${e.message}`); return; }

    if (targetTimeObj) {
      const delay = targetTimeObj.toMillis() - Date.now();
      if (delay > 0) {
        this.log(`⏳ Waiting ${Math.round(delay / 1000)}s for precise time...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    const localIp = this.hardware.getLocalIp();
    const castUrl = `http://${localIp}:${this.config.serverPort}/images/generated/${prayerName.toLowerCase()}.mp4?t=${Date.now()}`;

    // 3. Connect & Cast (LEGACY PORT)
    const scanner = new ChromecastAPI(); // Local scanner instance for parity
    let isCleanedUp = false;
    let safetyTimer = null;
    let originalVolume = null;
    let currentPhase = 'ADHAN';
    let adhanDevice = null;

    const resumeTvSafely = async () => {
      if (!tvIp) return;
      if (tvWasMuted) await this.hardware.adbCommand(tvIp, 'shell input keyevent 164');
      else if (tvWasInterrupted) await this.hardware.adbCommand(tvIp, 'shell input keyevent 126');
    };

    const cleanup = () => {
      if (isCleanedUp) return;

      if (currentPhase === 'ADHAN') {
        this.log(`✨ Adhan Video Finished. Switching to Dua Image...`);
        if (safetyTimer) clearTimeout(safetyTimer);
        currentPhase = 'DUA';
        castDuaImage();
        return;
      }

      if (currentPhase === 'DUA') return;

      isCleanedUp = true;
      currentPhase = 'DONE';
      this.log(`🔄 Playback Ended. Starting cleanup...`);
      resumeTvSafely();

      const finalize = () => {
        try {
          if (adhanDevice) {
            this.log(`🔄 Finalize: Sending stop signal to device...`);
            if (adhanDevice.stop) adhanDevice.stop();
            if (adhanDevice.client) adhanDevice.client.close();
            adhanDevice.close();
          }
        } catch (e) { }

        if (safetyTimer) clearTimeout(safetyTimer);
        
        try {
          this.log(`🔄 Finalize: Destroying scanner instance...`);
          if (scanner) scanner.destroy();
        } catch (e) { }

        if (process.argv.includes('--test')) {
          this.log("🧪 Test Complete. Exiting.");
          setTimeout(() => process.exit(0), 1000);
        }
      };

      if (adhanDevice && originalVolume !== null) {
        this.log(`🔊 Restoring Original Volume to ${(originalVolume * 100).toFixed(0)}%...`);
        adhanDevice.setVolume(originalVolume, (err) => {
          if (err) this.log(`⚠️ Volume Restore Fail: ${err.message}`);
          setTimeout(finalize, 500);
        });
      } else {
        finalize();
      }
    };

    function castDuaImage() {
      const duaUrl = `http://${localIp}:${this.config.serverPort}/images/dua_after_adhan.png`;
      
      // User requested forced stretch in previous turn, keep that logic in visual_generator
      // but here we cast the STRETCHED JPG we generate
      const VisualGenerator = require('../visual_generator.js');
      const vg = new VisualGenerator(this.config);
      const staticDuaPath = path.join(__dirname, '..', '..', 'images', 'dua_after_adhan.png');
      const generatedDuaPath = path.join(__dirname, '..', '..', 'images', 'generated', 'dua.jpg');
      
      vg.generateDua(staticDuaPath).then(buffer => {
        fs.writeFileSync(generatedDuaPath, buffer);
        const stretchedDuaUrl = `http://${localIp}:${this.config.serverPort}/images/generated/dua.jpg?t=${Date.now()}`;
        
        const media = {
          url: stretchedDuaUrl,
          contentType: 'image/jpeg',
          metadata: {
            type: 0,
            metadataType: 0,
            title: `Dua After Adhan`,
            images: [{ url: stretchedDuaUrl }]
          }
        };

        this.log(`🤲 Casting Stretched Dua: ${stretchedDuaUrl}`);
        adhanDevice.play(media, (err) => {
          if (err) {
            this.log(`❌ Dua Cast Error: ${err.message}`);
            cleanup();
          } else {
            this.log(`⏳ Dua Displayed. Waiting 20 seconds...`);
            safetyTimer = setTimeout(() => {
              this.log(`✅ Dua Complete.`);
              currentPhase = 'DONE';
              cleanup();
            }, 20000);
          }
        });
      }).catch(e => {
        this.log(`⚠️ Stretching failed, falling back to static: ${e.message}`);
        adhanDevice.play({ url: duaUrl, contentType: 'image/png' }, () => {
          safetyTimer = setTimeout(cleanup, 20000);
        });
      });
    }

    scanner.on('device', (device) => {
      if (device.friendlyName === this.config.device.name) {
        if (adhanDevice) return;
        adhanDevice = device;
        this.log(`✅ Connected to Adhan Speaker: ${device.friendlyName}`);

        device.getReceiverStatus((err, status) => {
          if (!err && status && status.volume) {
            originalVolume = status.volume.level;
            this.log(`📊 Current Volume: ${(originalVolume * 100).toFixed(0)}%`);
          }

          device.setVolume(this.config.device.targetVolume, (err) => {
            const dashboardUrl = `http://${localIp}:${this.config.serverPort}/images/generated/current_dashboard.jpg?t=${Date.now()}`;
            const media = {
              url: castUrl,
              contentType: 'video/mp4',
              metadata: {
                type: 1,
                metadataType: 0,
                title: `${prayerName} Adhan`,
                images: [{ url: dashboardUrl }]
              }
            };

            device.play(media, (err) => {
              if (err) {
                this.log(`❌ Playback Error: ${err.message}`);
                cleanup();
              } else {
                this.log(`🎶 Playback Started!`);
                safetyTimer = setTimeout(cleanup, 600000);

                let lastState = '';
                device.on('status', (status) => {
                  if (status && status.playerState !== lastState) {
                    this.log(`📊 Device Status: ${status.playerState}`);
                    lastState = status.playerState;
                  }
                  if (!status || status.playerState === 'IDLE') {
                    this.log(`⏹️ Adhan Finished (IDLE).`);
                    cleanup();
                  }
                });

                device.on('finished', () => {
                   this.log(`⏹️ Adhan Finished (Event).`);
                   cleanup();
                });
              }
            });
          });
        });
      }
    });
  }
}

module.exports = CoreScheduler;
