const HardwareService = require('../services/HardwareService');

describe('HardwareService Mute & Audio Status Logic', () => {
  let hardware;
  let adbMocks;
  let commandsSent;

  beforeEach(() => {
    hardware = new HardwareService();
    adbMocks = { audio: '', mediaSession: '', sony: '' };
    commandsSent = [];

    hardware.runExec = jest.fn(async (cmd) => {
      if (cmd.includes('dumpsys audio')) return adbMocks.audio;
      if (cmd.includes('dumpsys media_session')) return adbMocks.mediaSession;
      if (cmd.includes('com.sony.dtv.networkservice')) return adbMocks.sony;
      return 'OK';
    });

    hardware.adbCommand = jest.fn(async (ip, cmd) => {
      commandsSent.push(cmd);
      if (cmd.includes('dumpsys audio')) return adbMocks.audio;
      if (cmd.includes('dumpsys media_session')) return adbMocks.mediaSession;
      if (cmd.includes('com.sony.dtv.networkservice')) return adbMocks.sony;
      return 'OK';
    });
  });

  test('detects playing+unmuted live channel and sends mute toggle', async () => {
    adbMocks.audio = 'mStreamStates[3]:\n   mMuted: false\n   playerState=2\n   state:started';
    adbMocks.mediaSession = 'No active sessions';
    adbMocks.sony = '{"muted": false}';

    const status = await hardware.getAudioStatus('10.0.0.80');
    expect(status.isPlaying).toBe(true);
    expect(status.isMuted).toBe(false);

    await hardware.setMuteState('10.0.0.80', true);
    expect(commandsSent).toContain('shell input keyevent 164');
  });

  test('skips mute toggle when already muted', async () => {
    adbMocks.audio = 'mStreamStates[3]:\n   mMuted: true';
    adbMocks.sony = '{"muted": true}';

    await hardware.setMuteState('10.0.0.80', true);
    expect(commandsSent).not.toContain('shell input keyevent 164');
  });

  test('trusts Sony muted state over Android audio status', async () => {
    adbMocks.audio = 'mStreamStates[3]:\n   mMuted: false';
    adbMocks.sony = '{"muted": true}';

    const status = await hardware.getAudioStatus('10.0.0.80');
    expect(status.isSonyMuted).toBe(true);

    await hardware.setMuteState('10.0.0.80', true);
    expect(commandsSent).not.toContain('shell input keyevent 164');
  });
});
