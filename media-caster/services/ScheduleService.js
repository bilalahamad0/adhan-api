const fs = require('fs');
const { DateTime } = require('luxon');

/**
 * Schedule Service
 * Responsible for finding upcoming Adhan times to trigger "Active Hunting" mode.
 */
class ScheduleService {
  constructor(scheduleFilePath, timezone = 'America/Los_Angeles') {
    this.scheduleFilePath = scheduleFilePath;
    this.timezone = timezone;
  }

  /**
   * Returns an array of DateTime objects for all prayers today.
   */
  getPrayersToday() {
    try {
      if (!fs.existsSync(this.scheduleFilePath)) return [];

      const annualData = JSON.parse(fs.readFileSync(this.scheduleFilePath));
      const today = DateTime.now().setZone(this.timezone);
      const monthData = annualData.data[today.month.toString()];
      if (!monthData) return [];

      const todayEntry = monthData.find(d => parseInt(d.date.gregorian.day) === today.day);
      if (!todayEntry) return [];

      const prayerNames = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
      return prayerNames.map(name => {
        const timeStr = todayEntry.timings[name].split(' ')[0];
        const [hours, minutes] = timeStr.split(':');
        return today.set({ hour: parseInt(hours), minute: parseInt(minutes), second: 0 });
      });
    } catch (e) {
      console.error(`[ScheduleService] ❌ Error parsing schedule: ${e.message}`);
      return [];
    }
  }

  /**
   * Returns true if current time is within 15 minutes BEFORE any Adhan.
   */
  isPreAdhanWindow(minutesBefore = 15) {
    const now = DateTime.now().setZone(this.timezone);
    const prayers = this.getPrayersToday();

    return prayers.some(prayerTime => {
      const diff = prayerTime.diff(now, 'minutes').minutes;
      return diff > 0 && diff <= minutesBefore;
    });
  }

  /**
   * Returns the number of milliseconds until the next Adhan hunt window starts.
   */
  getMsUntilNextHunt(minutesBefore = 15) {
    const now = DateTime.now().setZone(this.timezone);
    const prayers = this.getPrayersToday();

    const upcomingHunts = prayers
      .map(p => p.minus({ minutes: minutesBefore }))
      .filter(h => h > now)
      .sort((a, b) => a.toMillis() - b.toMillis());

    if (upcomingHunts.length === 0) return null;
    return upcomingHunts[0].diff(now).milliseconds;
  }
}

module.exports = ScheduleService;
