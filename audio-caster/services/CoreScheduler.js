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
   * Daily Scheduling Engine (Invoked by boot.js)
   */
  async scheduleToday() {
    this.log("📅 Loading Schedule...");
    const fs = require('fs');
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

    const today = DateTime.now().setZone(this.config.timezone);
    const month = today.month.toString();
    const day = today.day.toString();
    const monthData = annualData.data[month];
    if (!monthData) return this.log('❌ Calendar Error: Month missing.');

    const todayEntry = monthData.find((d) => parseInt(d.date.gregorian.day) === today.day);
    if (!todayEntry) return this.log('❌ Calendar Error: Day missing.');

    const timings = todayEntry.timings;
    this.log(`✅ Today's Prayer Times (${todayEntry.date.readable}):`);

    const prayers = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

    prayers.forEach((prayer) => {
        let timeStr = timings[prayer].split(' ')[0];
        const [hours, minutes] = timeStr.split(':');
        const scheduleTime = today.set({ hour: parseInt(hours), minute: parseInt(minutes), second: 0 });
        const PREP_BUFFER_MINUTES = 5;

        if (scheduleTime < DateTime.now().setZone(this.config.timezone)) return;

        const audioKey = prayer === 'Fajr' ? this.config.audio.fajrCurrent : this.config.audio.regularCurrent;
        const audioFile = `${audioKey}.mp3`;

        let triggerTime = scheduleTime.minus({ minutes: PREP_BUFFER_MINUTES });
        if (triggerTime < DateTime.now().setZone(this.config.timezone)) {
            triggerTime = DateTime.now().setZone(this.config.timezone).plus({ seconds: 2 });
        }

        schedule.scheduleJob(triggerTime.toJSDate(), () => {
            this.executePreFlightAndCast(prayer, audioFile, scheduleTime);
        });

        this.log(`   - ${prayer}: ${timeStr} (Trigger: ${triggerTime.toFormat('h:mm:ss a')})`);
    });
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
      let displayTime = targetTimeObj ? targetTimeObj.toFormat('h:mm a') : null;
      let hijriDate = null;
      let holidays = [];
      const today = DateTime.now().setZone(this.config.timezone);

      try {
          const annualData = this.getAnnualData();
          if (annualData && annualData.data) {
              const m = today.month.toString();
              const d = today.day;
              if (annualData.data[m] && annualData.data[m][d - 1]) {
                  const entry = annualData.data[m][d - 1];
                  // Extract Schedule time natively if missing
                  if (!displayTime && entry.timings && entry.timings[prayerName]) {
                      displayTime = entry.timings[prayerName].split(' ')[0]; // E.g., '19:38'
                      const [hours, minutes] = displayTime.split(':');
                      displayTime = today.set({ hour: parseInt(hours), minute: parseInt(minutes), second: 0 }).toFormat('h:mm a');
                  }
                  
                  const h = entry.date.hijri;
                  hijriDate = `${h.day} ${h.month.en} ${h.year}`;
                  holidays = h.holidays || [];
              }
          }
      } catch (e) {
          this.log(`⚠️ Metadata Parse Warning: ${e.message}`);
      }
      
      // Strict Fallback
      if (!displayTime) displayTime = today.toFormat('h:mm a');
      const isFriday = today.weekday === 5;

      // a. Generate Image Overlay
      const VisualGenerator = require('../visual_generator.js');
      const vg = new VisualGenerator(this.config);
      const imgBuffer = await vg.generateDashboard(prayerName, displayTime, hijriDate, { holidays, isFriday });
      
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
          
          let originalVolume = null;
          let isCleanedUp = false;
          let safetyTimer = null;
          let currentPhase = 'ADHAN';
          
          const resumeTvSafely = async () => {
            if (tvWasMuted) {
              this.log(`🔊 Unmuting Sony TV...`);
              await this.hardware.adbCommand(tvIp, 'shell input keyevent 164');
              tvWasMuted = false;
            } else if (tvWasInterrupted) {
              this.log(`▶️ Resuming Sony TV...`);
              await this.hardware.adbCommand(tvIp, 'shell input keyevent 126');
              tvWasInterrupted = false;
            }
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
             
             const finalize = async () => {
               await this.cast.stopMedia(device);
               this.cast.closeClient(device);
               if (safetyTimer) clearTimeout(safetyTimer);
               
               if (process.argv.includes('--test')) {
                  this.log("🧪 Test Complete. Exiting in 1 second.");
                  setTimeout(() => process.exit(0), 1000);
               }
             };

             if (originalVolume !== null) {
                this.log(`🔊 Restoring Original Volume to ${(originalVolume * 100).toFixed(0)}%...`);
                this.cast.setVolume(device, originalVolume).then(() => {
                   setTimeout(finalize, 500);
                }).catch(() => finalize());
             } else {
                finalize();
             }
          };
          
          const castDuaImage = () => {
             const duaUrl = `http://${localIp}:${this.config.serverPort}/images/dua_after_adhan.png`;
             this.log(`🤲 Casting Dua Image: ${duaUrl}`);
             const metadata = { type: 0, metadataType: 0, title: `Dua After Adhan`, images: [{ url: duaUrl }] };
             this.cast.castMedia(device, duaUrl, 'image/png', metadata).then(() => {
                this.log(`⏳ Dua Displayed. Waiting 20 seconds...`);
                safetyTimer = setTimeout(() => {
                   this.log(`✅ Dua Complete.`);
                   currentPhase = 'DONE';
                   cleanup();
                }, 20000);
             }).catch((err) => {
                this.log(`❌ Dua Cast Error: ${err.message}`);
                currentPhase = 'DONE';
                cleanup();
             });
          };

          // Fetch Original Volume
          try {
             this.cast.getReceiverStatus(device).then(status => {
                if (status && status.volume) {
                   originalVolume = status.volume.level;
                   this.log(`📊 Current Volume: ${(originalVolume * 100).toFixed(0)}% (Saved for restore)`);
                }
                
                // Set Volume and Cast
                this.cast.setVolume(device, this.config.device.targetVolume).then(() => {
                   this.log(`🔊 Volume set to ${(this.config.device.targetVolume * 100).toFixed(0)}%`);
                   const metadata = { type: 1, metadataType: 0, title: `${prayerName} Adhan`, images: [{ url: castUrl }] };
                   this.cast.castMedia(device, castUrl, 'video/mp4', metadata).then(() => {
                      this.log(`🎶 Playback Started! Playing ${prayerName} on ${friendlyName}`);
                      safetyTimer = setTimeout(cleanup, 600000); // 10m fallback
                      
                      // Explicit force volume set after media instantiation (fixes cast session race condition)
                      setTimeout(() => {
                         this.cast.setVolume(device, this.config.device.targetVolume).catch(() => {});
                      }, 2000);
                      
                      // Active Polling Loop 
                      let lastStatusTime = Date.now();
                      let lastState = '';
                      let lastStateChangeTime = Date.now();
                      let pollingActive = true;
                      
                      const statusHandler = (status) => {
                         lastStatusTime = Date.now();
                         if (status && status.playerState !== lastState) {
                             this.log(`📊 Device Status: ${status.playerState}`);
                             lastState = status.playerState;
                             lastStateChangeTime = Date.now();
                         }
                         if (!status || status.playerState === 'IDLE') {
                             this.log(`⏹️ Adhan Finished (IDLE).`);
                             cleanup();
                         }
                      };
                      
                      // Native Event Registration
                      device.on('status', statusHandler);
                      device.on('finished', () => {
                         this.log(`⏹️ Adhan Finished (Event).`);
                         cleanup();
                      });
                      
                      const pollLoop = () => {
                         if (isCleanedUp || !pollingActive) return;
                         const now = Date.now();
                         
                         if (now - lastStatusTime > 300000) return cleanup();
                         if ((lastState === 'PAUSED' || lastState === 'BUFFERING') && (now - lastStateChangeTime > 180000)) return cleanup();
                         
                         this.cast.getStatus(device).then(s => {
                            statusHandler(s);
                            if (!isCleanedUp && pollingActive) setTimeout(pollLoop, 3000);
                         }).catch((e) => {
                            const msg = e.message.toLowerCase();
                            if (msg.includes('closed') || msg.includes('destroyed')) cleanup();
                            else if (!isCleanedUp && pollingActive) setTimeout(pollLoop, 3000);
                         });
                      };
                      
                      pollLoop(); // Start polling
                   }).catch((err) => {
                      this.log(`❌ Cast Error: ${err.message}`);
                      cleanup();
                   });
                }).catch((err) => {
                   this.log(`❌ Volume Set Error: ${err.message}`);
                   cleanup();
                });
             }).catch(e => {
                this.log(`❌ Device Pre-Flight Error: ${e}`);
             });
          } catch(e) { 
             this.log(`❌ Init Cast err: ${e}`); 
          }
        }
      }
    });
  }
}

module.exports = CoreScheduler;
