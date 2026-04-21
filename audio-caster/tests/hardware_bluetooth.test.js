const HardwareService = require('../services/HardwareService');

describe('HardwareService Bluetooth helpers', () => {
  test('extractBluetoothMacContext captures nearby lines', () => {
    const blob = 'header\nfoo 38:9B:73:91:BD:83 bar\nmid\nSTATE_CONNECTED\ntrailer';
    const ctx = HardwareService.extractBluetoothMacContext(blob, '38:9B:73:91:BD:83');
    expect(ctx).toContain('38:9B:73:91:BD:83');
    expect(ctx).toContain('STATE_CONNECTED');
  });

  test('inferBluetoothAudioConnectedStrict is true for STATE_CONNECTED near MAC', () => {
    const narrow = '38:9B:73:91:BD:83 blah\nSTATE_CONNECTED';
    expect(HardwareService.inferBluetoothAudioConnectedStrict(narrow, '38:9B:73:91:BD:83')).toBe(true);
  });

  test('inferBluetoothAudioConnectedStrict is false for STATE_DISCONNECTED', () => {
    const narrow = '38:9B:73:91:BD:83\nSTATE_DISCONNECTED';
    expect(HardwareService.inferBluetoothAudioConnectedStrict(narrow, '38:9B:73:91:BD:83')).toBe(false);
  });

  test('inferBluetoothAudioConnectedStrict ambiguous -> false', () => {
    const narrow = '38:9B:73:91:BD:83\nother text without strong signals';
    expect(HardwareService.inferBluetoothAudioConnectedStrict(narrow, '38:9B:73:91:BD:83')).toBe(false);
  });

  test('parseExtraBluetoothConnectCommands splits || and newlines and normalizes shell prefix', () => {
    const raw = 'cmd foo connect {MAC}||shell cmd bar {MAC}\ncmd baz {MAC}';
    const cmds = HardwareService.parseExtraBluetoothConnectCommands(raw, 'AA:BB:CC:DD:EE:FF');
    expect(cmds).toEqual([
      'shell cmd foo connect AA:BB:CC:DD:EE:FF',
      'shell cmd bar AA:BB:CC:DD:EE:FF',
      'shell cmd baz AA:BB:CC:DD:EE:FF',
    ]);
  });
});
