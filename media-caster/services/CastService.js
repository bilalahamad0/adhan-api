const ChromecastAPI = require('chromecast-api');

/**
 * Service wrapper for Chromecast interactions. 
 * Note: CoreScheduler V7+ uses local instances for legacy parity.
 */
class CastService {
  constructor() {
    this.client = null;
    this.devices = [];
  }

  startScanner(onDeviceFoundCallback) {
    this.client = new ChromecastAPI();
    this.client.on('device', (device) => {
      this.devices.push(device);
      if (onDeviceFoundCallback) onDeviceFoundCallback(device.friendlyName);
    });
  }

  findDevice(name) {
    return this.devices.find((d) => d.friendlyName === name || d.friendlyName.includes(name));
  }

  destroyScanner() {
    try {
      if (this.client) {
        this.client.destroy();
        this.client = null;
      }
    } catch (e) { }
  }
}

module.exports = CastService;
