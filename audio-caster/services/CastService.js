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
  async castMedia(device, mediaUrl, contentType = 'video/mp4', metadata = null) {
    return new Promise((resolve, reject) => {
      const media = {
        url: mediaUrl,
        contentType: contentType,
      };
      if (metadata) media.metadata = metadata;

      device.play(media, (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  }

  /**
   * Fetches Receiver constraints (e.g. baseline Volume)
   */
  async getReceiverStatus(device) {
     return new Promise((resolve, reject) => {
        device.getReceiverStatus((err, status) => {
           if (err) return reject(err);
           resolve(status);
        });
     });
  }

  /**
   * Fetches Media Controller status (playerState IDLE vs PLAYING)
   */
  async getStatus(device) {
     return new Promise((resolve, reject) => {
        device.getStatus((err, status) => {
           if (err) return reject(err);
           resolve(status);
        });
     });
  }

  /**
   * Hard stops the receiver application to force Home screen return
   */
  stopApp(device) {
    try { if (device.stop) device.stop(); } catch (e) { }
  }

  /**
   * Soft closes clients explicitly
   */
  /**
   * Soft closes clients explicitly
   */
  closeClient(device) {
    try {
      if (device.client) device.client.close();
      device.close();
    } catch (e) { }
  }

  /**
   * Hard destroys the scanner and all underlying sockets (Legacy Parity)
   */
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
