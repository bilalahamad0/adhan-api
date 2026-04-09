const express = require('express');
const bodyParser = require('body-parser');
const ChromecastAPI = require('chromecast-api');

const app = express();
const PORT = 3000;

app.use(bodyParser.json());

const client = new ChromecastAPI();

// Store discovered devices
let devices = [];

client.on('device', function (device) {
  console.log('✅ Device Found:', device.friendlyName);
  devices.push(device);
});

// Helper to find device
function findDevice(name) {
  return devices.find((d) => d.friendlyName === name || d.friendlyName.includes(name));
}

app.post('/play', (req, res) => {
  const { deviceName } = req.body;
  let { audioUrl } = req.body;

  if (!deviceName) {
    return res.status(400).send({ error: 'Missing deviceName' });
  }

  // Smart Fix: If we receive the unstable MP3Quran links, swap to the verified IslamCan mirror
  if (!audioUrl || audioUrl.includes('mp3quran') || audioUrl.includes('makka')) {
    console.log('⚠️ Detected unstable Audio URL. Swapping to verified Mirror 3 (IslamCan).');
    audioUrl = 'https://islamcan.com/audio/adhan/azan1.mp3';
  }

  console.log(`🔍 Searching for device: ${deviceName}...`);

  // Improved Finder: Partial match + exact match priority
  const device =
    devices.find((d) => d.friendlyName === deviceName) ||
    devices.find((d) => d.friendlyName.includes(deviceName));

  if (device) {
    console.log(`🔊 Casting to ${device.friendlyName}: ${audioUrl}`);

    // CRITICAL: Use the Media Object format (verified working)
    var media = {
      url: audioUrl,
      contentType: 'audio/mp3',
    };

    device.play(media, (err) => {
      if (err) {
        console.error('❌ Error playing audio:', err);
        return res.status(500).send({ error: 'Failed to play audio: ' + err.message });
      }
      console.log('🎉 Audio playing successfully!');
      res.send({ status: 'Playing', device: device.friendlyName, url: audioUrl });
    });
  } else {
    console.error(`❌ Device '${deviceName}' not found.`);
    client.update();
    res.status(404).send({
      error: `Device '${deviceName}' not found.`,
      available_devices: devices.map((d) => d.friendlyName),
    });
  }
});

// Simple endpoint to list devices for debugging
// Easy test endpoint for browser
app.get('/test', (req, res) => {
  const deviceName = req.query.device;
  const testUrl = req.query.url; // Allow custom URL

  // Filter to only show relevant devices (User asked to remove KikiBil)
  const targetDevices = devices.filter(
    (d) =>
      d.friendlyName.includes('Google Display') ||
      d.friendlyName.includes('Nest') ||
      d.friendlyName.includes('Home')
  );

  // If no device explicitly requested, show a list
  if (!deviceName) {
    if (targetDevices.length === 0) {
      // Fallback: If strict filter misses it, show all but warn
      if (devices.length > 0) {
        return res.send(`
                    <h3>Waiting for "Google Display"...</h3>
                    <p>Found others: ${devices.map((d) => d.friendlyName).join(', ')}</p>
                    <p>Refresh in 5s.</p>
                 `);
      }
      return res.send('Scanning... Refresh in 5 seconds.');
    }

    const listHtml = targetDevices
      .map((d) => {
        const name = encodeURIComponent(d.friendlyName);
        return `
                <li style="margin-bottom: 20px;">
                    <span style="font-size: 20px; font-weight: bold;">${d.friendlyName}</span><br>
                    <div style="margin-top: 10px;">
                        <a href="/test?device=${name}&url=https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3" style="background: #4CAF50; color: white; padding: 10px; text-decoration: none; border-radius: 5px; margin-right: 10px;">▶️ Check Connectivity (Music)</a>
                    </div>
                    <div style="margin-top: 15px;">
                        <strong>Select Adhan Source:</strong><br><br>
                        <a href="/test?device=${name}&url=http://server8.mp3quran.net/adhan/fajr.mp3" style="background: #2196F3; color: white; padding: 10px; text-decoration: none; border-radius: 5px; margin-right: 5px;">🕌 Mirror 1 (HTTP)</a>
                        <a href="/test?device=${name}&url=https://download.tvquran.com/download/adhan/Makkah/Adhan_Makkah.mp3" style="background: #2196F3; color: white; padding: 10px; text-decoration: none; border-radius: 5px; margin-right: 5px;">🕌 Mirror 2 (TVQuran)</a>
                        <a href="/test?device=${name}&url=https://islamcan.com/audio/adhan/azan1.mp3" style="background: #2196F3; color: white; padding: 10px; text-decoration: none; border-radius: 5px;">🕌 Mirror 3 (IslamCan)</a>
                    </div>
                </li>`;
      })
      .join('');

    return res.send(`
            <h1>Target Device Found:</h1>
            <ul>${listHtml}</ul>
            <p><strong>Diagnosis:</strong> The previous Adhan link failed. Please try these mirrors.</p>
            <p>1. Mirror 1 removes encryption (HTTP).</p>
            <p>2. Mirror 2 & 3 use different servers.</p>
        `);
  }

  const device = findDevice(deviceName);
  if (!device) return res.send(`❌ Device '${deviceName}' not found.`);

  // Select URL based on type
  let finalUrl = testUrl || 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3';

  console.log(`🎵 Casting to ${device.friendlyName}: ${finalUrl}`);

  var media = {
    url: finalUrl,
    contentType: 'audio/mp3',
  };

  device.play(media, function (err) {
    if (err) return res.send('❌ Error: ' + err.message);
    res.send(`
            <h1>🚀 Sent to ${device.friendlyName}</h1>
            <h3 style="color: blue">${finalUrl}</h3>
            <p><b>Check device now.</b></p>
            <p><a href="/test">⬅️ Back</a></p>
        `);
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Audio Caster running on port ${PORT}`);
  console.log('📡 Scanning for Google Cast devices...');
});
