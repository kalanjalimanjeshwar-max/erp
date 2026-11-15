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
