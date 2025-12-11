const VisualGenerator = require('./visual_generator');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

// Config Mock
const CONFIG = {
    location: { city: 'Sunnyvale', country: 'US', method: 2, school: 1 },
    timezone: 'America/Los_Angeles'
};

const SCHEDULE_FILE = path.join(__dirname, 'annual_schedule.json');

async function run() {
    console.log("🎨 Generating Preview Dashboard...");
    const visualGen = new VisualGenerator(CONFIG);

    // Hijri Logic
    const today = DateTime.now().setZone(CONFIG.timezone);
    let hijriDate = "Hijri Date Unavailable";

    try {
        if (fs.existsSync(SCHEDULE_FILE)) {
            const annualData = JSON.parse(fs.readFileSync(SCHEDULE_FILE));
            const m = today.month.toString();
            const d = today.day;
            if (annualData.data && annualData.data[m] && annualData.data[m][d - 1]) {
                const h = annualData.data[m][d - 1].date.hijri;
                hijriDate = `${h.day} ${h.month.en} ${h.year}`;
            }
        }
    } catch (e) {
        console.error("Hijri Error:", e);
    }

    // Generate Isha Preview
    // Using 7:30 PM as a realistic Isha time
    const buffer = await visualGen.generateDashboard("Isha", "7:30 PM", hijriDate);

    fs.writeFileSync(path.join(__dirname, 'audio_cache/current_dashboard.jpg'), buffer);
    console.log("✅ Saved to audio_cache/current_dashboard.jpg");
}

run();
