/**
 * Timezone-Aware Formatting Utilities
 * Preserves UTC in PostgreSQL and displays timestamps in the company's configured timezone.
 */

export function isValidTimeZone(tz?: string | null): boolean {
  if (!tz || typeof tz !== 'string') return false;
  const trimmed = tz.trim();
  if (!trimmed) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

export function getEffectiveTimeZone(tz?: string | null): string {
  if (tz && isValidTimeZone(tz)) {
    return tz.trim();
  }
  return 'UTC';
}

function parseTimestamp(ts: string | Date | null | undefined): Date | null {
  if (ts === null || ts === undefined || ts === '') return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Returns short timezone abbreviation (e.g., "IST" for Asia/Kolkata, "UTC" for UTC).
 */
export function getTimezoneShortName(tz?: string | null, date: Date = new Date()): string {
  const effectiveTz = getEffectiveTimeZone(tz);
  if (effectiveTz === 'UTC' || effectiveTz === 'Etc/UTC') return 'UTC';

  try {
    // Use en-IN locale when inspecting Asia/Kolkata / Calcutta so ICU prefers "IST" over "GMT+5:30"
    const locale =
      effectiveTz === 'Asia/Kolkata' || effectiveTz === 'Asia/Calcutta' ? 'en-IN' : 'en-US';
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: effectiveTz,
      timeZoneName: 'short',
    }).formatToParts(date);
    const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value?.trim();
    if (tzPart) return tzPart;
  } catch {
    // Fallback below
  }
  return effectiveTz;
}

function getDateTimeParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  return {
    year: map.year || '0000',
    month: map.month || '01',
    day: map.day || '01',
    hour: map.hour === '24' ? '00' : map.hour || '00',
    minute: map.minute || '00',
    second: map.second || '00',
  };
}

/**
 * Formats a UTC timestamp into deterministic YYYY-MM-DD HH:mm[:ss] [ABBR] in the target timezone.
 */
export function formatDateTimeInTimezone(
  ts: string | Date | null | undefined,
  tz?: string | null,
  options?: {
    includeSeconds?: boolean;
    includeZoneAbbr?: boolean;
    fallback?: string;
  }
): string {
  const fallback = options?.fallback ?? '—';
  const date = parseTimestamp(ts);
  if (!date) return fallback;

  const effectiveTz = getEffectiveTimeZone(tz);
  const { year, month, day, hour, minute, second } = getDateTimeParts(date, effectiveTz);
  const base = options?.includeSeconds
    ? `${year}-${month}-${day} ${hour}:${minute}:${second}`
    : `${year}-${month}-${day} ${hour}:${minute}`;

  if (options?.includeZoneAbbr) {
    return `${base} ${getTimezoneShortName(effectiveTz, date)}`;
  }
  return base;
}

/**
 * Formats time portion only (e.g., "09:05 IST" or "21:00") in the target timezone.
 */
export function formatTimeInTimezone(
  ts: string | Date | null | undefined,
  tz?: string | null,
  options?: {
    includeSeconds?: boolean;
    includeZoneAbbr?: boolean;
    hour12?: boolean;
    fallback?: string;
  }
): string {
  const fallback = options?.fallback ?? '—';
  const date = parseTimestamp(ts);
  if (!date) return fallback;

  const effectiveTz = getEffectiveTimeZone(tz);
  let timeStr: string;

  if (options?.hour12) {
    timeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: effectiveTz,
      hour: '2-digit',
      minute: '2-digit',
      ...(options.includeSeconds ? { second: '2-digit' } : {}),
      hour12: true,
    }).format(date);
  } else {
    const { hour, minute, second } = getDateTimeParts(date, effectiveTz);
    timeStr = options?.includeSeconds ? `${hour}:${minute}:${second}` : `${hour}:${minute}`;
  }

  if (options?.includeZoneAbbr) {
    return `${timeStr} ${getTimezoneShortName(effectiveTz, date)}`;
  }
  return timeStr;
}

/**
 * Formats calendar date (YYYY-MM-DD) in the target timezone.
 */
export function formatDateInTimezone(
  ts: string | Date | null | undefined,
  tz?: string | null,
  fallback = '—'
): string {
  const date = parseTimestamp(ts);
  if (!date) return fallback;
  const effectiveTz = getEffectiveTimeZone(tz);
  const { year, month, day } = getDateTimeParts(date, effectiveTz);
  return `${year}-${month}-${day}`;
}

/**
 * Formats original UTC timestamp cleanly for audit tooltips and detail views.
 */
export function formatUtcTimestamp(
  ts: string | Date | null | undefined,
  options?: { includeSeconds?: boolean; fallback?: string }
): string {
  return formatDateTimeInTimezone(ts, 'UTC', {
    includeSeconds: options?.includeSeconds ?? true,
    includeZoneAbbr: true,
    fallback: options?.fallback ?? '—',
  });
}

/**
 * Formats a UTC timestamp into 24-hour HH:mm in the target timezone for <input type="time">.
 */
export function formatTimeInputInTimezone(
  ts: string | Date | null | undefined,
  tz?: string | null
): string {
  return formatTimeInTimezone(ts, tz, {
    hour12: false,
    includeSeconds: false,
    includeZoneAbbr: false,
    fallback: '',
  });
}

/**
 * Shifts a YYYY-MM-DD calendar date string by `days` days cleanly in UTC calendar space.
 */
export function addCalendarDaysToDateStr(dateStr: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return dateStr;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day + days));
  return dt.toISOString().split('T')[0];
}

/**
 * Converts a local calendar date (YYYY-MM-DD) and local wall-clock time (HH:mm or HH:mm:ss)
 * in the company's configured timezone into a UTC ISO-8601 timestamp string.
 */
export function localDateTimeToUtcIso(
  dateStr: string,
  timeStr: string,
  tz?: string | null
): string | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateStr || '').trim());
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((timeStr || '').trim());
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = timeMatch[3] ? Number(timeMatch[3]) : 0;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  // Validate calendar date (e.g., reject 2026-02-31)
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return null;
  }

  const effectiveTz = getEffectiveTimeZone(tz);
  const targetAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);

  if (effectiveTz === 'UTC' || effectiveTz === 'Etc/UTC') {
    return new Date(targetAsUtcMs).toISOString();
  }

  const computeOffsetMs = (instantMs: number): number => {
    const parts = getDateTimeParts(new Date(instantMs), effectiveTz);
    const shownAsUtcMs = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
      0
    );
    return shownAsUtcMs - instantMs;
  };

  // Two-pass offset refinement handles non-UTC boundaries and DST transitions accurately
  const firstPassMs = targetAsUtcMs - computeOffsetMs(targetAsUtcMs);
  const secondPassMs = targetAsUtcMs - computeOffsetMs(firstPassMs);

  return new Date(secondPassMs).toISOString();
}

