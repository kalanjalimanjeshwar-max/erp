import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../db/client.js';

// Rate limiting map for failed device authentication attempts
// Key: clientIP -> { attempts: number, resetAt: number }
const deviceAuthFailures = new Map<string, { attempts: number; resetAt: number }>();
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes lockout

export interface AuthenticatedDeviceRequest extends Request {
  terminal?: any;
  companyId?: string;
}

/**
 * Middleware: Authenticates physical biometric hardware terminals or edge LAN daemons
 * using high-entropy pre-shared API keys (SHA-256 hashed).
 *
 * Strict Security Guarantees:
 * 1. Does not trust client-supplied deviceId or companyId in the body or query.
 * 2. Compares credential hashes using constant-time comparison to prevent timing attacks.
 * 3. Rate-limits repeated failed attempts per IP address.
 * 4. Rejects inactive or de-registered terminals.
 */
export async function requireDeviceAuth(
  req: AuthenticatedDeviceRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  // 1. Check rate-limiting lockout
  const failureRecord = deviceAuthFailures.get(clientIp);
  if (failureRecord && now < failureRecord.resetAt && failureRecord.attempts >= MAX_FAILED_ATTEMPTS) {
    res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many failed device authentication attempts. Please try again later.',
        retryAfterSeconds: Math.ceil((failureRecord.resetAt - now) / 1000),
      },
    });
    return;
  }

  // 2. Extract API Key from X-Device-Api-Key or Authorization: Bearer
  let rawApiKey: string | undefined;

  const headerKey = req.headers['x-device-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) {
    rawApiKey = headerKey.trim();
  } else {
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      rawApiKey = authHeader.slice(7).trim();
    }
  }

  if (!rawApiKey) {
    recordFailure(clientIp);
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED_DEVICE',
        message: 'Missing device authentication credentials. Provide X-Device-Api-Key header or Bearer authorization.',
      },
    });
    return;
  }

  // 3. Compute SHA-256 hash of provided key
  const calculatedHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');

  try {
    // 4. Query active terminal matching the hash
    const terminal = await prisma.biometricTerminal.findFirst({
      where: {
        apiKeyHash: calculatedHash,
        isActive: true,
      },
      include: {
        company: {
          select: { id: true, code: true, name: true },
        },
      },
    });

    if (!terminal) {
      recordFailure(clientIp);
      res.status(401).json({
        error: {
          code: 'INVALID_DEVICE_CREDENTIALS',
          message: 'Invalid, inactive, or revoked device API credentials.',
        },
      });
      return;
    }

    // 5. Constant-time comparison verification
    const expectedHashBuffer = Buffer.from(terminal.apiKeyHash, 'utf8');
    const providedHashBuffer = Buffer.from(calculatedHash, 'utf8');

    if (
      expectedHashBuffer.length !== providedHashBuffer.length ||
      !crypto.timingSafeEqual(expectedHashBuffer, providedHashBuffer)
    ) {
      recordFailure(clientIp);
      res.status(401).json({
        error: {
          code: 'INVALID_DEVICE_CREDENTIALS',
          message: 'Device credential verification failed.',
        },
      });
      return;
    }

    // Success: reset failures for this IP and attach terminal
    deviceAuthFailures.delete(clientIp);
    req.terminal = terminal;
    req.companyId = terminal.companyId;

    next();
  } catch (err: unknown) {
    res.status(500).json({
      error: {
        code: 'DEVICE_AUTH_ERROR',
        message: 'Internal error verifying device authorization.',
      },
    });
  }
}

function recordFailure(clientIp: string) {
  const now = Date.now();
  const record = deviceAuthFailures.get(clientIp);
  if (!record || now >= record.resetAt) {
    deviceAuthFailures.set(clientIp, { attempts: 1, resetAt: now + LOCKOUT_MS });
  } else {
    record.attempts += 1;
  }
}
