/**
 * Utility functions for timezone-aware time formatting
 * Uses Luxon for timezone support with native Intl API
 */

import { DateTime } from 'luxon';

/**
 * Parse an ISO 8601 string for display in `timezone`.
 *
 * Strings with an offset ("2025-11-07T14:30:00+00:00", NOAA) are converted to
 * `timezone`. Strings without one ("2025-11-07T14:30", "2025-11-07", Open-Meteo
 * with timezone=auto) are already local time there, so they are read as-is in
 * `timezone` rather than in the server's own zone.
 */
function parseInTimezone(isoString: string, timezone: string): DateTime {
  return DateTime.fromISO(isoString, { zone: timezone });
}

/**
 * Format an ISO 8601 datetime string in the specified timezone
 * @param isoString - ISO 8601 datetime string (e.g., "2025-11-07T14:30:00+00:00");
 *   strings without an offset are treated as local time in `timezone`
 * @param timezone - IANA timezone identifier (e.g., "America/New_York", "Asia/Tokyo")
 * @param format - Optional format style ('full', 'long', 'medium', 'short')
 * @returns Formatted datetime string in local timezone
 */
export function formatInTimezone(
  isoString: string,
  timezone: string,
  format: 'full' | 'long' | 'medium' | 'short' = 'medium'
): string {
  try {
    const zonedDt = parseInTimezone(isoString, timezone);

    if (!zonedDt.isValid) {
      // Fallback to JavaScript Date if Luxon can't parse
      return new Date(isoString).toLocaleString('en-US', { timeZone: timezone });
    }

    // Format based on requested style
    switch (format) {
      case 'full':
        return zonedDt.toLocaleString(DateTime.DATETIME_FULL);
      case 'long':
        return zonedDt.toLocaleString(DateTime.DATETIME_MED_WITH_SECONDS);
      case 'short':
        return zonedDt.toLocaleString(DateTime.DATETIME_SHORT);
      case 'medium':
      default:
        return zonedDt.toLocaleString(DateTime.DATETIME_MED);
    }
  } catch (error) {
    // Fallback to standard Date formatting if anything goes wrong
    return new Date(isoString).toLocaleString('en-US', { timeZone: timezone });
  }
}

/**
 * Format a date-only ISO string in the specified timezone
 * @param isoString - ISO 8601 datetime string
 * @param timezone - IANA timezone identifier
 * @returns Formatted date string (e.g., "Nov 7, 2025")
 */
export function formatDateInTimezone(isoString: string, timezone: string): string {
  try {
    const zonedDt = parseInTimezone(isoString, timezone);

    if (!zonedDt.isValid) {
      return new Date(isoString).toLocaleDateString('en-US', { timeZone: timezone });
    }
    return zonedDt.toLocaleString(DateTime.DATE_MED);
  } catch (error) {
    return new Date(isoString).toLocaleDateString('en-US', { timeZone: timezone });
  }
}

/**
 * Format a time-only ISO string in the specified timezone
 * @param isoString - ISO 8601 datetime string
 * @param timezone - IANA timezone identifier
 * @returns Formatted time string (e.g., "2:30 PM EST")
 */
export function formatTimeInTimezone(isoString: string, timezone: string): string {
  try {
    const zonedDt = parseInTimezone(isoString, timezone);

    if (!zonedDt.isValid) {
      return new Date(isoString).toLocaleTimeString('en-US', {
        timeZone: timezone,
        timeZoneName: 'short'
      });
    }

    return zonedDt.toLocaleString(DateTime.TIME_WITH_SHORT_OFFSET);
  } catch (error) {
    return new Date(isoString).toLocaleTimeString('en-US', {
      timeZone: timezone,
      timeZoneName: 'short'
    });
  }
}

/**
 * Get timezone abbreviation from IANA timezone identifier
 * @param timezone - IANA timezone identifier (e.g., "America/New_York")
 * @param datetime - Optional datetime to determine DST status
 * @returns Timezone abbreviation (e.g., "EST" or "EDT")
 */
export function getTimezoneAbbreviation(timezone: string, datetime?: Date): string {
  try {
    const dt = datetime
      ? DateTime.fromJSDate(datetime).setZone(timezone)
      : DateTime.now().setZone(timezone);

    return dt.offsetNameShort || dt.toFormat('ZZZZ');
  } catch (error) {
    return timezone;
  }
}

/**
 * Detect timezone from coordinates using a simple heuristic
 * This is a fallback when timezone is not provided by APIs
 * @param latitude - Latitude
 * @param longitude - Longitude
 * @returns Best-guess IANA timezone identifier
 */
export function guessTimezoneFromCoords(latitude: number, longitude: number): string {
  // This is a simplified heuristic - in practice, APIs usually provide timezone
  // For production use, consider integrating a proper coordinate-to-timezone library
  // like tz-lookup or @photostructure/tz-lookup for accurate global coverage

  // Map to common US timezones for North America based on longitude.
  // The Central time zone is geographically wide (it reaches from the Great Lakes
  // out to roughly the Kansas/Colorado border), so its longitude band is much wider
  // than Eastern's. Boundaries below are tuned against known city coordinates
  // (see timezone.test.ts) rather than an even four-way split of the continent.
  if (latitude >= 24 && latitude <= 50 && longitude >= -125 && longitude <= -66) {
    if (longitude >= -85) return 'America/New_York';
    if (longitude >= -101) return 'America/Chicago';
    if (longitude >= -115) return 'America/Denver';
    if (longitude >= -125) return 'America/Los_Angeles';
  }

  // For international locations, default to UTC instead of server timezone
  // This provides predictable, unambiguous timestamps for all users
  // Note: The previous fallback to Intl.DateTimeFormat().resolvedOptions().timeZone
  // would return the server's local timezone, which is misleading for international queries
  return 'UTC';
}

/**
 * Format a time range with timezone context
 * @param startTime - Start time ISO string
 * @param endTime - End time ISO string
 * @param timezone - IANA timezone identifier
 * @returns Formatted range (e.g., "Nov 7, 2:00 PM - 5:00 PM EST")
 */
export function formatTimeRangeInTimezone(
  startTime: string,
  endTime: string,
  timezone: string
): string {
  try {
    const start = parseInTimezone(startTime, timezone);
    const end = parseInTimezone(endTime, timezone);

    if (!start.isValid || !end.isValid) {
      return `${formatInTimezone(startTime, timezone, 'short')} - ${formatInTimezone(endTime, timezone, 'short')}`;
    }

    // If same day, show: "Nov 7, 2:00 PM - 5:00 PM EST"
    if (start.hasSame(end, 'day')) {
      return `${start.toLocaleString(DateTime.DATE_MED)}, ${start.toLocaleString(DateTime.TIME_SIMPLE)} - ${end.toLocaleString(DateTime.TIME_SIMPLE)} ${start.offsetNameShort}`;
    }

    // Different days: "Nov 7, 2:00 PM - Nov 8, 5:00 PM EST"
    return `${start.toLocaleString(DateTime.DATETIME_MED)} - ${end.toLocaleString(DateTime.DATETIME_MED)}`;
  } catch (error) {
    return `${formatInTimezone(startTime, timezone, 'short')} - ${formatInTimezone(endTime, timezone, 'short')}`;
  }
}

/**
 * Check if a timezone is valid IANA timezone identifier
 * @param timezone - Timezone string to validate
 * @returns true if valid, false otherwise
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    DateTime.now().setZone(timezone);
    return DateTime.now().setZone(timezone).isValid;
  } catch {
    return false;
  }
}
