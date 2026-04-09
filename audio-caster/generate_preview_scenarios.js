const VisualGenerator = require('./visual_generator');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const CONFIG = {
  location: { city: 'Sunnyvale', country: 'US', method: 2, school: 1 },
  timezone: 'America/Los_Angeles',
};

async function runScenarios() {
  console.log('🧪 Running Background Selection Scenarios...');
  const visualGen = new VisualGenerator(CONFIG);

  // Common Data
  const time = '1:00 PM';
  const hijri = '1 Rajab 1446';

  // Output Directory
  const outputDir = path.join(__dirname, '../images/previews');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Scenario 1: Standard Dhuhr (Not Friday, No Holiday)
  console.log('\n--- Scenario 1: Standard Dhuhr ---');
  const buf1 = await visualGen.generateDashboard('Dhuhr', time, hijri, {
    holidays: [],
    isFriday: false,
  });
  fs.writeFileSync(path.join(outputDir, 'test_standard.jpg'), buf1);
  console.log('✅ Saved test_standard.jpg');

  // Scenario 2: Friday Dhuhr (Jumu'ah)
  console.log('\n--- Scenario 2: Friday Dhuhr ---');
  const buf2 = await visualGen.generateDashboard('Dhuhr', time, hijri, {
    holidays: [],
    isFriday: true,
  });
  fs.writeFileSync(path.join(outputDir, 'test_friday.jpg'), buf2);
  console.log('✅ Saved test_friday.jpg');

  // Scenario 3: Eid-ul-Fitr Dhuhr
  console.log('\n--- Scenario 3: Eid-ul-Fitr ---');
  const buf3 = await visualGen.generateDashboard('Dhuhr', time, hijri, {
    holidays: ['Eid-ul-Fitr'],
    isFriday: false,
  });
  fs.writeFileSync(path.join(outputDir, 'test_eid.jpg'), buf3);
  console.log('✅ Saved test_eid.jpg');

  // Scenario 4: Isha (Random Isha)
  console.log('\n--- Scenario 4: Isha ---');
  const buf4 = await visualGen.generateDashboard('Isha', '8:00 PM', hijri, {
    holidays: [],
    isFriday: false,
  }); // Corrected isFriday to false for standard Isha test
  fs.writeFileSync(path.join(outputDir, 'test_isha.jpg'), buf4);
  console.log('✅ Saved test_isha.jpg');
}

runScenarios();
