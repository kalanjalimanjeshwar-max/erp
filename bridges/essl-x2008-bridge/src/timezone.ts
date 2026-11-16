/**
 * Converts a ZKTeco device's local wall-clock date/time parts (stored without TZ offset on hardware)
 * into an exact UTC ISO-8601 string using an IANA timezone (default Asia/Kolkata).
 */
export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

function getZoneParts(utcDate: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(utcDate);

  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }

  return {
    year: Number(map.year || 1970),
    month: Number(map.month || 1),
    day: Number(map.day || 1),
    hour: Number(map.hour === '24' ? '0' : map.hour || 0),
    minute: Number(map.minute || 0),
    second: Number(map.second || 0),
  };
}

export function deviceLocalDateTimeToUtcIso(
  local: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  },
  timeZone: string
): string {
  const tz = isValidIanaTimezone(timeZone) ? timeZone.trim() : 'Asia/Kolkata';
  const targetAsUtcMs = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
    0
  );

  // Two-pass fixed-point offset resolution handles both fixed offsets (Asia/Kolkata +05:30) and DST transitions
  let candidateMs = targetAsUtcMs;
  for (let i = 0; i < 2; i++) {
    const zoned = getZoneParts(new Date(candidateMs), tz);
    const zonedAsUtcMs = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      zoned.second,
      0
    );
    const diffMs = targetAsUtcMs - zonedAsUtcMs;
    candidateMs += diffMs;
  }

  return new Date(candidateMs).toISOString();
}

export function formatLocalWallClock(local: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}:${pad(local.second)}`;
}
