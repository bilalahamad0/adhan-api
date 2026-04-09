const { exec } = require('child_process');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// Configuration
const TV_IP = process.env.TV_IP || '127.0.0.1';
// Check every 2 minutes (Aggressive Keep-Alive)
const CHECK_INTERVAL_MS = 2 * 60 * 1000;

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
    log(`🔍 Checking status for ${TV_IP}...`);

    // 1. Pre-Flight Ping (Is TV even network-reachable?)
    try {
      await run(`ping -c 1 -W 2 ${TV_IP}`);
    } catch (e) {
      log(`❌ Ping Failed. TV seems offline/sleeping. Skipping ADB check.`);
      // Potential future enhancement: Wake-on-LAN here
      return;
    }

    // 2. Check Connection State
    const devices = await run('adb devices');

    // If server is dead, start it
    if (!devices) {
      log('⚠️ ADB Server down. Restarting...');
      await run('adb keygen ~/.android/adbkey'); // Ensure keys exist
      await run('adb start-server');
    }

    const isConnected =
      devices &&
      devices.split('\n').some((line) => line.includes(TV_IP) && /\bdevice\b/.test(line));

    if (isConnected) {
      // log(`✅ Connected.`);
      // Keep active by running a dummy command
      await run(`adb -s ${TV_IP} shell date`);
    } else {
      // 3. Repair Logic (Force Disconnect -> Connect)
      log(`⚠️ Connection Lost. Attempting repair...`);

      // Use semicolon to force flow: disconnect (ignore error) -> connect
      await run(`adb disconnect ${TV_IP}`);
      const connectOut = await run(`adb connect ${TV_IP}`);

      if (
        connectOut &&
        (connectOut.includes('connected to') || connectOut.includes('already connected'))
      ) {
        log(`✅ Reconnected successfully.`);
      } else {
        log(`❌ Reconnect failed: ${connectOut}`);
      }
    }
  } catch (e) {
    log(`🔥 Error: ${e.message}`);
  }
}

// Start immediately
log(`🚀 ADB Keep-Alive Service Started. Target: ${TV_IP}`);
checkAndHeal();

// Loop
setInterval(checkAndHeal, CHECK_INTERVAL_MS);
