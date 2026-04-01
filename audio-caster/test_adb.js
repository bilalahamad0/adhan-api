const { exec } = require('child_process');
require('dotenv').config();

const TV_IP = process.env.TV_IP || '127.0.0.1';

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function adbCommand(cmd) {
    return new Promise((resolve) => {
        log(`🔹 Executing: adb -s ${TV_IP} ${cmd}`);
        exec(`adb -s ${TV_IP} ${cmd}`, { timeout: 8000 }, (error, stdout, stderr) => {
            if (error) {
                log(`❌ Error: ${error.message}`);
            }
            if (stderr && !stderr.includes('offline')) {
                // log(`⚠️ Stderr: ${stderr.trim()}`);
            }
            resolve(stdout ? stdout.trim() : '');
        });
    });
}

async function runTest() {
    log(`🚀 Starting ADB Unit Test for TV at ${TV_IP}...`);

    // 1. Connection Check
    log(`\n--- 1. CONNECTION CHECK ---`);
    const devices = await adbCommand('devices');
    console.log(devices);

    if (!devices.split('\n').some(line => line.includes(TV_IP) && /\bdevice\b/.test(line))) {
        log(`⚠️ Device not found in list. Attempting connect...`);
        await adbCommand(`connect ${TV_IP}`);
    }

    // 2. State Detection Diagnostics
    log(`\n--- 2. STATE DETECTION DIAGNOSTICS ---`);

    log(`> Checking 'dumpsys media_session' (Filtered)...`);
    const sessionOutput = await adbCommand('shell dumpsys media_session');
    const playingSession = sessionOutput.split('\n').filter(l => l.includes('state=3') || l.includes('state=Playing') || l.includes('isActive=true') || l.includes('description='));
    if (playingSession.length > 0) {
        console.log("   MATCHES FOUND:\n" + playingSession.join('\n'));
    } else {
        console.log("   NO PLAYING SESSIONS FOUND.");
        // console.log("   RAW (First 500 chars): " + sessionOutput.substring(0, 500));
    }

    log(`> Checking 'dumpsys audio' (Filtered)...`);
    const audioOutput = await adbCommand('shell dumpsys audio');
    const playingAudio = audioOutput.split('\n').filter(l => l.includes('state:started') || l.includes('playerState=2') || l.includes('usage=USAGE_MEDIA'));
    if (playingAudio.length > 0) {
        console.log("   MATCHES FOUND:\n" + playingAudio.join('\n'));
    } else {
        console.log("   NO ACTIVE AUDIO FOUND.");
    }

    // 3. Control Test
    log(`\n--- 3. CONTROL TEST (Pause/Resume) ---`);
    log(`⏸️  Sending PAUSE (Key 127)...`);
    await adbCommand('shell input keyevent 127');

    log(`⏳ Waiting 3 seconds... (Check if TV paused)`);
    await new Promise(r => setTimeout(r, 3000));

    log(`▶️  Sending RESUME (Key 126)...`);
    await adbCommand('shell input keyevent 126');

    log(`\n✅ Test Complete.`);
}

runTest();
