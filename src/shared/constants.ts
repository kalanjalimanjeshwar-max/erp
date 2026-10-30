/**
 * Shared System Constants
 */

export const APP_VERSION = '1.0.0-phase1';

export const SUPPORTED_CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'INR',
  'AED',
  'SAR',
  'CAD',
  'AUD',
  'SGD',
  'JPY',
] as const;

export const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;

export const ERROR_CODES = {
  DB_UNREACHABLE: 'DB_UNREACHABLE',
  DB_CONFIG_INVALID: 'DB_CONFIG_INVALID',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  SETUP_ALREADY_COMPLETED: 'SETUP_ALREADY_COMPLETED',
  SETUP_REQUIRED: 'SETUP_REQUIRED',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  NOT_FOUND: 'NOT_FOUND',
} as const;
