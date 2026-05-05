const { exec } = require('child_process');
const os = require('os');

class HardwareService {
  /**
   * Wrapper for child_process.exec to return Promises cleanly.
   * Default 8s timeout + SIGKILL prevents hung adbd from stalling the trigger path
   * — single ADB transport per device, every dumpsys/connect must come back bounded.
   */
  async runExec(command, options = {}) {
    const { timeout = 8000, ...rest } = options;
    return new Promise((resolve) => {
      exec(command, { ...rest, timeout, killSignal: 'SIGKILL' }, (error, stdout) => {
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
}

module.exports = HardwareService;
