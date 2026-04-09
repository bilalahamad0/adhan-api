const http = require('http');
require('dotenv').config();

console.log('🔍 Starting Post-Release Sanity Test...');

const PORT = process.env.SERVER_PORT || 3001;
const TARGET_HOST = process.argv[2] || 'localhost';

const options = {
  hostname: TARGET_HOST,
  port: PORT,
  path: '/health',
  method: 'GET',
  timeout: 5000
};

console.log(`📡 Pinging API endpoint: http://${TARGET_HOST}:${PORT}/health...`);

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  
  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log(`✅ Sanity Test Passed: Health check OK. Payload: ${data}`);
      console.log('🤖 Verify process manager via: pm2 status adhan-caster');
      process.exit(0);
    } else {
      console.error(`❌ Sanity Test Failed. Status: ${res.statusCode}`);
      process.exit(1);
    }
  });
});

req.on('error', (e) => {
  console.error(`❌ Sanity Test Error. Server might be down or unreachable: ${e.message}`);
  process.exit(1);
});

req.on('timeout', () => {
  req.destroy();
  console.error(`❌ Sanity Test Timeout.`);
  process.exit(1);
});

req.end();
