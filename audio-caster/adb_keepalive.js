const path = require('path');
const HardwareService = require('./services/HardwareService');
const DiscoveryService = require('./services/DiscoveryService');
const ScheduleService = require('./services/ScheduleService');
const { DateTime } = require('luxon');

class AdbKeepAlive {
  constructor(hardwareService, targetIp) {
    this.hardware = hardwareService;
    this.targetIp = targetIp;
    
    // Services
    this.discovery = new DiscoveryService(targetIp);
    this.schedule = new ScheduleService(
      path.join(__dirname, 'annual_schedule.json'),
      process.env.TIMEZONE || 'America/Los_Angeles'
    );

    // Dynamic State
    this.state = 'INITIALIZING';
    this.timer = null;
    this.pulseCount = 0;
    this.logPrefix = '🛡️ ADB-KEEPER:';
  }

  log(msg) {
    const time = DateTime.now().setZone(this.schedule.timezone).toFormat('HH:mm:ss');
    console.log(`[${time}] ${this.logPrefix} ${msg}`);
  }

  async transition(newState) {
    if (this.state === newState) return;
    
    this.log(`🔄 State Transition: ${this.state} -> ${newState}`);
    this.state = newState;
    
    // Clear any existing timers
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    switch (newState) {
      case 'ONLINE':
        this.setNextCheck(120000); // 2 mins
        break;
      case 'HUNTING':
        this.setNextCheck(60000); // 1 min
        break;
      case 'SLEEPING':
        this.log('😴 Entering deep sleep. Passive listener active.');
        this.discovery.start();
        // Schedule Safety Pulse (1 hour)
        this.timer = setTimeout(() => this.transition('SAFETY_PULSE'), 3600000);
        break;
      case 'SAFETY_PULSE':
        this.log('💓 Safety Pulse check starting...');
        this.pulseCount = 0;
        this.setNextCheck(60000); // Start mini-hunt (1 min)
        break;
    }
  }

  setNextCheck(ms) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.checkAndHeal(), ms);
  }

  async checkAndHeal() {
    try {
      // 1. Predictive Check: Are we near an Adhan?
      if (this.state !== 'HUNTING' && this.state !== 'ONLINE' && this.schedule.isPreAdhanWindow(15)) {
        this.transition('HUNTING');
        return;
      }

      this.log(`🔍 Checking status for ${this.targetIp} [${this.state}]...`);

      // 2. Connectivity & Power Check (Composite)
      const isDeviceAwake = await this.hardware.isActuallyOn(this.targetIp);

      if (isDeviceAwake) {
        // We found it!
        const devices = await this.hardware.getAdbDevices();
        const isConnected = devices && devices.includes(this.targetIp) && /\bdevice\b/.test(devices);

        if (isConnected) {
          // Double check screen state before claiming ONLINE
          const screen = await this.hardware.checkScreenState(this.targetIp);
          if (screen === 'OFF') {
            this.log(`😴 TV network is up but screen is OFF (Zombie State). Sleeping...`);
            this.transition('SLEEPING');
            return;
          }

          this.log(`✅ ${this.targetIp} is fully connected.`);
          this.transition('ONLINE');
        } else {
          this.log(`⚠️ ${this.targetIp} reachable but not connected. Repairing...`);
          await this.hardware.runExec(`adb disconnect ${this.targetIp}:5555`);
          const res = await this.hardware.runExec(`adb connect ${this.targetIp}:5555`);
          if (res?.includes('connected')) {
            // Re-verify screen after connection
            const screen = await this.hardware.checkScreenState(this.targetIp);
            if (screen === 'OFF') {
              this.log(`😴 TV repaired but screen is OFF. Sleeping...`);
              this.transition('SLEEPING');
            } else {
              this.log(`✅ Repair successful and screen is ON.`);
              this.transition('ONLINE');
            }
          }
        }
      } else {
        // Device is physically OFF or disconnected
        if (this.state === 'ONLINE' || this.state === 'HUNTING') {
          this.log(`❌ Device is offline or in deep standby. transitioning...`);
          this.transition('SLEEPING');
        } else if (this.state === 'SAFETY_PULSE') {
          this.pulseCount++;
          if (this.pulseCount >= 3) {
            this.log('😴 Pulse check finished. No active device found. Back to sleep.');
            this.transition('SLEEPING');
          } else {
            this.setNextCheck(60000); // Continue pulse mini-hunt
          }
        } else {
          this.transition('SLEEPING');
        }
      }
    } catch (e) {
      this.log(`🔥 Error during check: ${e.message}`);
      this.setNextCheck(300000); // Error backoff 5 mins
    }
  }

  startService() {
    this.log(`🚀 Adhan-Smart KeepAlive Starting. Target: ${this.targetIp}`);
    
    // Listen for beacons (Passive discovery)
    this.discovery.on('device-awake', () => {
      if (this.state === 'SLEEPING' || this.state === 'SAFETY_PULSE') {
        this.log('✨ Beacon detected! Waking up...');
        this.checkAndHeal();
      }
    });

    this.checkAndHeal();
  }
}

// MAIN ENTRY
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  const tvIp = process.env.TV_IP;
  if (!tvIp) {
    console.error('❌ TV_IP not found in .env');
    process.exit(1);
  }
  const service = new AdbKeepAlive(new HardwareService(), tvIp);
  service.startService();
}

module.exports = AdbKeepAlive;
