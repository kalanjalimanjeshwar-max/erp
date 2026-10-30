import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../db/client.js';
import { Role, AuthUser, CompanyProfile, LoginResponse } from '../../shared/types.js';
import { AuditService } from './audit.service.js';
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

export class AuthService {
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
   * Verifies and decodes a signed session token
   */
  static verifySessionToken(token: string): SessionPayload | null {
    if (!token || typeof token !== 'string') return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, payload, signature] = parts;
    const config = getConfig();

    const expectedSignature = crypto
      .createHmac('sha256', config.SESSION_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');

    // Constant-time comparison to prevent timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return null;
    }

    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionPayload;
      const now = Math.floor(Date.now() / 1000);

      if (decoded.exp < now) {
        return null; // Expired
      }

      return decoded;
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
   * Authenticates user with email and password
   * Returns generic error on failure to prevent user enumeration
   */
  static async login(
    emailInput: string,
    passwordInput: string,
    metadata?: { ipAddress?: string; userAgent?: string; correlationId?: string }
  ): Promise<{ sessionToken: string; response: LoginResponse }> {
    const email = emailInput.trim().toLowerCase();
    const rateLimitKey = `${email}:${metadata?.ipAddress || 'unknown'}`;

    if (!this.checkRateLimit(rateLimitKey)) {
      const err = new Error('Too many failed login attempts. Account temporarily locked for 15 minutes.');
      (err as { statusCode?: number }).statusCode = 429;
      throw err;
    }

    // Generic error message for all credential/account failures
    const genericAuthError = () => {
      const err = new Error('Invalid email or password.');
      (err as { statusCode?: number }).statusCode = 401;
      return err;
    };

    let user;
    try {
      user = await prisma.user.findFirst({
        where: { email },
        include: { company: true },
      });
    } catch {
      this.recordFailedAttempt(rateLimitKey);
      throw genericAuthError();
    }

    if (!user) {
      this.recordFailedAttempt(rateLimitKey);
      await AuditService.log({
        action: 'AUTH_LOGIN_FAILED',
        entity: 'User',
        severity: 'WARN',
        correlationId: metadata?.correlationId,
        ipAddress: metadata?.ipAddress,
        userAgent: metadata?.userAgent,
        metadata: { reason: 'User not found' },
      });
      throw genericAuthError();
    }

    // Check account lockout
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const err = new Error('Account is temporarily locked due to excessive failed attempts. Please try again later.');
      (err as { statusCode?: number }).statusCode = 429;
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
        ipAddress: metadata?.ipAddress,
        userAgent: metadata?.userAgent,
      });
      throw genericAuthError();
    }

    // Verify bcrypt password hash
    const isPasswordValid = await bcrypt.compare(passwordInput, user.passwordHash);

    if (!isPasswordValid) {
      this.recordFailedAttempt(rateLimitKey);

      // Increment failed attempts on database record
      const newAttempts = user.failedLoginAttempts + 1;
      const updates: { failedLoginAttempts: number; lockedUntil?: Date } = {
        failedLoginAttempts: newAttempts,
      };

      if (newAttempts >= 5) {
        updates.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15-minute lock
      }

      await prisma.user.update({
        where: { id: user.id },
        data: updates,
      }).catch(() => null);

      await AuditService.log({
        companyId: user.companyId,
        userId: user.id,
        action: 'AUTH_LOGIN_FAILED_CREDENTIALS',
        entity: 'User',
        entityId: user.id,
        severity: 'WARN',
        correlationId: metadata?.correlationId,
        ipAddress: metadata?.ipAddress,
        userAgent: metadata?.userAgent,
      });

      throw genericAuthError();
    }

    // Login successful: reset failed attempts and update lastLoginAt
    this.clearFailedAttempts(rateLimitKey);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: metadata?.ipAddress || null,
      },
    });

    const authUser: AuthUser = {
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

    const companyProfile: CompanyProfile = {
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
    };

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
      ipAddress: metadata?.ipAddress,
      userAgent: metadata?.userAgent,
    });

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
        ipAddress: metadata?.ipAddress,
        userAgent: metadata?.userAgent,
      });
    } catch {
      // Safe exit
    }
  }

  /**
   * Validates active account status and retrieves fresh session context
   */
  static async validateSessionUser(session: SessionPayload): Promise<AuthUser | null> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: session.userId },
      });

      if (!user) return null;
      if (!user.isActive) return null;
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
    } catch {
      return null;
    }
  }
}
