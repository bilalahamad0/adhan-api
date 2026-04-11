const HardwareService = require('../services/HardwareService');
const assert = require('assert');

async function testHardwareMuteLogic() {
    console.log("🧪 Testing HardwareService Mute & Audio Status Logic...");
    const hardware = new HardwareService();

    let adbMocks = {
        audio: '',
        mediaSession: '',
        sony: ''
    };

    // Mock runExec to simulate ADB returns
    hardware.runExec = async (cmd) => {
        if (cmd.includes('dumpsys audio')) return adbMocks.audio;
        if (cmd.includes('dumpsys media_session')) return adbMocks.mediaSession;
        if (cmd.includes('com.sony.dtv.networkservice')) return adbMocks.sony;
        return 'OK';
    };

    const testIp = '10.0.0.80';

    // SCENARIO 1: TV is playing a Live Channel (No Media Session) and is Audible
    console.log("\n--- Scenario 1: Live Channel (Audible) ---");
    adbMocks.audio = 'mStreamStates[3]:\n   mMuted: false\n   playerState=2\n   state:started';
    adbMocks.mediaSession = 'No active sessions';
    adbMocks.sony = '{"muted": false}';

    let status = await hardware.getAudioStatus(testIp);
    console.log(`Status: Playing=${status.isPlaying}, Muted=${status.isMuted}`);
    assert(status.isPlaying === true, "Should detect playing via dumpsys audio");
    assert(status.isMuted === false, "Should detect not muted");

    // Test setMuteState(true)
    let commandsSent = [];
    const originalAdbCommand = hardware.adbCommand;
    hardware.adbCommand = async (ip, cmd) => {
        commandsSent.push(cmd);
        if (cmd.includes('dumpsys audio')) return adbMocks.audio;
        if (cmd.includes('dumpsys media_session')) return adbMocks.mediaSession;
        if (cmd.includes('com.sony.dtv.networkservice')) return adbMocks.sony;
        return 'OK';
    };
    
    await hardware.setMuteState(testIp, true);
    assert(commandsSent.includes('shell input keyevent 164'), "Should have sent Mute toggle (164)");
    console.log("✅ Successfully sent Mute command for Audible Live Channel.");

    // SCENARIO 2: TV is already muted
    console.log("\n--- Scenario 2: Already Muted ---");
    adbMocks.audio = 'mStreamStates[3]:\n   mMuted: true';
    adbMocks.sony = '{"muted": true}';
    commandsSent = [];
    
    await hardware.setMuteState(testIp, true);
    assert(!commandsSent.includes('shell input keyevent 164'), "Should NOT have sent toggle if already muted");
    console.log("✅ Logic correctly skipped toggle when already muted.");

    // SCENARIO 3: Sony Specific Return Check
    console.log("\n--- Scenario 3: Sony Specific Verification ---");
    adbMocks.audio = 'mStreamStates[3]:\n   mMuted: false';
    adbMocks.sony = '{"muted": true}'; // Sony says muted, Android says not
    status = await hardware.getAudioStatus(testIp);
    assert(status.isSonyMuted === true, "Should correctly parse Sony muted state");
    
    commandsSent = [];
    await hardware.setMuteState(testIp, true);
    assert(!commandsSent.includes('shell input keyevent 164'), "Should trust Sony return and skip toggle");
    console.log("✅ Logic prioritized Sony-specific state correctly.");

    console.log("\n✨ ALL Hardware Mute Logic Tests PASSED.");
}

testHardwareMuteLogic().catch(e => {
    console.error(`❌ Test failed: ${e.message}`);
    process.exit(1);
});
