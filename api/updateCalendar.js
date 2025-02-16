import { google } from "googleapis";
import axios from "axios";

const calendarId = "935383561398511b358450192df350a2c06b35a08065ee6636e53f91eb73d992@group.calendar.google.com"; // Replace with your Adhan Calendar ID

export default async function handler(req, res) {
    try {
        console.log("🔍 Debug: Checking environment variables...");
        console.log("GOOGLE_SERVICE_KEY exists:", !!process.env.GOOGLE_SERVICE_KEY);

        if (!process.env.GOOGLE_SERVICE_KEY) {
            throw new Error("❌ Missing GOOGLE_SERVICE_KEY in Vercel Environment Variables");
        }

        // Decode Base64 JSON from env variable
        const credentials = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_KEY, "base64").toString("utf8"));

        console.log("✅ Successfully loaded Google API Credentials.");

        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ["https://www.googleapis.com/auth/calendar"],
        });

        console.log("✅ Google API Authentication Successful!");

        const calendar = google.calendar({ version: "v3", auth });

        // Fetch prayer times
        console.log("Fetching prayer times...");
        const response = await axios.get("https://adhan-api-mauve.vercel.app/api/prayerTimes");
        const prayerTimes = response.data.all_prayers;

        console.log("✅ Prayer Times Received:", prayerTimes);

        // Delete old events
        console.log("Deleting old prayer events...");
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
        console.log("📅 Inserting new prayer events...");
        for (const [name, time] of Object.entries(prayerTimes)) {
            const [hour, minute] = time.split(":").map(Number);
            const eventStart = new Date();
            eventStart.setHours(hour, minute, 0);

            const eventEnd = new Date(eventStart.getTime() + 5 * 60 * 1000);

            console.log(`📌 Adding event: ${name} at ${eventStart}`);

            await calendar.events.insert({
                calendarId,
                resource: {
                    summary: name,
                    start: { dateTime: eventStart.toISOString(), timeZone: "America/Los_Angeles" },
                    end: { dateTime: eventEnd.toISOString(), timeZone: "America/Los_Angeles" },
                    reminders: { useDefault: true },
                },
            });
        }

        console.log("✅ Prayer times successfully updated in Google Calendar!");
        res.status(200).json({ message: "Prayer times updated in Google Calendar!" });

    } catch (error) {
        console.error("🚨 Error updating Google Calendar:", error);
        res.status(500).json({ error: "Failed to update calendar", details: error.message });
    }
}
