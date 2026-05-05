const { exec } = require('child_process');
const net = require('net');
require('dotenv').config();

const TV_IP = process.env.TV_IP || '127.0.0.1';

console.log(`\n🔍 --- NETWORK DIAGNOSTICS FOR ${TV_IP} ---\n`);

// 1. Ping Test
console.log(`1️⃣  Running PING check...`);
exec(`ping -c 1 -W 2 ${TV_IP}`, (err, stdout, stderr) => {
  if (err) {
    console.log(`❌ PING FAILED: Host unreachable.`);
    console.log(`   -> CRITICAL: The Pi cannot reach the TV at ${TV_IP}.`);
    console.log(
      `   -> ACTION: Check if TV is on. Check if TV IP Address changed in Network Settings.`
    );
    return;
  }

  console.log(`✅ PING SUCCESS: Host is online (${stdout.split('\n')[1] || 'Reply received'}).`);

  // 2. Port Check (Only if ping works)
  checkPort(TV_IP, 5555);
});

function checkPort(host, port) {
  console.log(`\n2️⃣  Checking TCP Port ${port} (ADB Service)...`);
  const socket = new net.Socket();
  socket.setTimeout(3000);

  socket.on('connect', () => {
    console.log(`✅ PORT ${port} OPEN: ADB service is reachable.`);
    console.log(`   -> RESULT: Network is fine. Issue is likely ADB Authorization keys.`);
    console.log(`   -> ACTION: Run 'node reset_adb.js' again and watch TV for popup.`);
    socket.destroy();
  });

  socket.on('timeout', () => {
    console.log(`❌ PORT ${port} TIMEOUT: Host is up, but Port ${port} is blocked.`);
    console.log(`   -> RESULT: TV is online, but ADB Debugging is likely DISABLED.`);
    console.log(
      `   -> ACTION: Go to TV Settings > Device Preferences > Developer Options > Enable USB Debugging.`
    );
    socket.destroy();
  });

  socket.on('error', (err) => {
    console.log(`❌ PORT ${port} ERROR: ${err.message}`);
    if (err.code === 'ECONNREFUSED') {
      console.log(`   -> RESULT: TV actively refused connection. ADB is NOT running.`);
      console.log(`   -> ACTION: Enable USB Debugging on TV.`);
    }
  });

  socket.connect(port, host);
}
