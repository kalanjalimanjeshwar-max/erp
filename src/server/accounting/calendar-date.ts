const CALENDAR_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

export const DEFAULT_REPORT_FROM_DATE = '1970-01-01';
export const DEFAULT_REPORT_TO_DATE = '2099-12-31';

export interface ParsedCalendarDate {
  /** Canonical YYYY-MM-DD calendar date string */
  dateStr: string;
  /** 4-digit calendar year extracted directly from YYYY-MM-DD (never host-local) */
  year: number;
  /** 1-indexed calendar month (1..12) */
  month: number;
  /** 1-indexed calendar day (1..31) */
  day: number;
  /** UTC midnight instant representing this calendar date for PostgreSQL @db.Date comparisons */
  startOfDayUtc: Date;
  /** UTC midnight of the immediately following calendar day for exclusive upper-bound (`lt`) queries */
  nextDayUtc: Date;
}

export interface ParsedReportDateRange {
  from: ParsedCalendarDate;
  to: ParsedCalendarDate;
}

/**
 * Strictly validates and parses a date-only YYYY-MM-DD string into calendar-date bounds.
 * Rejects non-YYYY-MM-DD formats (including timestamps/offsets) and impossible calendar dates
 * (e.g., 2026-02-30) with an HTTP 400 error matching service validation conventions.
 */
export function parseCalendarDate(raw: unknown, fieldName = 'date'): ParsedCalendarDate {
  if (typeof raw !== 'string') {
    const err = new Error(`Invalid ${fieldName} format. Expected YYYY-MM-DD calendar date.`);
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }

  const trimmed = raw.trim();
  const match = CALENDAR_DATE_REGEX.exec(trimmed);
  if (!match) {
    const err = new Error(
      `Invalid ${fieldName} format "${trimmed}". Expected YYYY-MM-DD calendar date.`
    );
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (year < 1) {
    const err = new Error(
      `Invalid ${fieldName} calendar date "${trimmed}". Supported calendar dates are 0001-01-01 through 9999-12-30.`
    );
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }

  const startOfDayUtc = new Date(0);
  startOfDayUtc.setUTCFullYear(year, month - 1, day);
  if (
    Number.isNaN(startOfDayUtc.getTime()) ||
    startOfDayUtc.getUTCFullYear() !== year ||
    startOfDayUtc.getUTCMonth() !== month - 1 ||
    startOfDayUtc.getUTCDate() !== day
  ) {
    const err = new Error(`Invalid ${fieldName} calendar date "${trimmed}".`);
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }

  const nextDayUtc = new Date(0);
  nextDayUtc.setUTCFullYear(year, month - 1, day + 1);
  if (Number.isNaN(nextDayUtc.getTime()) || nextDayUtc.getUTCFullYear() > 9999) {
    const err = new Error(
      `Invalid ${fieldName} calendar date "${trimmed}". Supported calendar dates are 0001-01-01 through 9999-12-30.`
    );
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }

  return {
    dateStr: trimmed,
    year,
    month,
    day,
    startOfDayUtc,
    nextDayUtc,
  };
}

/**
 * Parses optional report `fromDate` and `toDate` parameters into validated calendar-date bounds.
 * Empty string or undefined falls back to the historical default range.
 */
export function parseReportDateRange(options?: {
  fromDate?: string;
  toDate?: string;
}): ParsedReportDateRange {
  const rawFrom =
    options?.fromDate !== undefined && options.fromDate !== ''
      ? options.fromDate
      : DEFAULT_REPORT_FROM_DATE;
  const rawTo =
    options?.toDate !== undefined && options.toDate !== ''
      ? options.toDate
      : DEFAULT_REPORT_TO_DATE;

  const from = parseCalendarDate(rawFrom, 'fromDate');
  const to = parseCalendarDate(rawTo, 'toDate');

  if (from.startOfDayUtc.getTime() > to.startOfDayUtc.getTime()) {
    const err = new Error(
      `Invalid date range: fromDate (${from.dateStr}) cannot be after toDate (${to.dateStr}).`
    );
    (err as { statusCode?: number }).statusCode = 400;
    throw err;
  }

  return { from, to };
}
