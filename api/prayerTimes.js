import axios from "axios";

const calendarId = "935383561398511b358450192df350a2c06b35a08065ee6636e53f91eb73d992@group.calendar.google.com"

export default async function handler(req, res) {
    try {
        const city = req.query.city || "Sunnyvale";
        const country = req.query.country || "USA";

        const url = `http://api.aladhan.com/v1/timingsByCity?city=${city}&country=${country}&method=2`;
        const response = await axios.get(url);

        if (!response.data || !response.data.data || !response.data.data.timings) {
            return res.status(500).json({ error: "Invalid response from Aladhan API" });
        }

        const timings = response.data.data.timings;

        const prayerTimes = {
            "Fajr": timings.Fajr,
            "Dhuhr": timings.Dhuhr,
            "Asr": timings.Asr,
            "Maghrib": timings.Maghrib,
            "Isha": timings.Isha
        };

        res.status(200).json({
            all_prayers: prayerTimes,
            next_prayer: getNextPrayer(prayerTimes)
        });

    } catch (error) {
        console.error("Error fetching prayer times:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
}

function getNextPrayer(prayerTimes) {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    for (let [name, time] of Object.entries(prayerTimes)) {
        const [hour, minute] = time.split(":").map(Number);
        if (hour > currentHour || (hour === currentHour && minute > currentMinute)) {
            return { name, time };
        }
    }
    return { name: "Fajr", time: prayerTimes["Fajr"] };
}

