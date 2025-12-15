const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

const TV_IP = process.env.TV_IP || '127.0.0.1';

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function run(cmd) {
    return new Promise((resolve) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) log(`⚠️ Error: ${error.message}`);
            resolve(stdout ? stdout.trim() : '');
        });
    });
}

async function resetAdb() {
    log(`🔄 STARTING ADB RESET for ${TV_IP}...`);

    // 1. Kill Server
    log(`☠️  Killing ADB Server...`);
    await run('adb kill-server');

    // 2. Delete Keys (Force new key generation)
    const homeDir = os.homedir();
    const adbKeyPath = path.join(homeDir, '.android', 'adbkey');
    const adbPubKeyPath = path.join(homeDir, '.android', 'adbkey.pub');

    if (fs.existsSync(adbKeyPath)) {
        log(`🗑️  Deleting Old Keys: ${adbKeyPath}`);
        fs.unlinkSync(adbKeyPath);
        if (fs.existsSync(adbPubKeyPath)) fs.unlinkSync(adbPubKeyPath);
    } else {
        log(`ℹ️  No existing keys found at ${adbKeyPath}`);
    }

    // 3. Start Server (Generates new keys)
    log(`🚀 Starting ADB Server (Regenerating keys)...`);
    await run('adb start-server');

    // 4. Connect
    log(`🔗 Connecting to ${TV_IP}...`);
    log(`👉 LOOK AT THE TV SCREEN NOW for the "Allow USB Debugging" popup!`);
    const output = await run(`adb connect ${TV_IP}`);
    log(output);

    // 5. Verify
    log(`🔍 Verifying Status...`);
    const devices = await run('adb devices');
    console.log(devices);

    if (devices.includes('unauthorized')) {
        log(`🚨 STATUS: UNAUTHORIZED. Please accept the popup on the TV.`);
    } else if (devices.includes('device')) {
        log(`✅ STATUS: CONNECTED and AUTHORIZED.`);
    } else {
        log(`❓ STATUS: Unknown. Output: ${devices}`);
    }
}

resetAdb();
