const path = require('path');
const fs = require('fs');
const HardwareService = require('./services/HardwareService');

// Environment is loaded in the main entry point or by the caller

class AdbKeepAlive {
  constructor(hardwareService, targetIp, intervalMs = 120000) {
    this.hardware = hardwareService;
    this.targetIp = targetIp;
    this.intervalMs = intervalMs;
    this.intervalId = null;
    this.logPrefix = '🛡️ ADB-KEEPER:';
  }

  log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${this.logPrefix} ${msg}`);
  }

  async checkAndHeal() {
    if (!this.targetIp || this.targetIp === '127.0.0.1') {
      this.log(`❌ ERROR: TV_IP is not configured or set to localhost. Please check your .env file.`);
      return;
    }

    try {
      this.log(`🔍 Checking status for ${this.targetIp}...`);

      // 1. Pre-Flight Ping
      const isPingable = await this.hardware.ping(this.targetIp, 2);
      if (!isPingable) {
        this.log(`❌ Ping Failed. TV (${this.targetIp}) seems offline or sleeping.`);
        return;
      }

      // 2. Check Connection State
      const devices = await this.hardware.getAdbDevices();

      // If server is dead, start it
      if (devices === null) {
        this.log('⚠️ ADB Server down. Restarting...');
        await this.hardware.startAdbServer();
        return;
      }

      const isConnected = devices.split('\n').some((line) =>
        line.includes(this.targetIp) && /\bdevice\b/.test(line)
      );

      if (isConnected) {
        this.log(`✅ ${this.targetIp} is online. Pulse check...`);
        await this.hardware.adbCommand(this.targetIp, 'shell date');
      } else {
        // 3. Repair Logic (Force Disconnect -> Connect)
        this.log(`⚠️ ${this.targetIp} not in device list. Attempting repair...`);

        // Disconnect
        await this.hardware.runExec(`adb disconnect ${this.targetIp}:5555`);

        // Connect
        const connectOut = await this.hardware.runExec(`adb connect ${this.targetIp}:5555`);

        if (connectOut && (connectOut.includes('connected to') || connectOut.includes('already connected'))) {
          this.log(`✅ Reconnected to ${this.targetIp} successfully.`);
        } else {
          this.log(`❌ Reconnect to ${this.targetIp} failed: ${connectOut || 'Timeout'}`);
        }
      }
    } catch (e) {
      this.log(`🔥 Unexpected Error during check: ${e.message}`);
    }
  }

  startService() {
    this.log(`🚀 Starting Service. Target: ${this.targetIp || 'UNDEFINED'}`);
    this.checkAndHeal();

    if (!this.intervalId) {
      this.intervalId = setInterval(() => this.checkAndHeal(), this.intervalMs);
    }
  }

  stopService() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

// MAIN ENTRY
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
  const tvIp = process.env.TV_IP;
  const service = new AdbKeepAlive(new HardwareService(), tvIp);
  service.startService();
}

module.exports = AdbKeepAlive;
