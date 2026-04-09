const ChromecastAPI = require('chromecast-api');

class CastService {
  constructor() {
    this.client = null;
    this.devices = [];
  }

  /**
   * Initializes MDNS scanner
   */
  startScanner(onDeviceFoundCallback) {
    this.client = new ChromecastAPI();
    this.client.on('device', (device) => {
      this.devices.push(device);
      if (onDeviceFoundCallback) onDeviceFoundCallback(device.friendlyName);
    });
  }

  /**
   * Update scan (forces refresh)
   */
  updateScan() {
    if (this.client) this.client.update();
  }

  /**
   * Retrieves a device by exact or partial friendly name
   */
  findDevice(name) {
    return this.devices.find((d) => d.friendlyName === name || d.friendlyName.includes(name));
  }

  /**
   * Sets device volume
   */
  async setVolume(device, targetVolume) {
    return new Promise((resolve, reject) => {
      device.setVolume(targetVolume, (err, newVol) => {
        if (err) return reject(err);
        resolve(newVol);
      });
    });
  }

  /**
   * Casts a media object to a device
   */
  async castMedia(device, mediaUrl, contentType = 'video/mp4') {
    return new Promise((resolve, reject) => {
      const media = {
        url: mediaUrl,
        contentType: contentType,
      };

      device.play(media, (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  }
}

module.exports = CastService;
