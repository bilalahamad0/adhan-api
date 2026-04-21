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

describe('HardwareService requestBluetoothSpeakerConnect', () => {
  const mac = 'AA:BB:CC:DD:EE:FF';
  let service;

  beforeEach(() => {
    service = new HardwareService();
    jest.restoreAllMocks();
    delete process.env.TV_BT_CONNECT_COMMAND;
    delete process.env.TV_BT_SPEAKER_NAME;
    delete process.env.TV_BT_SVC_RESET;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.TV_BT_CONNECT_COMMAND;
    delete process.env.TV_BT_SPEAKER_NAME;
    delete process.env.TV_BT_SVC_RESET;
  });

  test('uses TV_BT_CONNECT_COMMAND first with MAC replacement', async () => {
    process.env.TV_BT_CONNECT_COMMAND = 'shell custom_connect --mac {MAC}';
    const adbSpy = jest.spyOn(service, 'adbCommand').mockResolvedValue('ok');

    const result = await service.requestBluetoothSpeakerConnect('1.2.3.4', mac);

    expect(result).toBe(true);
    expect(adbSpy).toHaveBeenCalledTimes(1);
    expect(adbSpy).toHaveBeenCalledWith('1.2.3.4:5555', 'shell custom_connect --mac AA:BB:CC:DD:EE:FF');
  });

  test('uses TV_BT_SPEAKER_NAME broadcast before stock cmd fallbacks', async () => {
    process.env.TV_BT_SPEAKER_NAME = 'Living Room Speaker';
    const adbSpy = jest.spyOn(service, 'adbCommand').mockResolvedValueOnce('Broadcast completed');

    const result = await service.requestBluetoothSpeakerConnect('1.2.3.4', mac);

    expect(result).toBe(true);
    expect(adbSpy).toHaveBeenCalledTimes(1);
    expect(adbSpy).toHaveBeenCalledWith(
      '1.2.3.4:5555',
      'shell am broadcast -a com.saihgupr.btcontrol.ACTION_CONNECT -n com.saihgupr.btcontrol/.BluetoothControlReceiver -e name "Living Room Speaker"'
    );
  });

  test('falls back through stock bluetooth cmd attempts in order', async () => {
    const adbSpy = jest
      .spyOn(service, 'adbCommand')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('connected');

    const result = await service.requestBluetoothSpeakerConnect('1.2.3.4', mac);

    expect(result).toBe(true);
    expect(adbSpy).toHaveBeenCalledTimes(2);
    expect(adbSpy).toHaveBeenNthCalledWith(1, '1.2.3.4:5555', `shell cmd bluetooth_adapter connect ${mac}`);
    expect(adbSpy).toHaveBeenNthCalledWith(2, '1.2.3.4:5555', `shell cmd bluetooth_manager connect ${mac}`);
  });

  test('uses svc bluetooth reset fallback when enabled and cmd attempts fail', async () => {
    jest.useFakeTimers();
    process.env.TV_BT_SVC_RESET = '1';
    const adbSpy = jest
      .spyOn(service, 'adbCommand')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('svc toggled');

    const promise = service.requestBluetoothSpeakerConnect('1.2.3.4', mac);
    await jest.advanceTimersByTimeAsync(4000);
    const result = await promise;

    expect(result).toBe(true);
    expect(adbSpy).toHaveBeenCalledTimes(4);
    expect(adbSpy).toHaveBeenLastCalledWith(
      '1.2.3.4:5555',
      'shell "svc bluetooth disable; sleep 2; svc bluetooth enable"'
    );
  });

  test('returns false when all reconnect command paths fail', async () => {
    process.env.TV_BT_SVC_RESET = '1';
    const adbSpy = jest.spyOn(service, 'adbCommand').mockResolvedValue(null);

    const result = await service.requestBluetoothSpeakerConnect('1.2.3.4', mac);

    expect(result).toBe(false);
    expect(adbSpy).toHaveBeenCalledTimes(4);
  });
});
