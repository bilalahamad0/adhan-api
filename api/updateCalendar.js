import { google } from "googleapis";
import axios from "axios";
import { DateTime } from "luxon";

const calendarId = "935383561398511b358450192df350a2c06b35a08065ee6636e53f91eb73d992@group.calendar.google.com"; // Replace with your Adhan Calendar ID

export default async function handler(req, res) {
    try {
        console.log("🚀 Starting Google Calendar update...");

        // Load Google API Credentials
        if (!process.env.GOOGLE_SERVICE_KEY) {
            throw new Error("❌ Missing GOOGLE_SERVICE_KEY in Vercel Environment Variables");
        }

        const credentials = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_KEY, "base64").toString("utf8"));
        console.log("✅ Google API Authentication Loaded Successfully!");

        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ["https://www.googleapis.com/auth/calendar"],
        });

        const calendar = google.calendar({ version: "v3", auth });

        // Fetch prayer times
        console.log("🔄 Fetching prayer times...");
        const response = await axios.get("https://adhan-api-mauve.vercel.app/api/prayerTimes?country=USA&city=Sunnyvale");

        if (!response.data || !response.data.all_prayers) {
            throw new Error("❌ Invalid response from prayer times API");
        }

        console.log("✅ Prayer Times Received:", response.data.all_prayers);
        const prayerTimes = response.data.all_prayers;

        const timezone = "America/Los_Angeles";
        const today = DateTime.now().setZone(timezone).toISODate();

        // Delete old prayer events
        console.log("🗑️ Deleting old prayer times...");
        const existingEvents = await calendar.events.list({
            calendarId,
            timeMin: new Date().toISOString(),
            singleEvents: true,
        });

        for (const event of existingEvents.data.items) {
            if (["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"].includes(event.summary)) {
                console.log(`🗑️ Deleting event: ${event.summary}`);
                await calendar.events.delete({ calendarId, eventId: event.id });
            }
        }

        // Insert new prayer times
        console.log("📅 Adding new prayer events...");

        for (const [name, time] of Object.entries(prayerTimes)) {
            try {
                console.log(`⏳ Processing ${name} at ${time}`);

                const dateTime = DateTime.fromFormat(time, "hh:mm a", { zone: timezone });

                if (!dateTime.isValid) {
                    throw new Error(`❌ Invalid date conversion for ${name}: ${time}`);
                }

                const eventStart = dateTime.toISO();
                const eventEnd = dateTime.plus({ minutes: 10 }).toISO();

                console.log(`✅ Adding event: ${name} at ${eventStart}`);

                await calendar.events.insert({
                    calendarId,
                    resource: {
                        summary: name,
                        start: { dateTime: eventStart, timeZone: timezone },
                        end: { dateTime: eventEnd, timeZone: timezone },
                        reminders: { useDefault: true },
                    },
                });

            } catch (eventError) {
                console.error(`❌ Failed to add ${name}:`, eventError.message);
            }
        }

        console.log("🎉 Prayer times successfully updated in Google Calendar!");
        res.status(200).json({ message: "Prayer times updated in Google Calendar!" });

    } catch (error) {
        console.error("🚨 ERROR: Google Calendar Update Failed!", error);
        res.status(500).json({ error: "Failed to update calendar", details: error.message });
    }
}
