/**
 * Shared Biometric Hardware Constants, Presets & Credential Redaction Utilities
 */

export interface BiometricModelPreset {
  id: string;
  label: string;
  terminalModel: string;
  platform: string;
  fingerprintAlgorithm: string;
  defaultPort: number;
  protocol: string;
  notes: string;
}

export const ESSL_X2008_HARDWARE_PROFILE = {
  brand: 'eSSL',
  model: 'eSSL X2008',
  terminalModel: 'eSSL-X2008',
  platform: 'ZLM60_TFT',
  fingerprintAlgorithm: 'VX10.0',
  defaultIp: '192.168.1.201',
  defaultPort: 4370,
  protocol: 'ZKTeco Standalone Pull TCP (Port 4370)',
} as const;

export const BIOMETRIC_MODEL_PRESETS: BiometricModelPreset[] = [
  {
    id: 'essl-x2008',
    label: 'eSSL X2008 (ZLM60_TFT · VX10.0)',
    terminalModel: 'eSSL-X2008',
    platform: 'ZLM60_TFT',
    fingerprintAlgorithm: 'VX10.0',
    defaultPort: 4370,
    protocol: 'ZKTeco Standalone Pull TCP',
    notes: 'eSSL X2008 Standalone Fingerprint Terminal (ZLM60_TFT / VX10.0) polled over LAN TCP port 4370.',
  },
  {
    id: 'zkteco-f22',
    label: 'ZKTeco F22',
    terminalModel: 'ZKTeco-F22',
    platform: 'ZMM220_TFT',
    fingerprintAlgorithm: 'VX10.0',
    defaultPort: 4370,
    protocol: 'ZKTeco Standalone Pull TCP',
    notes: 'ZKTeco F22 Wi-Fi / Ethernet BioID terminal over TCP port 4370.',
  },
  {
    id: 'essl-k30',
    label: 'eSSL K30 Pro / Identix',
    terminalModel: 'eSSL-K30-Pro',
    platform: 'ZLM60_TFT',
    fingerprintAlgorithm: 'VX10.0',
    defaultPort: 4370,
    protocol: 'ZKTeco Standalone Pull TCP',
    notes: 'eSSL K30 series standalone attendance terminal over TCP port 4370.',
  },
  {
    id: 'custom',
    label: 'Other ZKTeco / eSSL Compatible Model',
    terminalModel: 'ZKTeco-Compatible',
    platform: 'Generic',
    fingerprintAlgorithm: 'VX10.0',
    defaultPort: 4370,
    protocol: 'ZKTeco Standalone Pull TCP',
    notes: 'Compatible ZKTeco standalone TCP 4370 terminal.',
  },
];

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|secret|token|password|comm[_-]?key|authorization|x-device-api-key|credential)/i;

/**
 * Redacts high-entropy API keys, bearer tokens, and CommKeys from log/error strings.
 */
export function redactSensitiveText(input: string): string {
  if (!input) return input;
  return input
    .replace(/bio_live_[a-f0-9]{12,}/gi, (match) => `${match.slice(0, 12)}***REDACTED***`)
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***REDACTED***')
    .replace(/(x-device-api-key['":\s=]+)[^\s"',}]+/gi, '$1***REDACTED***')
    .replace(/(commKey['":\s=]+)\d+/gi, '$1***REDACTED***');
}

/**
 * Recursively redacts sensitive fields before logging or returning telemetry.
 */
export function redactCredentials<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return redactSensitiveText(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactCredentials(item)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key) && key !== 'apiKeyPrefix') {
        out[key] = '***REDACTED***';
      } else {
        out[key] = redactCredentials(val);
      }
    }
    return out as T;
  }
  return value;
}

/**
 * Validates an IPv4 address or LAN hostname (rejects empty/control chars/URLs).
 */
export function isValidLanHost(host?: string | null): boolean {
  if (!host || typeof host !== 'string') return false;
  const trimmed = host.trim();
  if (!trimmed || trimmed.length > 255) return false;
  if (/^https?:\/\//i.test(trimmed) || /[\s/\\]/.test(trimmed)) return false;

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
  if (ipv4Match) {
    return ipv4Match.slice(1).every((octet) => {
      const n = Number(octet);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }

  return /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(trimmed) || /^[a-zA-Z0-9]$/.test(trimmed);
}
