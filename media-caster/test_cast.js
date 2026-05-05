const ChromecastAPI = require('chromecast-api');

console.log(`\n🔍 --- CHROMECAST DISCOVERY TEST ---\n`);
console.log(`📡 Scanning for devices (Timeout: 10s)...`);

const client = new ChromecastAPI();
let foundDevices = 0;

client.on('device', function (device) {
  foundDevices++;
  console.log(`\n✅ FOUND DEVICE #${foundDevices}:`);
  console.log(`   - Name: ${device.friendlyName}`);
  console.log(`   - IP:   ${device.host}`);
  console.log(`   - Type: ${device.deviceDescription || 'Unknown'}`);

  // Optional: Print status
  device.getStatus((err, status) => {
    if (!err && status) {
      console.log(
        `   - Status: ${status.playerState || 'IDLE'} (Vol: ${status.volume ? status.volume.level : '?'})`
      );
    }
  });
});

setTimeout(() => {
  console.log(`\n🛑 Scan Complete.`);
  if (foundDevices === 0) {
    console.log(`❌ NO DEVICES FOUND.`);
    console.log(`   -> Check if Pi and Display are on the same Wi-Fi.`);
    console.log(`   -> Check if mDNS/Bonjour is allowed on the router.`);
  } else {
    console.log(`✅ Found ${foundDevices} device(s).`);
  }
  process.exit(0);
}, 10000);
