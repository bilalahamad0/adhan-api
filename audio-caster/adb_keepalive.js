require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const HardwareService = require('./services/HardwareService');

class AdbKeepAlive {
  constructor(hardwareService, targetIp = '127.0.0.1', intervalMs = 120000) {
    this.hardware = hardwareService;
    this.targetIp = targetIp;
    this.intervalMs = intervalMs;
    this.intervalId = null;
    this.log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] 🛡️ ADB-KEEPER: ${msg}`);
  }

  async checkAndHeal() {
    try {
      this.log(`🔍 Checking status for ${this.targetIp}...`);

      // 1. Pre-Flight Ping
      const isPingable = await this.hardware.ping(this.targetIp, 2);
      if (!isPingable) {
        this.log(`❌ Ping Failed. TV seems offline/sleeping. Skipping ADB check.`);
        return;
      }

      // 2. Check Connection State
      const devices = await this.hardware.getAdbDevices();

      // If server is dead, start it
      if (!devices) {
        this.log('⚠️ ADB Server down. Restarting...');
        await this.hardware.startAdbServer();
      }

      const isConnected =
        devices &&
        devices.split('\n').some((line) => line.includes(this.targetIp) && /\bdevice\b/.test(line));

      if (isConnected) {
        // Keep active by running a dummy command
        await this.hardware.adbCommand(this.targetIp, 'shell date');
      } else {
        // 3. Repair Logic (Force Disconnect -> Connect)
        this.log(`⚠️ Connection Lost. Attempting repair...`);

        // Disconnect
        await this.hardware.runExec(`adb disconnect ${this.targetIp}`);

        // Connect
        const connectOut = await this.hardware.runExec(`adb connect ${this.targetIp}`);

        if (
          connectOut &&
          (connectOut.includes('connected to') || connectOut.includes('already connected'))
        ) {
          this.log(`✅ Reconnected successfully.`);
        } else {
          this.log(`❌ Reconnect failed: ${connectOut}`);
        }
      }
    } catch (e) {
      this.log(`🔥 Error: ${e.message}`);
    }
  }

  startService() {
    this.log(`🚀 ADB Keep-Alive Service Started. Target: ${this.targetIp}`);
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

if (require.main === module) {
  const service = new AdbKeepAlive(new HardwareService(), process.env.TV_IP);
  service.startService();
}

module.exports = AdbKeepAlive;
