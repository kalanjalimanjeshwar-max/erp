import { CustomerDuplicateMatch, CustomerItem, CustomerType } from './types.ts';

export interface CustomerValidationResult {
  valid: boolean;
  error?: string;
}

export interface TaxValidationResult {
  valid: boolean;
  normalized: string | null;
  label: string;
  error?: string;
}

export const COMMON_CUSTOMER_COUNTRIES = [
  { code: 'IN', name: 'India', taxLabel: 'GSTIN' },
  { code: 'US', name: 'United States', taxLabel: 'EIN / Tax ID' },
  { code: 'GB', name: 'United Kingdom', taxLabel: 'VAT Number' },
  { code: 'AE', name: 'United Arab Emirates', taxLabel: 'TRN (Tax Registration)' },
  { code: 'SG', name: 'Singapore', taxLabel: 'UEN / GST Reg No.' },
  { code: 'AU', name: 'Australia', taxLabel: 'ABN / ACN' },
  { code: 'CA', name: 'Canada', taxLabel: 'Business Number (BN)' },
  { code: 'DE', name: 'Germany', taxLabel: 'USt-IdNr / VAT ID' },
  { code: 'OTHER', name: 'Other Country', taxLabel: 'Tax Registration ID' },
] as const;

export function normalizeCountryKey(country?: string | null): string {
  const raw = (country || '').trim().toUpperCase();
  if (!raw) return '';
  if (raw === 'IN' || raw === 'IND' || raw === 'INDIA') return 'IN';
  if (raw === 'US' || raw === 'USA' || raw === 'UNITED STATES' || raw === 'UNITED STATES OF AMERICA') {
    return 'US';
  }
  if (raw === 'GB' || raw === 'UK' || raw === 'UNITED KINGDOM' || raw === 'GREAT BRITAIN') {
    return 'GB';
  }
  if (raw === 'AE' || raw === 'UAE' || raw === 'UNITED ARAB EMIRATES') return 'AE';
  if (raw === 'SG' || raw === 'SGP' || raw === 'SINGAPORE') return 'SG';
  if (raw === 'AU' || raw === 'AUS' || raw === 'AUSTRALIA') return 'AU';
  if (raw === 'CA' || raw === 'CAN' || raw === 'CANADA') return 'CA';
  if (raw === 'DE' || raw === 'DEU' || raw === 'GERMANY') return 'DE';
  return raw;
}

export function getCountryTaxLabel(country?: string | null): string {
  const key = normalizeCountryKey(country);
  const found = COMMON_CUSTOMER_COUNTRIES.find((c) => c.code === key);
  return found ? found.taxLabel : 'GSTIN / Tax Registration Number';
}

export function validateCustomerEmail(email?: string | null): CustomerValidationResult {
  const trimmed = (email || '').trim();
  if (!trimmed) return { valid: true };
  if (trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
    return { valid: false, error: 'Please enter a valid email address (e.g. billing@company.com).' };
  }
  return { valid: true };
}

export function validateCustomerPhone(phone?: string | null): CustomerValidationResult {
  const trimmed = (phone || '').trim();
  if (!trimmed) return { valid: true };
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    return { valid: false, error: 'Phone number must contain between 7 and 15 digits.' };
  }
  return { valid: true };
}

export function validatePostalCode(
  postalCode?: string | null,
  country?: string | null
): CustomerValidationResult {
  const trimmed = (postalCode || '').trim();
  if (!trimmed) return { valid: true };

  const key = normalizeCountryKey(country);
  if (key === 'IN') {
    if (!/^[1-9][0-9]{5}$/.test(trimmed)) {
      return { valid: false, error: 'Indian PIN code must be 6 digits and cannot start with 0.' };
    }
  } else if (key === 'US') {
    if (!/^\d{5}(-\d{4})?$/.test(trimmed)) {
      return { valid: false, error: 'US ZIP code must be 5 digits or ZIP+4 (e.g. 94107).' };
    }
  } else if (trimmed.length < 3 || trimmed.length > 16) {
    return { valid: false, error: 'Postal code must be between 3 and 16 characters.' };
  }

  return { valid: true };
}

/**
 * Validates optional Tax Registration / GSTIN based on customer's Country.
 */
export function validateTaxRegistrationNumber(
  taxId?: string | null,
  country?: string | null
): TaxValidationResult {
  const label = getCountryTaxLabel(country);
  const trimmed = (taxId || '').trim();
  if (!trimmed) {
    return { valid: true, normalized: null, label };
  }

  const normalized = trimmed.toUpperCase().replace(/\s+/g, '');
  const key = normalizeCountryKey(country);

  if (key === 'IN') {
    // Standard 15-character Indian GSTIN: 2-digit state + 10-char PAN + 1 entity + Z + 1 checksum
    const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    if (!gstinRegex.test(normalized)) {
      return {
        valid: false,
        normalized,
        label,
        error: 'Invalid Indian GSTIN format. Expected 15 characters (e.g., 29ABCDE1234F1Z5).',
      };
    }
    const stateNum = parseInt(normalized.slice(0, 2), 10);
    const validState = (stateNum >= 1 && stateNum <= 38) || stateNum === 97 || stateNum === 99;
    if (!validState) {
      return {
        valid: false,
        normalized,
        label,
        error: 'Invalid GSTIN state code prefix (expected 01-38, 97, or 99).',
      };
    }
    return { valid: true, normalized, label };
  }

  if (key === 'US') {
    if (!/^\d{2}-?\d{7}$/.test(normalized)) {
      return {
        valid: false,
        normalized,
        label,
        error: 'Invalid US EIN format. Expected XX-XXXXXXX (9 digits).',
      };
    }
    return { valid: true, normalized, label };
  }

  if (key === 'GB') {
    if (!/^(GB)?(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/.test(normalized)) {
      return {
        valid: false,
        normalized,
        label,
        error: 'Invalid UK VAT number format (expected GB followed by 9 or 12 digits).',
      };
    }
    return { valid: true, normalized, label };
  }

  if (key === 'AE') {
    if (!/^\d{15}$/.test(normalized)) {
      return {
        valid: false,
        normalized,
        label,
        error: 'Invalid UAE TRN format. Expected 15 digits.',
      };
    }
    return { valid: true, normalized, label };
  }

  if (!/^[A-Z0-9\-/]{4,30}$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      label,
      error: `${label} must be 4–30 alphanumeric characters.`,
    };
  }

  return { valid: true, normalized, label };
}

export function normalizeNameForDuplicateCheck(name?: string | null): string {
  return (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizePhoneForDuplicateCheck(phone?: string | null): string {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

export function findDuplicateCustomers(
  candidate: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    taxId?: string | null;
  },
  existingCustomers: Array<Pick<CustomerItem, 'id' | 'code' | 'name' | 'email' | 'phone' | 'taxId'>>,
  excludeCustomerId?: string
): CustomerDuplicateMatch[] {
  const targetName = normalizeNameForDuplicateCheck(candidate.name);
  const targetEmail = (candidate.email || '').trim().toLowerCase();
  const targetPhone = normalizePhoneForDuplicateCheck(candidate.phone);
  const targetTaxId = (candidate.taxId || '').trim().toUpperCase().replace(/\s+/g, '');

  const matches: CustomerDuplicateMatch[] = [];

  for (const existing of existingCustomers) {
    if (excludeCustomerId && existing.id === excludeCustomerId) continue;

    const matchedOn: Array<'name' | 'email' | 'phone' | 'taxId'> = [];
    if (targetName && normalizeNameForDuplicateCheck(existing.name) === targetName) {
      matchedOn.push('name');
    }
    if (targetEmail && (existing.email || '').trim().toLowerCase() === targetEmail) {
      matchedOn.push('email');
    }
    if (
      targetPhone.length >= 7 &&
      normalizePhoneForDuplicateCheck(existing.phone) === targetPhone
    ) {
      matchedOn.push('phone');
    }
    if (
      targetTaxId &&
      (existing.taxId || '').trim().toUpperCase().replace(/\s+/g, '') === targetTaxId
    ) {
      matchedOn.push('taxId');
    }

    if (matchedOn.length > 0) {
      matches.push({
        id: existing.id,
        code: existing.code,
        name: existing.name,
        email: existing.email,
        phone: existing.phone,
        taxId: existing.taxId,
        matchedOn,
      });
    }
  }

  return matches;
}

export function formatCustomerBillingAddress(parts: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}): string | null {
  const street = (parts.address || '').trim();
  const city = (parts.city || '').trim();
  const state = (parts.state || '').trim();
  const postalCode = (parts.postalCode || '').trim();
  const country = (parts.country || '').trim();

  const segments: string[] = [];
  if (street) segments.push(street);

  const cityState = [city, state].filter(Boolean).join(', ');
  const cityStateZip = [cityState, postalCode].filter(Boolean).join(' - ');
  if (cityStateZip && (!street || !street.toLowerCase().includes(cityStateZip.toLowerCase()))) {
    segments.push(cityStateZip);
  }

  if (country && (!street || !street.toLowerCase().includes(country.toLowerCase()))) {
    segments.push(country);
  }

  const combined = segments.join(', ').trim();
  return combined || null;
}

export function validateInlineCustomerInput(input: {
  name: string;
  customerType?: CustomerType;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  postalCode?: string | null;
  taxId?: string | null;
}): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!input.name || !input.name.trim()) {
    errors.name = 'Customer / Business name is required.';
  }

  const emailCheck = validateCustomerEmail(input.email);
  if (!emailCheck.valid && emailCheck.error) {
    errors.email = emailCheck.error;
  }

  const phoneCheck = validateCustomerPhone(input.phone);
  if (!phoneCheck.valid && phoneCheck.error) {
    errors.phone = phoneCheck.error;
  }

  const postalCheck = validatePostalCode(input.postalCode, input.country);
  if (!postalCheck.valid && postalCheck.error) {
    errors.postalCode = postalCheck.error;
  }

  const taxCheck = validateTaxRegistrationNumber(input.taxId, input.country);
  if (!taxCheck.valid && taxCheck.error) {
    errors.taxId = taxCheck.error;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
