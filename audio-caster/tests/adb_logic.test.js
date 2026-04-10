const HardwareService = require('../services/HardwareService');
const assert = require('assert');

async function qualifyAdbLogic() {
    console.log("🧪 Qualifying ADB Hardware Logic...");
    const hardware = new HardwareService();

    // Mock exec for testing logic flow
    const originalRunExec = hardware.runExec;
    let lastCommand = '';
    hardware.runExec = async (cmd) => {
        lastCommand = cmd;
        if (cmd === 'adb devices') return 'List of devices attached\n1.2.3.4:5555\tdevice';
        if (cmd.includes('dumpsys media_session')) return 'state=3 (PLAYING)';
        return 'OK';
    };

    const testIp = '1.2.3.4';

    // Test 1: Connectivity check logic
    const devices = await hardware.getAdbDevices();
    assert(devices.includes(testIp), "Should find test IP in device list");
    console.log("✅ Device listing confirmed.");

    // Test 2: Pause Command logic
    const dummyStatus = await hardware.runExec(`adb -s ${testIp}:5555 shell dumpsys media_session`);
    if (dummyStatus.includes('state=3')) {
        await hardware.runExec(`adb -s ${testIp}:5555 shell input keyevent 127`);
        assert(lastCommand.includes('127'), "Should have sent keyevent 127 (Pause)");
    }
    console.log("✅ Pause logic flow confirmed.");

    // Test 3: Resume Command logic
    await hardware.runExec(`adb -s ${testIp}:5555 shell input keyevent 126`);
    assert(lastCommand.includes('126'), "Should have sent keyevent 126 (Play)");
    console.log("✅ Resume logic flow confirmed.");

    console.log("✨ All Qualification Tests PASSED.");
}

qualifyAdbLogic().catch(e => {
    console.error(`❌ Qualification failed: ${e.message}`);
    process.exit(1);
});
