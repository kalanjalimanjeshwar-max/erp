/**
 * Dedicated Bank Credentials Encryption Service (Phase 2.3)
 *
 * Implements authenticated encryption at rest using Node.js native crypto with AES-256-GCM.
 *
 * Envelope Format:
 *   enc:v1:<keyId>:<base64-payload>
 * Payload:
 *   12-byte random IV + 16-byte authentication tag + ciphertext
 *
 * Security Invariants:
 * 1. Authenticated Encryption: Every ciphertext has a 128-bit MAC tag verified before decryption.
 * 2. Fresh IV: A new cryptographically secure 12-byte IV is generated for every write.
 * 3. Dedicated Key: Uses BANK_ENCRYPTION_KEY. Zero fallback to SESSION_SECRET.
 * 4. Fail-Closed: Production mode strictly fails closed if key is missing or invalid.
 * 5. Tamper Proof: Corrupted, truncated, or tampered payloads immediately throw explicit errors.
 * 6. Dual-Read Backward Compatibility: Unprefixed legacy values are recognized as plaintext.
 */

import crypto from 'crypto';

export const CURRENT_ENVELOPE_VERSION = 'v1';
export const DEFAULT_KEY_ID = 'k1';

// Deterministic test key used exclusively during unit tests / development when env var is omitted
const DEV_TEST_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export class EncryptionService {
  private static activeKeyId: string = DEFAULT_KEY_ID;
  private static keyRing: Map<string, Buffer> = new Map();
  private static initialized: boolean = false;

  /**
   * Initializes the cryptographic key ring.
   * Loads primary BANK_ENCRYPTION_KEY, active key ID, and optional historical keys.
   */
  public static init(
    customActiveKeyHex?: string,
    historicalKeys?: Record<string, string>,
    activeKeyId?: string
  ): void {
    this.keyRing.clear();

    let primaryKeyHex = customActiveKeyHex || process.env.BANK_ENCRYPTION_KEY;

    if (!primaryKeyHex || primaryKeyHex.trim() === '') {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          '[SECURITY VIOLATION] BANK_ENCRYPTION_KEY is required in production mode. Refusing to boot.'
        );
      }
      // Isolated development / test fallback (never used in production)
      primaryKeyHex = DEV_TEST_KEY_HEX;
    }

    const cleanHex = primaryKeyHex.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
      throw new Error(
        `[SECURITY VIOLATION] BANK_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (256 bits). Received length: ${cleanHex.length}.`
      );
    }

    const effectiveActiveId = (activeKeyId || process.env.BANK_ACTIVE_KEY_ID || DEFAULT_KEY_ID).trim();
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(effectiveActiveId)) {
      throw new Error(`[SECURITY VIOLATION] Active key ID "${effectiveActiveId}" is invalid. Must be 1-32 characters [a-zA-Z0-9_-].`);
    }

    this.activeKeyId = effectiveActiveId;
    this.keyRing.set(effectiveActiveId, Buffer.from(cleanHex, 'hex'));

    // Resolve historical keys dictionary from argument or environment variable
    let histKeysMap: Record<string, string> = {};
    if (historicalKeys && typeof historicalKeys === 'object') {
      histKeysMap = historicalKeys;
    } else if (process.env.BANK_HISTORICAL_KEYS && process.env.BANK_HISTORICAL_KEYS.trim() !== '') {
      try {
        const parsed = JSON.parse(process.env.BANK_HISTORICAL_KEYS.trim());
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          histKeysMap = parsed as Record<string, string>;
        }
      } catch {
        throw new Error('[SECURITY VIOLATION] BANK_HISTORICAL_KEYS environment variable contains invalid JSON.');
      }
    }

    // Register historical keys for key rotation support
    for (const [keyId, hex] of Object.entries(histKeysMap)) {
      if (typeof hex === 'string' && /^[0-9a-fA-F]{64}$/.test(hex.trim())) {
        // Do not overwrite active key if already set with identical ID
        if (keyId === effectiveActiveId && hex.trim().toLowerCase() !== cleanHex.toLowerCase()) {
          throw new Error(
            `[SECURITY VIOLATION] Historical key ID "${keyId}" conflicts with active key ID with different key material.`
          );
        }
        this.keyRing.set(keyId, Buffer.from(hex.trim(), 'hex'));
      }
    }

    this.initialized = true;
  }

  /**
   * Returns current active key ID used for new writes
   */
  public static getActiveKeyId(): string {
    this.ensureInitialized();
    return this.activeKeyId;
  }

  /**
   * Returns all key IDs currently registered in key ring
   */
  public static getRegisteredKeyIds(): string[] {
    this.ensureInitialized();
    return Array.from(this.keyRing.keys());
  }

  /**
   * Resets internal key ring state for tests
   */
  public static resetKeyRingForTesting(): void {
    this.keyRing.clear();
    this.initialized = false;
    this.activeKeyId = DEFAULT_KEY_ID;
  }

  /**
   * Sets active key ID and registers new key for key rotation
   */
  public static registerKey(keyId: string, keyHexOrBuf: string | Buffer, makeActive: boolean = false): void {
    let buf: Buffer;
    if (Buffer.isBuffer(keyHexOrBuf)) {
      if (keyHexOrBuf.length !== 32) {
        throw new Error(`[SECURITY VIOLATION] Key "${keyId}" buffer must be exactly 32 bytes.`);
      }
      buf = keyHexOrBuf;
    } else {
      if (!/^[0-9a-fA-F]{64}$/.test(keyHexOrBuf.trim())) {
        throw new Error(`[SECURITY VIOLATION] Key "${keyId}" must be a 64-character hexadecimal string.`);
      }
      buf = Buffer.from(keyHexOrBuf.trim(), 'hex');
    }
    this.keyRing.set(keyId, buf);
    this.initialized = true;
    if (makeActive) {
      this.activeKeyId = keyId;
    }
  }

  /**
   * Ensures key ring is initialized
   */
  private static ensureInitialized(): void {
    if (!this.initialized || this.keyRing.size === 0) {
      this.init();
    }
  }

  /**
   * Checks if a string has a valid versioned encryption envelope
   */
  public static isEncrypted(value: string | null | undefined): boolean {
    if (!value || typeof value !== 'string') return false;
    return value.startsWith('enc:v1:');
  }

  /**
   * Encrypts plaintext using AES-256-GCM with fresh 12-byte IV
   * Returns: enc:v1:<keyId>:<base64(iv + tag + ciphertext)>
   */
  public static encrypt(plaintext: string | null | undefined): string | null {
    if (plaintext === null || plaintext === undefined) return null;
    const str = String(plaintext);
    if (str.length === 0) return '';

    this.ensureInitialized();

    const key = this.keyRing.get(this.activeKeyId);
    if (!key) {
      throw new Error(`[CRYPTO_ERROR] Active encryption key "${this.activeKeyId}" not found in key ring.`);
    }

    // Fresh 12-byte (96-bit) IV for every encryption
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag(); // 16 bytes (128 bits)

    // Binary bundle: IV (12B) + Tag (16B) + Ciphertext
    const binaryBundle = Buffer.concat([iv, tag, ciphertext]);
    const base64Payload = binaryBundle.toString('base64');

    const envelope = `enc:v1:${this.activeKeyId}:${base64Payload}`;
    if (envelope.length > 255) {
      throw new Error(
        `[CRYPTO_ERROR] Ciphertext envelope exceeds VARCHAR(255) limit. Length: ${envelope.length}.`
      );
    }

    return envelope;
  }

  /**
   * Decrypts an encrypted envelope.
   * If value does not start with enc:v1:, handles backward-compatible legacy plaintext reads.
   */
  public static decrypt(storedValue: string | null | undefined): string | null {
    if (storedValue === null || storedValue === undefined) return null;
    const str = String(storedValue);
    if (str.length === 0) return '';

    // Check for unsupported envelope versions
    if (str.startsWith('enc:') && !str.startsWith('enc:v1:')) {
      const parts = str.split(':');
      throw new Error(
        `[CRYPTO_ERROR] Unsupported encryption envelope version: "${parts[1] || 'unknown'}". Only "v1" is supported.`
      );
    }

    // Backward compatibility: If not encrypted, return legacy plaintext directly
    if (!str.startsWith('enc:v1:')) {
      return str;
    }

    this.ensureInitialized();

    const parts = str.split(':');
    // Expected: ['enc', 'v1', keyId, base64Payload]
    if (parts.length !== 4 || parts[0] !== 'enc' || parts[1] !== 'v1') {
      throw new Error('[CRYPTO_ERROR] Invalid or unsupported ciphertext envelope structure.');
    }

    const keyId = parts[2];
    const base64Payload = parts[3];

    const key = this.keyRing.get(keyId);
    if (!key) {
      throw new Error(
        `[CRYPTO_ERROR] Unknown encryption key ID "${keyId}". Historical key must be registered to decrypt this record.`
      );
    }

    let binaryBundle: Buffer;
    try {
      binaryBundle = Buffer.from(base64Payload, 'base64');
    } catch {
      throw new Error('[CRYPTO_ERROR] Corrupted Base64 ciphertext payload.');
    }

    // Minimum payload size: 12 bytes IV + 16 bytes Tag = 28 bytes
    if (binaryBundle.length < 28) {
      throw new Error('[CRYPTO_ERROR] Ciphertext payload is truncated or corrupted (less than 28 bytes).');
    }

    const iv = binaryBundle.subarray(0, 12);
    const tag = binaryBundle.subarray(12, 28);
    const ciphertext = binaryBundle.subarray(28);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString('utf8');
    } catch (err: any) {
      throw new Error(
        `[CRYPTO_AUTH_FAILED] Decryption authentication failed: Ciphertext or authentication tag was tampered with or corrupted.`
      );
    }
  }

  /**
   * Masking helpers for safe API responses
   */
  public static maskAccountNumber(accountNumber: string | null | undefined): string {
    if (!accountNumber) return '';
    const clean = accountNumber.trim();
    if (clean.length <= 4) return '••••';
    const last4 = clean.slice(-4);
    return `•••• •••• ${last4}`;
  }

  public static maskIban(iban: string | null | undefined): string {
    if (!iban) return '';
    const clean = iban.replace(/\s+/g, '').toUpperCase();
    if (clean.length < 6) return '••••';
    const country = clean.slice(0, 2);
    const last4 = clean.slice(-4);
    return `${country}•• •••• •••• ${last4}`;
  }

  public static maskRoutingCode(routingCode: string | null | undefined): string {
    if (!routingCode) return '';
    const clean = routingCode.trim();
    if (clean.length <= 4) return '••••';
    const last4 = clean.slice(-4);
    return `•••••${last4}`;
  }

  public static maskUpiId(upiId: string | null | undefined): string {
    if (!upiId) return '';
    const clean = upiId.trim();
    const atIndex = clean.indexOf('@');
    if (atIndex <= 0) return '•••@•••';
    const user = clean.slice(0, atIndex);
    const handle = clean.slice(atIndex);
    const visibleUser = user.length > 2 ? user.slice(0, 2) : user.slice(0, 1);
    return `${visibleUser}•••${handle}`;
  }
}
