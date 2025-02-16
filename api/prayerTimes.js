import axios from "axios";
import { DateTime } from "luxon";

export default async function handler(req, res) {
    try {
        const { country, city } = req.query;
        const apiUrl = `http://api.aladhan.com/v1/timingsByCity?country=${country}&city=${city}&method=2`;

        const response = await axios.get(apiUrl);
        const timings = response.data.data.timings;

        // Convert prayer times from string to actual DateTime objects (PST)
        const timezone = "America/Los_Angeles";  // Ensure Pacific Time (PST/PDT)
        const now = DateTime.now().setZone(timezone);

        const prayerTimes = {
            Fajr: DateTime.fromFormat(timings.Fajr, "HH:mm", { zone: timezone }),
            Dhuhr: DateTime.fromFormat(timings.Dhuhr, "HH:mm", { zone: timezone }),
            Asr: DateTime.fromFormat(timings.Asr, "HH:mm", { zone: timezone }),
            Maghrib: DateTime.fromFormat(timings.Maghrib, "HH:mm", { zone: timezone }),
            Isha: DateTime.fromFormat(timings.Isha, "HH:mm", { zone: timezone }),
        };

        // Determine the next prayer time based on current time
        let nextPrayer = null;
        for (const [name, time] of Object.entries(prayerTimes)) {
            if (time > now) {
                nextPrayer = { name, time: time.toFormat("hh:mm a") };
                break;
            }
        }

        // If no future prayers today, set next to tomorrow's Fajr
        if (!nextPrayer) {
            nextPrayer = { name: "Fajr", time: prayerTimes.Fajr.plus({ days: 1 }).toFormat("hh:mm a") };
        }

        res.status(200).json({
            all_prayers: Object.fromEntries(
                Object.entries(prayerTimes).map(([name, time]) => [name, time.toFormat("hh:mm a")])
            ),
            next_prayer: nextPrayer
        });

    } catch (error) {
        console.error("Error fetching prayer times:", error);
        res.status(500).json({ error: "Failed to fetch prayer times" });
    }
}

