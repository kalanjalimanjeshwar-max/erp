import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../db/client.js';
import { Role, AuthUser, CompanyProfile, LoginResponse } from '../../shared/types.js';
import { AuditService } from './audit.service.js';
import { CompanyService } from './company.service.js';
import { getConfig } from '../config/env.js';

export interface SessionPayload {
  userId: string;
  companyId: string;
  email: string;
  role: Role;
  tokenVersion: number;
  exp: number; // Expiration timestamp in seconds
}

export const SESSION_COOKIE_NAME = 'coreerp_session';
export const SESSION_DURATION_SECONDS = 24 * 60 * 60; // 24 hours

// In-memory rate limiting map for repeated failed attempts
// Key: email:ip -> { attempts: number, lastAttempt: number }
const loginAttemptMap = new Map<string, { attempts: number; resetAt: number }>();

const VALID_ROLES = new Set<Role>(['SUPER_ADMIN', 'ADMIN', 'VICE_ADMIN', 'EMPLOYEE']);

function truncateString(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function isDatabaseConnectivityOrSchemaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const errObj = error as { code?: string; name?: string; message?: string };
  const code = typeof errObj.code === 'string' ? errObj.code : '';
  const name = typeof errObj.name === 'string' ? errObj.name : '';
  const message = typeof errObj.message === 'string' ? errObj.message : '';

  if (
    code === 'P1000' ||
    code === 'P1001' ||
    code === 'P1002' ||
    code === 'P1003' ||
    code === 'P1008' ||
    code === 'P1017' ||
    code === 'P2021' ||
    code === 'P2022'
  ) {
    return true;
  }

  if (
    name === 'PrismaClientInitializationError' ||
    name === 'PrismaClientRustPanicError'
  ) {
    return true;
  }

  return (
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|Can't reach database server|Connection terminated|DATABASE_URL is not set/i.test(
      message
    )
  );
}

export class AuthService {
  /**
   * Resets in-memory login rate-limit state for unit tests only.
   */
  static resetRateLimitsForTesting(): void {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('resetRateLimitsForTesting cannot be used in production mode.');
    }
    loginAttemptMap.clear();
  }

  /**
   * Generates a tamper-evident HMAC-SHA256 signed session token
   */
  static generateSessionToken(payload: Omit<SessionPayload, 'exp'>): string {
    const config = getConfig();
    const exp = Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS;
    const fullPayload: SessionPayload = { ...payload, exp };

    const encodedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const encodedPayload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');

    const signature = crypto
      .createHmac('sha256', config.SESSION_SECRET)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url');

    return `${encodedHeader}.${encodedPayload}.${signature}`;
  }

  /**
   * Verifies and decodes a signed session token safely without throwing on malformed inputs
   */
  static verifySessionToken(token: string): SessionPayload | null {
    if (!token || typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    if (!header || !payload || !signature) return null;

    try {
      const config = getConfig();
      const expectedSignature = crypto
        .createHmac('sha256', config.SESSION_SECRET)
        .update(`${header}.${payload}`)
        .digest('base64url');

      const sigBuf = Buffer.from(signature, 'utf8');
      const expectedBuf = Buffer.from(expectedSignature, 'utf8');

      // Guard byte-length mismatch before timingSafeEqual to prevent RangeError crashes
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return null;
      }

      const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
        alg?: string;
        typ?: string;
      };
      if (decodedHeader?.alg !== 'HS256') {
        return null;
      }

      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SessionPayload>;
      if (
        !decoded ||
        typeof decoded.userId !== 'string' ||
        !decoded.userId ||
        typeof decoded.companyId !== 'string' ||
        !decoded.companyId ||
        typeof decoded.email !== 'string' ||
        !decoded.email ||
        typeof decoded.role !== 'string' ||
        !VALID_ROLES.has(decoded.role as Role) ||
        typeof decoded.tokenVersion !== 'number' ||
        !Number.isInteger(decoded.tokenVersion) ||
        typeof decoded.exp !== 'number' ||
        !Number.isFinite(decoded.exp)
      ) {
        return null;
      }

      const now = Math.floor(Date.now() / 1000);
      if (decoded.exp <= now) {
        return null; // Expired
      }

      return decoded as SessionPayload;
    } catch {
      return null;
    }
  }

  /**
   * Rate limiting check for failed login attempts
   */
  private static checkRateLimit(key: string): boolean {
    const now = Date.now();
    const record = loginAttemptMap.get(key);

    if (record) {
      if (now < record.resetAt) {
        if (record.attempts >= 5) {
          return false; // Rate limited
        }
      } else {
        loginAttemptMap.delete(key);
      }
    }
    return true;
  }

  private static recordFailedAttempt(key: string): void {
    const now = Date.now();
    const record = loginAttemptMap.get(key);

    if (record && now < record.resetAt) {
      record.attempts += 1;
    } else {
      loginAttemptMap.set(key, { attempts: 1, resetAt: now + 15 * 60 * 1000 }); // 15-minute window
    }
  }

  private static clearFailedAttempts(key: string): void {
    loginAttemptMap.delete(key);
  }

  /**
   * Safely verifies a plaintext password against a stored bcrypt hash ($2a$, $2b$, $2y$).
   * Never throws on malformed/corrupted hash formats.
   */
  private static async verifyPasswordHash(passwordInput: string, storedHash: unknown): Promise<boolean> {
    if (typeof passwordInput !== 'string' || passwordInput.length === 0) {
      return false;
    }
    if (typeof storedHash !== 'string' || !/^\$2[aby]\$\d{2}\$/.test(storedHash)) {
      return false;
    }
    try {
      return await bcrypt.compare(passwordInput, storedHash);
    } catch {
      return false;
    }
  }

  /**
   * Authenticates user with email and password (and optional companyCode for multi-tenant disambiguation).
   * Returns generic 401 on credential/account failures and 503 on database connectivity failures.
   */
  static async login(
    emailInput: string,
    passwordInput: string,
    metadata?: { ipAddress?: string; userAgent?: string; correlationId?: string; companyCode?: string }
  ): Promise<{ sessionToken: string; response: LoginResponse }> {
    const email = typeof emailInput === 'string' ? emailInput.trim().toLowerCase() : '';
    const companyCode =
      typeof metadata?.companyCode === 'string' && metadata.companyCode.trim()
        ? metadata.companyCode.trim().toUpperCase()
        : undefined;
    const safeIp = truncateString(metadata?.ipAddress, 45);
    const safeUserAgent = truncateString(metadata?.userAgent, 255);
    const rateLimitKey = `${companyCode ? `${companyCode}:` : ''}${email}:${safeIp || 'unknown'}`;

    if (!this.checkRateLimit(rateLimitKey)) {
      const err = new Error('Too many failed login attempts. Account temporarily locked for 15 minutes.');
      (err as { statusCode?: number; code?: string }).statusCode = 429;
      (err as { statusCode?: number; code?: string }).code = 'RATE_LIMITED';
      throw err;
    }

    // Generic error message for all credential/account failures
    const genericAuthError = () => {
      const err = new Error('Invalid email or password.');
      (err as { statusCode?: number; code?: string }).statusCode = 401;
      (err as { statusCode?: number; code?: string }).code = 'INVALID_CREDENTIALS';
      return err;
    };

    const whereClause = companyCode
      ? {
          email: { equals: email, mode: 'insensitive' as const },
          company: { code: { equals: companyCode, mode: 'insensitive' as const } },
        }
      : {
          email: { equals: email, mode: 'insensitive' as const },
        };

    let user: any = null;
    try {
      if (!companyCode && typeof prisma.user?.findMany === 'function') {
        const matches = await prisma.user.findMany({
          where: whereClause,
          include: { company: true },
          take: 2,
        });

        if (matches.length > 1) {
          const err = new Error(
            'Multiple company accounts exist for this email. Please provide your company code to sign in.'
          );
          (err as { statusCode?: number; code?: string }).statusCode = 409;
          (err as { statusCode?: number; code?: string }).code = 'COMPANY_CODE_REQUIRED';
          throw err;
        }
        user = matches[0] ?? null;
      } else {
        user = await prisma.user.findFirst({
          where: whereClause,
          include: { company: true },
        });
      }
    } catch (dbError: unknown) {
      const customErr = dbError as { statusCode?: number; code?: string };
      if (customErr?.code === 'COMPANY_CODE_REQUIRED') {
        throw dbError;
      }

      if (isDatabaseConnectivityOrSchemaError(dbError)) {
        const err = new Error(
          'Database service is currently unavailable. Please verify PostgreSQL connection and try again.'
        );
        (err as { statusCode?: number; code?: string }).statusCode = 503;
        (err as { statusCode?: number; code?: string }).code = 'DATABASE_UNREACHABLE';
        throw err;
      }

      const err = new Error('Authentication service encountered an unexpected error. Please try again.');
      (err as { statusCode?: number; code?: string }).statusCode = 500;
      (err as { statusCode?: number; code?: string }).code = 'AUTH_LOOKUP_ERROR';
      throw err;
    }

    if (!user || !user.company) {
      this.recordFailedAttempt(rateLimitKey);
      await AuditService.log({
        action: 'AUTH_LOGIN_FAILED',
        entity: 'User',
        severity: 'WARN',
        correlationId: metadata?.correlationId,
        ipAddress: safeIp,
        userAgent: safeUserAgent,
        metadata: { reason: 'User not found' },
      }).catch(() => null);
      throw genericAuthError();
    }

    // Check account lockout
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const err = new Error('Account is temporarily locked due to excessive failed attempts. Please try again later.');
      (err as { statusCode?: number; code?: string }).statusCode = 429;
      (err as { statusCode?: number; code?: string }).code = 'ACCOUNT_LOCKED';
      throw err;
    }

    // Check active status
    if (!user.isActive) {
      this.recordFailedAttempt(rateLimitKey);
      await AuditService.log({
        companyId: user.companyId,
        userId: user.id,
        action: 'AUTH_LOGIN_REJECTED_INACTIVE',
        entity: 'User',
        entityId: user.id,
        severity: 'WARN',
        correlationId: metadata?.correlationId,
        ipAddress: safeIp,
        userAgent: safeUserAgent,
      }).catch(() => null);
      throw genericAuthError();
    }

    // Verify bcrypt password hash safely
    const isPasswordValid = await this.verifyPasswordHash(passwordInput, user.passwordHash);

    if (!isPasswordValid) {
      this.recordFailedAttempt(rateLimitKey);

      // Increment failed attempts on database record
      const newAttempts = (user.failedLoginAttempts || 0) + 1;
      const updates: { failedLoginAttempts: number; lockedUntil?: Date } = {
        failedLoginAttempts: newAttempts,
      };

      if (newAttempts >= 5) {
        updates.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15-minute lock
      }

      if (typeof prisma.user?.update === 'function') {
        await prisma.user.update({
          where: { id: user.id },
          data: updates,
        }).catch(() => null);
      }

      await AuditService.log({
        companyId: user.companyId,
        userId: user.id,
        action: 'AUTH_LOGIN_FAILED_CREDENTIALS',
        entity: 'User',
        entityId: user.id,
        severity: 'WARN',
        correlationId: metadata?.correlationId,
        ipAddress: safeIp,
        userAgent: safeUserAgent,
      }).catch(() => null);

      throw genericAuthError();
    }

    // Login successful: reset failed attempts and update lastLoginAt
    this.clearFailedAttempts(rateLimitKey);
    const loginTimestamp = new Date();

    if (typeof prisma.user?.update === 'function') {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: loginTimestamp,
          lastLoginIp: safeIp || null,
        },
      });
    }

    const authUser: AuthUser = {
      id: user.id,
      userId: user.id,
      companyId: user.companyId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      isActive: user.isActive,
      lastLoginAt: loginTimestamp.toISOString(),
      tokenVersion: user.tokenVersion,
    };

    const companyProfile: CompanyProfile = await CompanyService.getProfile(user.companyId).catch(
      () => ({
        id: user.company.id,
        code: user.company.code,
        name: user.company.name,
        legalName: user.company.legalName,
        taxId: user.company.taxId,
        currency: user.company.currency,
        timezone: user.company.timezone,
        logoUrl: user.company.logoUrl,
        address: user.company.address,
        phone: user.company.phone,
        email: user.company.email,
        website: user.company.website,
        appHeaderTitle: user.company.appHeaderTitle,
      })
    );

    const sessionToken = this.generateSessionToken({
      userId: user.id,
      companyId: user.companyId,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });

    await AuditService.log({
      companyId: user.companyId,
      userId: user.id,
      action: 'AUTH_LOGIN_SUCCESS',
      entity: 'User',
      entityId: user.id,
      severity: 'INFO',
      correlationId: metadata?.correlationId,
      ipAddress: safeIp,
      userAgent: safeUserAgent,
    }).catch(() => null);

    return {
      sessionToken,
      response: {
        user: authUser,
        company: companyProfile,
      },
    };
  }

  /**
   * Logs out user and invalidates any active session tokens by incrementing tokenVersion
   */
  static async logout(
    userId: string,
    companyId: string,
    metadata?: { ipAddress?: string; userAgent?: string; correlationId?: string }
  ): Promise<void> {
    const safeIp = truncateString(metadata?.ipAddress, 45);
    const safeUserAgent = truncateString(metadata?.userAgent, 255);
    try {
      await prisma.user.update({
        where: { id: userId },
        data: {
          tokenVersion: { increment: 1 },
        },
      });

      await AuditService.log({
        companyId,
        userId,
        action: 'AUTH_LOGOUT',
        entity: 'User',
        entityId: userId,
        severity: 'INFO',
        correlationId: metadata?.correlationId,
        ipAddress: safeIp,
        userAgent: safeUserAgent,
      }).catch(() => null);
    } catch {
      // Safe exit
    }
  }

  /**
   * Validates active account status, tenant binding, and tokenVersion to retrieve fresh session context
   */
  static async validateSessionUser(session: SessionPayload): Promise<AuthUser | null> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
      });

      if (!user) return null;
      if (!user.isActive) return null;
      if (user.companyId !== session.companyId) return null; // Strict tenant isolation check
      if (user.tokenVersion !== session.tokenVersion) return null; // Stale or revoked session

      return {
        id: user.id,
        userId: user.id,
        companyId: user.companyId,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
        tokenVersion: user.tokenVersion,
      };
    } catch (err: unknown) {
      if (isDatabaseConnectivityOrSchemaError(err)) {
        const dbErr = new Error(
          'Database service is currently unavailable. Please verify PostgreSQL connection and try again.'
        );
        (dbErr as { statusCode?: number; code?: string }).statusCode = 503;
        (dbErr as { statusCode?: number; code?: string }).code = 'DATABASE_UNREACHABLE';
        throw dbErr;
      }
      return null;
    }
  }
}
