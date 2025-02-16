import { google } from "googleapis";
import axios from "axios";

const calendarId = "935383561398511b358450192df350a2c06b35a08065ee6636e53f91eb73d992@group.calendar.google.com"; // Replace with your Adhan Calendar ID

export default async function handler(req, res) {
    try {
        // Load Google Auth Credentials from ENV
        const credentials = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_KEY, "base64").toString("utf8"));
        //const prayerTimesApiUrl = "https://adhan-api-mauve.vercel.app/api/prayerTimes"; // FIXED URL

        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ["https://www.googleapis.com/auth/calendar"],
        });

        const calendar = google.calendar({ version: "v3", auth });

        // Fetch prayer times
        const response = await axios.get("https://adhan-api-mauve.vercel.app/api/prayerTimes");
        const prayerTimes = response.data.all_prayers;

        // Delete old events
        const existingEvents = await calendar.events.list({
            calendarId,
            timeMin: new Date().toISOString(),
            singleEvents: true,
        });

        for (const event of existingEvents.data.items) {
            if (["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"].includes(event.summary)) {
                await calendar.events.delete({ calendarId, eventId: event.id });
            }
        }

        // Insert new prayer times
        for (const [name, time] of Object.entries(prayerTimes)) {
            const [hour, minute] = time.split(":").map(Number);
            const eventStart = new Date();
            eventStart.setHours(hour, minute, 0);

            const eventEnd = new Date(eventStart.getTime() + 5 * 60 * 1000);

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

        res.status(200).json({ message: "Prayer times updated in Google Calendar!" });
    } catch (error) {
        console.error("Error updating Google Calendar:", error);
        res.status(500).json({ error: "Failed to update calendar", details: error.message });
    }
}
