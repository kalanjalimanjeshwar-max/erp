/**
 * Currency Formatting & Symbol Resolution Utilities
 * Supports INR, USD, EUR, GBP, AED, SAR, CAD, AUD, SGD, JPY and dynamic precision.
 */

export type CurrencyDisplayMode = 'symbol' | 'code' | 'both';

interface CurrencyMeta {
  symbol: string;
  locale: string;
  defaultDecimals: number;
}

const CURRENCY_META: Record<string, CurrencyMeta> = {
  INR: { symbol: '₹', locale: 'en-IN', defaultDecimals: 2 },
  USD: { symbol: '$', locale: 'en-US', defaultDecimals: 2 },
  EUR: { symbol: '€', locale: 'de-DE', defaultDecimals: 2 },
  GBP: { symbol: '£', locale: 'en-GB', defaultDecimals: 2 },
  AED: { symbol: 'AED', locale: 'en-AE', defaultDecimals: 2 },
  SAR: { symbol: 'SAR', locale: 'en-SA', defaultDecimals: 2 },
  CAD: { symbol: 'CA$', locale: 'en-CA', defaultDecimals: 2 },
  AUD: { symbol: 'A$', locale: 'en-AU', defaultDecimals: 2 },
  SGD: { symbol: 'S$', locale: 'en-SG', defaultDecimals: 2 },
  JPY: { symbol: '¥', locale: 'ja-JP', defaultDecimals: 0 },
};

export function normalizeCurrencyCode(currencyCode?: string | null, fallback = 'USD'): string {
  const code = (currencyCode || fallback || 'USD').trim().toUpperCase();
  return code || 'USD';
}

export function getCurrencyMeta(currencyCode?: string | null): CurrencyMeta {
  const code = normalizeCurrencyCode(currencyCode);
  return CURRENCY_META[code] || { symbol: code, locale: 'en-US', defaultDecimals: 2 };
}

export function getCurrencySymbol(currencyCode?: string | null): string {
  return getCurrencyMeta(currencyCode).symbol;
}

export function parseNumericAmount(value: string | number | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned) return 0;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function formatNumberForCurrency(
  amount: string | number | null | undefined,
  currencyCode?: string | null,
  decimals?: number
): string {
  const meta = getCurrencyMeta(currencyCode);
  const resolvedDecimals =
    typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 6
      ? decimals
      : meta.defaultDecimals;

  const num = parseNumericAmount(amount);
  const absFormatted = new Intl.NumberFormat(meta.locale, {
    minimumFractionDigits: resolvedDecimals,
    maximumFractionDigits: resolvedDecimals,
  }).format(Math.abs(num));

  return num < 0 ? `-${absFormatted}` : absFormatted;
}

/**
 * Formats monetary amount dynamically using currency code, locale grouping, and rounding precision.
 */
export function formatMoney(
  amount: string | number | null | undefined,
  currencyCode?: string | null,
  options?: {
    decimals?: number;
    displayMode?: CurrencyDisplayMode;
  }
): string {
  const code = normalizeCurrencyCode(currencyCode);
  const meta = getCurrencyMeta(code);
  const displayMode = options?.displayMode ?? 'symbol';
  const num = parseNumericAmount(amount);
  const sign = num < 0 ? '-' : '';
  const absFormatted = formatNumberForCurrency(Math.abs(num), code, options?.decimals);

  if (displayMode === 'code') {
    return `${sign}${code} ${absFormatted}`;
  }

  const symbolPrefix = meta.symbol === code ? `${code} ` : meta.symbol;
  if (displayMode === 'both') {
    return meta.symbol === code
      ? `${sign}${code} ${absFormatted}`
      : `${sign}${symbolPrefix}${absFormatted} (${code})`;
  }

  return `${sign}${symbolPrefix}${absFormatted}`;
}
