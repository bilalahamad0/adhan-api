const { exec } = require('child_process');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// Configuration
const TV_IP = process.env.TV_IP || '10.0.0.80';
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // Check every 15 minutes

function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] 🛡️ ADB-KEEPER: ${msg}`);
}

function run(cmd) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                // log(`Error running ${cmd}: ${error.message}`);
                resolve(null);
            } else {
                resolve(stdout ? stdout.trim() : '');
            }
        });
    });
}

async function checkAndHeal() {
    try {
        log(`Checking connection to ${TV_IP}...`);

        // 1. Is it listed?
        const devices = await run('adb devices');
        if (!devices) {
            log("ADB Server might be down. Restarting...");
            await run('adb start-server');
        }

        const isConnected = devices && devices.includes(TV_IP) && devices.includes('device');
        const isUnauthorized = devices && devices.includes(TV_IP) && devices.includes('unauthorized');

        if (isConnected) {
            log(`✅ Device is ONLINE and AUTHORIZED.`);
            // Optional: Run a harmless command to refresh the session timeout
            await run(`adb -s ${TV_IP} shell date`);
        } else if (isUnauthorized) {
            log(`🚨 Device is UNAUTHORIZED! Attempting reconnect...`);
            await run(`adb disconnect ${TV_IP}`);
            await run(`adb connect ${TV_IP}`);
            // User needs to click popup, but this triggers it.
        } else {
            log(`⚠️ Device not found/offline. Connecting...`);
            await run(`adb connect ${TV_IP}`);

            // Re-check
            const reCheck = await run('adb devices');
            if (reCheck && reCheck.includes(TV_IP) && reCheck.includes('device')) {
                log(`✅ Reconnection SUCCESSFUL.`);
            } else {
                log(`❌ Reconnection FAILED. Will try again in ${CHECK_INTERVAL_MS / 60000}m.`);
            }
        }

    } catch (e) {
        log(`🔥 Critical Error: ${e.message}`);
    }
}

// Start immediately
log(`🚀 ADB Keep-Alive Service Started. Target: ${TV_IP}`);
checkAndHeal();

// Loop
setInterval(checkAndHeal, CHECK_INTERVAL_MS);
