const mdns = require('multicast-dns');
const EventEmitter = require('events');

/**
 * Passive Discovery Service
 * Listens for mDNS advertisements from the network.
 * If the TV wakes up, it usually broadcasts on _googlecast._tcp or similar.
 */
class DiscoveryService extends EventEmitter {
  constructor(targetIp) {
    super();
    this.targetIp = targetIp;
    this.mdns = null;
    this.isListening = false;
  }

  start() {
    if (this.isListening) return;

    try {
      this.mdns = mdns();
      this.mdns.on('response', (response) => this.handlePacket(response));
      this.mdns.on('query', (query) => this.handlePacket(query));
      this.isListening = true;
      console.log(`[Discovery] 📡 Passive listener started for ${this.targetIp}`);
    } catch (e) {
      console.error(`[Discovery] ❌ Failed to start mDNS listener: ${e.message}`);
    }
  }

  stop() {
    if (this.mdns) {
      this.mdns.destroy();
      this.mdns = null;
    }
    this.isListening = false;
  }

  handlePacket(packet) {
    // Check answers, additionals, or questions for the target IP
    const allRecords = [
      ...(packet.answers || []),
      ...(packet.additionals || []),
      ...(packet.authorities || [])
    ];

    const foundTarget = allRecords.some(record => {
      // Look for A records matching our target IP
      if (record.type === 'A' && record.data === this.targetIp) {
        return true;
      }
      // Or look for PTR/SRV records that might mention the TV's name (less reliable without name)
      return false;
    });

    if (foundTarget) {
      this.emit('device-awake', { ip: this.targetIp, source: 'mDNS' });
    }
  }
}

module.exports = DiscoveryService;
