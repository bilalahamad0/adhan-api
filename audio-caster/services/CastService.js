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
   * Halts media explicitly
   */
  async stopMedia(device) {
     return new Promise((resolve) => {
        try { if (device.stop) device.stop(() => resolve(true)); else resolve(true); } 
        catch (e) { resolve(false); }
     });
  }

  /**
   * Soft closes clients explicitly
   */
  closeClient(device) {
     try { if (device.client) device.client.close(); device.close(); } catch(e){}
  }
}

module.exports = CastService;
