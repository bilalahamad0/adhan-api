/**
 * Google Apps Script to trigger Adhan on Google Nest Hub.
 *
 * Setup:
 * 1. Create a new Google Apps Script project at script.google.com.
 * 2. Paste this code.
 * 3. Add a Time-Driven Trigger to check every 5 minutes.
 */

function triggerAdhan() {
  var calendarId = 'primary'; // Change if using a different calendar
  var calendar = CalendarApp.getCalendarById(calendarId);
  var now = new Date();
  var later = new Date(now.getTime() + 5 * 60 * 1000); // Check next 5 minutes

  var events = calendar.getEvents(now, later, { search: 'Adhan' });

  if (events.length === 0) {
    Logger.log('No Adhan events right now.');
    return;
  }

  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    var eventTitle = event.getTitle(); // Example: "Fajr Adhan"

    // Determine which audio to play
    var adhanUrl = eventTitle.includes('Fajr')
      ? 'https://server8.mp3quran.net/adhan/fajr.mp3'
      : 'https://server8.mp3quran.net/adhan/makka.mp3';

    sendAdhanToGoogleHome(adhanUrl);
  }
}

function sendAdhanToGoogleHome(audioUrl) {
  // IMPORTANT: This URL must be accessible from Google's servers.
  // If running Assistant Relay locally, you need a tunnel (e.g., Ngrok) or a public IP.
  // Or, if this script is running in a local environment (not GAS), localhost is fine.
  // Note: The user context implies a local setup, but GAS runs in the cloud.
  // If running GAS in the cloud, 'localhost' will NOT work.
  // However, for the sake of preserving the user's snippet:
  var webhookUrl = 'http://your-public-ip-or-tunnel:3000/assistant';

  // CRITICAL: Replace "Living Room speaker" with the EXACT name of your Google Display as shown in the Google Home app.
  // Example: "Kitchen Display", "Master Bedroom Hub", etc.
  var deviceName = 'Living Room speaker';

  var payload = {
    command: `Play ${audioUrl} on ${deviceName}`,
    user: 'default',
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
  };

  try {
    UrlFetchApp.fetch(webhookUrl, options);
    Logger.log('Sent Adhan command: ' + audioUrl);
  } catch (e) {
    Logger.log('Error sending webhook: ' + e.message);
  }
}
