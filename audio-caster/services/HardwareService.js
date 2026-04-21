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
   * Retrieves a composite audio status (playing state and mute state)
   * @param {string} ip
   * @returns {Promise<{isPlaying: boolean, isMediaSessionPlaying: boolean, isAudioActive: boolean, isMuted: boolean, isSonyMuted: boolean|null}>}
   */
  async getAudioStatus(ip) {
    const audioRes = await this.adbCommand(ip, "shell dumpsys audio");
    const sessionRes = await this.adbCommand(ip, "shell dumpsys media_session");
    const sonyRes = await this.getSonySpecificStatus(ip);

    // 1. Detection of 'Playing' state (Standard + Media Session + isActive flag)
    const isMediaSessionPlaying = !!(sessionRes && (sessionRes.includes('state=3') || sessionRes.includes('state=Playing')));
    
    // isActive=true check (Critical for Sony TV Live Audio detection)
    const isActive = !!(audioRes && audioRes.includes('isActive:true'));
    
    const isAudioActive = !!(audioRes && (
        isActive || 
        audioRes.includes('state:started') || 
        audioRes.includes('playerState=2') || 
        audioRes.includes('usage=USAGE_MEDIA')
    ));

    // 2. Detection of 'Muted' state (Stream 3 is usually Music/Media)
    // Looking for blocks like "mStreamStates[3]:" ... until next stream or end of string
    const stream3Match = audioRes ? audioRes.match(/mStreamStates\[3\]:([\s\S]*?)(?:\r?\n\s*mStreamStates\[\d+\]:|$)/i) : null;
    const stream3Block = stream3Match ? stream3Match[1] : null;
    let isMuted = stream3Block ? (stream3Block.includes('mMuted: true') || stream3Block.includes('Muted: true')) : false;

    // Fallback for general mute flag
    if (!isMuted && audioRes && /Muted:\s*true/i.test(audioRes)) {
      isMuted = true;
    }

    return { 
      isPlaying: isMediaSessionPlaying || isAudioActive,
      isMediaSessionPlaying,
      isAudioActive,
      isMuted: isMuted,
      isSonyMuted: sonyRes.isSonyMuted
    };
  }

  /**
   * Attempts to retrieve Sony-specific proprietary state
   */
  async getSonySpecificStatus(ip) {
    try {
      const res = await this.adbCommand(ip, "shell dumpsys com.sony.dtv.networkservice");
      if (!res) return { isSonyMuted: null };

      // Look for JSON-like or key-value muted property
      const mutedMatch = res.match(/\"muted\":\s*(\w+)/i) || res.match(/muted=\s*(\w+)/i);
      return {
        isSonyMuted: mutedMatch ? (mutedMatch[1] === 'true' || mutedMatch[1] === '1') : null
      };
    } catch (e) {
      return { isSonyMuted: null };
    }
  }

  /**
   * Sets the mute state only if it differs from the current state
   * @param {string} ip
   * @param {boolean} targetMute
   * @returns {Promise<boolean>} True if action was taken or already in state
   */
  async setMuteState(ip, targetMute) {
    const status = await this.getAudioStatus(ip);
    
    // Use Sony specific state if available as a tie-breaker/extra verification
    const currentMute = (status.isSonyMuted !== null) ? status.isSonyMuted : status.isMuted;



    if (currentMute !== targetMute) {
      // KEYCODE_VOLUME_MUTE = 164
      await this.adbCommand(ip, "shell input keyevent 164");
      return true;
    }
    return false;
  }

  /**
   * Sends a pause command
   */
  async pauseMedia(ip) {
    // KEYCODE_MEDIA_PAUSE = 127
    await this.adbCommand(ip, "shell input keyevent 127");
  }

  /**
   * Sends a play/resume command
   */
  async resumeMedia(ip) {
    // KEYCODE_MEDIA_PLAY = 126
    await this.adbCommand(ip, "shell input keyevent 126");
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

  /**
   * Normalizes a Bluetooth MAC to AA:BB:CC:DD:EE:FF (returns null if invalid).
   * @param {string} mac
   * @returns {string|null}
   */
  static normalizeBluetoothMac(mac) {
    if (!mac || typeof mac !== 'string') return null;
    const hex = mac.toUpperCase().replace(/[^0-9A-F]/g, '');
    if (hex.length !== 12) return null;
    return hex.match(/../g).join(':');
  }

  /**
   * Ensures ADB serial uses explicit TCP port when only an IPv4 is given (matches adb connect …:5555).
   * @param {string} ip
   */
  static ensureAdbTcpSerial(ip) {
    const s = String(ip || '').trim();
    if (!s) return s;
    if (/:\d{2,5}$/.test(s)) return s;
    return `${s}:5555`;
  }

  /**
   * Best-effort parse of A2DP / headset connection for a bonded MAC from bluetooth dumpsys output.
   * OEM formatting varies; returns null only when dumps are unusable (empty / ADB down).
   * @param {string} text
   * @param {string} macNorm AA:BB:… from normalizeBluetoothMac
   * @returns {boolean|null}
   */
  static inferBluetoothAudioConnected(text, macNorm) {
    if (!text || !macNorm) return null;
    const macLo = macNorm.toLowerCase();
    const macCompact = macLo.replace(/:/g, '');
    const hitAt = (hay) => {
      const h = hay.toLowerCase();
      let i = h.indexOf(macLo);
      if (i < 0) i = h.indexOf(macCompact);
      return i;
    };
    const idx = hitAt(text);
    if (idx < 0) {
      if (/bonded|paired|device/i.test(text)) return false;
      return null;
    }
    const win = text.slice(Math.max(0, idx - 400), Math.min(text.length, idx + 900));
    const strongOn =
      /\bSTATE_CONNECTED\b/i.test(win) ||
      /A2dpState:\s*connected/i.test(win) ||
      /(?:A2DP|Headset).{0,120}connected:\s*true/i.test(win) ||
      /(?:isA2dpPlaying|A2dpPlaying)\(\)\s*:\s*true/i.test(win);
    const strongOff =
      /\bSTATE_DISCONNECTED\b/i.test(win) ||
      /A2dpState:\s*disconnected/i.test(win) ||
      /(?:A2DP|Headset).{0,120}connected:\s*false/i.test(win);
    if (strongOn && !strongOff) return true;
    if (strongOff && !strongOn) return false;
    const looseOn = /connected:\s*true/i.test(win) || /\bmState[=:]\s*2\b/.test(win);
    const looseOff = /connected:\s*false/i.test(win) || /\bmState[=:]\s*0\b/.test(win);
    if (looseOn && !looseOff) return true;
    if (looseOff && !looseOn) return false;
    return null;
  }

  /**
   * Pulls only dump lines near the MAC so unrelated "connected: true" elsewhere does not false-positive.
   * @param {string|null|undefined} blob
   * @param {string} macNorm
   */
  static extractBluetoothMacContext(blob, macNorm) {
    if (!blob || !macNorm) return '';
    const macLo = macNorm.toLowerCase();
    const compact = macLo.replace(/:/g, '');
    const lines = blob.split(/\r?\n/);
    const keep = new Set();
    lines.forEach((line, i) => {
      const l = line.toLowerCase();
      if (!l.includes(macLo) && !l.includes(compact)) return;
      for (let j = Math.max(0, i - 6); j <= Math.min(lines.length - 1, i + 12); j++) keep.add(j);
    });
    return [...keep]
      .sort((a, b) => a - b)
      .map((i) => lines[i])
      .join('\n');
  }

  /**
   * Strict: only strong A2DP/ACL style signals; ambiguous -> false (prefer reconnect).
   * Set TV_BT_LOOSE_PARSE=1 to use inferBluetoothAudioConnected (legacy, wider false positives).
   */
  static inferBluetoothAudioConnectedStrict(text, macNorm) {
    if (!text || !macNorm) return null;
    const t = text.toLowerCase();
    const macLo = macNorm.toLowerCase();
    const compact = macLo.replace(/:/g, '');
    if (!t.includes(macLo) && !t.includes(compact)) return null;
    const strongOn =
      /\bSTATE_CONNECTED\b/i.test(text) ||
      /A2dpState:\s*connected/i.test(text) ||
      /\bBOND_CONNECTED\b/i.test(text) ||
      /\bprofile.*a2dp.*\bconnected\b/i.test(t) ||
      /\bisconnected\(\)\s*true\b/i.test(text) ||
      /\bconnectionstate[=:]\s*2\b/i.test(t) ||
      /\bmconnectstate[=:]\s*2\b/i.test(t);
    const strongOff =
      /\bSTATE_DISCONNECTED\b/i.test(text) ||
      /A2dpState:\s*disconnected/i.test(text) ||
      /\bBOND_NONE\b/i.test(text) ||
      /\bprofile.*a2dp.*\bdisconnected\b/i.test(t) ||
      /\bisconnected\(\)\s*false\b/i.test(text) ||
      /\bconnectionstate[=:]\s*0\b/i.test(t) ||
      /\bmconnectstate[=:]\s*0\b/i.test(t);
    if (strongOn && !strongOff) return true;
    if (strongOff && !strongOn) return false;
    return false;
  }

  /**
   * Connect/disconnect status for an already-paired MAC (best-effort from dumpsys). Does not pair.
   * @param {string} ip ADB target (same convention as adbCommand elsewhere)
   * @param {string} macNorm
   * @returns {Promise<boolean|null>} true=connected, false=disconnected/not found in bonded context, null=unknown
   */
  async isBluetoothSpeakerConnectedForAudio(ip, macNorm) {
    const serial = HardwareService.ensureAdbTcpSerial(ip);
    const full1 = await this.adbCommand(serial, 'shell dumpsys bluetooth_manager');
    const full2 = await this.adbCommand(serial, 'shell dumpsys bluetooth');
    const full3 = await this.adbCommand(serial, 'shell dumpsys media.bluetooth_a2dp');
    const mergedFull = [full1, full2, full3].filter(Boolean).join('\n');
    if (!mergedFull) return null;

    const ctx1 = HardwareService.extractBluetoothMacContext(full1, macNorm);
    const ctx2 = HardwareService.extractBluetoothMacContext(full2, macNorm);
    const ctx3 = HardwareService.extractBluetoothMacContext(full3, macNorm);
    const narrow = [ctx1, ctx2, ctx3].filter(Boolean).join('\n\n');

    if (!narrow) {
      if (/bonded|paired|device/i.test(mergedFull)) return false;
      return null;
    }

    const loose = ['1', 'true', 'yes'].includes(
      String(process.env.TV_BT_LOOSE_PARSE || '')
        .trim()
        .toLowerCase()
    );
    if (loose) {
      return HardwareService.inferBluetoothAudioConnected(narrow, macNorm);
    }
    return HardwareService.inferBluetoothAudioConnectedStrict(narrow, macNorm);
  }

  /**
   * Parses TV_BT_EXTRA_CONNECT_COMMANDS: newline- or || -separated adb "shell …" fragments (optional "shell " prefix).
   * Each line may include `{MAC}`.
   * @param {string|undefined} raw
   * @param {string} macNorm
   * @returns {string[]}
   */
  static parseExtraBluetoothConnectCommands(raw, macNorm) {
    if (!raw || typeof raw !== 'string') return [];
    const sub = (s) => s.replace(/\{MAC\}/gi, macNorm).trim();
    return raw
      .split(/\|\||\r?\n/)
      .map((s) => sub(s))
      .filter(Boolean)
      .map((line) => (line.startsWith('shell ') ? line : `shell ${line}`));
  }

  /**
   * Requests reconnect for an already-paired speaker only (shell connect). No pairing flow.
   * Order: TV_BT_CONNECT_COMMAND → stock `cmd` connect variants (AOSP names differ by release/OEM) →
   * TV_BT_EXTRA_CONNECT_COMMANDS → optional TV_BT_SVC_RESET (`svc bluetooth` radio bounce).
   * Many retail TVs (including some Sony BRAVIA builds) ship **no** `cmd bluetooth_*` implementation; in that case
   * only `dumpsys` status, `svc bluetooth`, or a device-specific `TV_BT_CONNECT_COMMAND` from `adb shell cmd -l` /
   * `cmd <name> help` on *your* firmware can work — there is no single cross-OEM MAC connect API exposed to shell.
   * @param {string} ip
   * @param {string} macNorm
   * @returns {Promise<boolean>} true if a command ran without immediate ADB failure (connection is verified separately)
   */
  async requestBluetoothSpeakerConnect(ip, macNorm) {
    const serial = HardwareService.ensureAdbTcpSerial(ip);
    const custom = process.env.TV_BT_CONNECT_COMMAND;
    if (custom && String(custom).trim()) {
      const out = await this.adbCommand(serial, String(custom).trim().replace(/\{MAC\}/gi, macNorm));
      return out !== null;
    }

    const enableNudges = [
      'shell cmd bluetooth_adapter enable',
      'shell cmd bluetooth enable',
      'shell cmd bluetooth_manager enable',
    ];
    for (const cmd of enableNudges) {
      await this.adbCommand(serial, cmd);
    }

    const attempts = [
      `shell cmd bluetooth connect ${macNorm}`,
      `shell cmd bluetooth connect-a2dp ${macNorm}`,
      `shell cmd bluetooth connect_a2dp ${macNorm}`,
      `shell cmd bluetooth_adapter connect ${macNorm}`,
      `shell cmd bluetooth_manager connect ${macNorm}`,
      `shell cmd bt_adapter connect ${macNorm}`,
    ];
    for (const cmd of attempts) {
      const out = await this.adbCommand(serial, cmd);
      if (out !== null) return true;
    }

    const extras = HardwareService.parseExtraBluetoothConnectCommands(
      process.env.TV_BT_EXTRA_CONNECT_COMMANDS,
      macNorm
    );
    for (const cmd of extras) {
      const out = await this.adbCommand(serial, cmd);
      if (out !== null) return true;
    }

    const svcReset = ['1', 'true', 'yes'].includes(
      String(process.env.TV_BT_SVC_RESET || '')
        .trim()
        .toLowerCase()
    );
    if (svcReset) {
      const out = await this.adbCommand(
        serial,
        'shell "svc bluetooth disable; sleep 2; svc bluetooth enable"'
      );
      if (out !== null) {
        await new Promise((r) => setTimeout(r, 4000));
        return true;
      }
    }

    return false;
  }
}

module.exports = HardwareService;
