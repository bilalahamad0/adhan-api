const { exec } = require('child_process');
const os = require('os');

class HardwareService {
  /**
   * Wrapper for child_process.exec to return Promises cleanly
   */
  async runExec(command, options = {}) {
    return new Promise((resolve) => {
      exec(command, options, (error, stdout, stderr) => {
        if (error) {
          resolve(null);
        } else {
          resolve(stdout ? stdout.trim() : '');
        }
      });
    });
  }

  /**
   * Pings an IP address to determine network connectivity
   * @param {string} ip
   * @param {number} timeoutSeconds
   * @returns {Promise<boolean>}
   */
  async ping(ip, timeoutSeconds = 2) {
    try {
      return new Promise((resolve) => {
        exec(`ping -c 1 -W ${timeoutSeconds} ${ip}`, (err) => {
          resolve(!err);
        });
      });
    } catch (e) {
      return false;
    }
  }

  /**
   * Performs a composite check to see if the TV is actually awake.
   * Checks network connectivity AND physical screen state via ADB.
   */
  async isActuallyOn(ip) {
    const isPingable = await this.ping(ip);
    if (!isPingable) return false;

    // If pingable, check ADB screen state
    const screenState = await this.checkScreenState(ip);
    
    // If we can't get screen state (ADB issue), we fall back to ping only
    // to avoid false negatives, but we log the state.
    if (screenState === 'OFF') {
      return false;
    }
    
    return true;
  }

  /**
   * Checks the physical screen state via ADB
   * Returns 'ON', 'OFF', or 'UNKNOWN'
   */
  async checkScreenState(ip) {
    try {
      // Look for mScreenOn=true or mHoldingDisplaySuspendBlocker=true (Sony TV specific)
      const res = await this.adbCommand(ip, "shell dumpsys power");
      if (!res) return 'UNKNOWN';

      const isScreenOn = res.includes('mScreenOn=true') || 
                        res.includes('mHoldingDisplaySuspendBlocker=true') ||
                        res.includes('Display Power: state=ON');
      
      return isScreenOn ? 'ON' : 'OFF';
    } catch (e) {
      return 'UNKNOWN';
    }
  }

  /**
   * Reboots the physical OS (usually Linux/Pi)
   */
  async rebootOS() {
    if (process.platform === 'linux') {
      await this.runExec('sudo reboot');
      return true;
    }
    return false; // Safely ignore on Macs/Windows dev machines
  }

  /**
   * Retrieves host IP, preferring manually set config or finding external interface
   */
  getLocalIp(envHostIpOverride) {
    if (envHostIpOverride) {
      return envHostIpOverride;
    }
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  /**
   * Runs an ADB command against a specific IP
   */
  async adbCommand(ip, rawCmd) {
    return await this.runExec(`adb -s ${ip} ${rawCmd}`);
  }

  /**
   * Retrieves current adb devices list
   */
  async getAdbDevices() {
    return await this.runExec('adb devices');
  }

  async startAdbServer() {
    await this.runExec('adb keygen ~/.android/adbkey');
    await this.runExec('adb start-server');
  }
}

module.exports = HardwareService;
