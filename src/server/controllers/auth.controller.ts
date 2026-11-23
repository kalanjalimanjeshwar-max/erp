import { CookieOptions, Request, Response, NextFunction } from 'express';
import { AuthService, SESSION_COOKIE_NAME, SESSION_DURATION_SECONDS } from '../services/auth.service.js';
import { CompanyService } from '../services/company.service.js';
import { isCookieCsrfRequestAllowed } from '../middleware/auth.middleware.js';
import { LoginResponse } from '../../shared/types.js';

/**
 * Determines whether the incoming request arrived over HTTPS (direct TLS or via reverse proxy).
 */
export function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    const firstProto = forwardedProto.split(',')[0]?.trim().toLowerCase();
    return firstProto === 'https';
  }
  if (Array.isArray(forwardedProto) && forwardedProto.length > 0) {
    return forwardedProto[0].trim().toLowerCase() === 'https';
  }
  return false;
}

/**
 * Builds consistent session cookie options so set-cookie and clear-cookie always match.
 * - Over HTTPS (direct TLS, reverse proxy, or embedded HTTPS iframe): HttpOnly; Secure; SameSite=None; Partitioned
 * - Over plain HTTP (local Windows development on http://localhost:3000): HttpOnly; SameSite=Lax (browsers reject SameSite=None without Secure)
 */
export function getSessionCookieOptions(req: Request): CookieOptions {
  const isHttps = isHttpsRequest(req);
  if (isHttps) {
    return {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true,
      path: '/',
    };
  }

  return {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
  };
}

function extractRawSessionToken(req: Request): string | undefined {
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof cookieToken === 'string' && cookieToken.trim()) {
    return cookieToken.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.substring(7).trim();
    if (bearer) return bearer;
  }
  return undefined;
}

export class AuthController {
  /**
   * POST /api/auth/login
   */
  static async login(req: Request, res: Response<LoginResponse>, next: NextFunction): Promise<void> {
    try {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const companyCode =
        typeof body.companyCode === 'string' && body.companyCode.trim()
          ? body.companyCode.trim().toUpperCase()
          : undefined;

      if (!email || !password) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Email and password are required.',
            timestamp: new Date().toISOString(),
          },
        } as unknown as LoginResponse);
        return;
      }

      const metadata = {
        ipAddress: req.ip || req.socket.remoteAddress,
        userAgent: req.get('User-Agent'),
        correlationId: req.correlationId,
        companyCode,
      };

      const { sessionToken, response } = await AuthService.login(email, password, metadata);

      // Set tamper-evident HTTP-Only cookie with protocol-matched attributes
      res.cookie(SESSION_COOKIE_NAME, sessionToken, {
        ...getSessionCookieOptions(req),
        maxAge: SESSION_DURATION_SECONDS * 1000,
      });

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/auth/logout
   * Revokes any valid active session (incrementing tokenVersion) and always clears the session cookie.
   */
  static async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const hasCookie = typeof req.cookies?.[SESSION_COOKIE_NAME] === 'string' && req.cookies[SESSION_COOKIE_NAME].trim().length > 0;
      if (hasCookie && !isCookieCsrfRequestAllowed(req)) {
        res.status(403).json({
          error: {
            code: 'CSRF_ORIGIN_MISMATCH',
            message: 'Cross-origin request rejected. Please refresh the page and try again.',
            timestamp: new Date().toISOString(),
          },
        });
        return;
      }

      let activeUser = req.user ?? null;

      if (!activeUser) {
        const rawToken = extractRawSessionToken(req);
        if (rawToken) {
          const payload = AuthService.verifySessionToken(rawToken);
          if (payload) {
            activeUser = await AuthService.validateSessionUser(payload).catch(() => null);
          }
        }
      }

      if (activeUser) {
        await AuthService.logout(activeUser.id, activeUser.companyId, {
          ipAddress: req.ip || req.socket.remoteAddress,
          userAgent: req.get('User-Agent'),
          correlationId: req.correlationId,
        });
      }

      // Clear session cookie using matching attributes so browsers reliably remove it
      res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions(req));

      res.status(200).json({ success: true, message: 'Logged out successfully.' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/auth/me
   * Restores authenticated session on page refresh
   */
  static async getMe(req: Request, res: Response<LoginResponse>, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Not logged in.',
            timestamp: new Date().toISOString(),
          },
        } as unknown as LoginResponse);
        return;
      }

      const company = await CompanyService.getProfile(req.user.companyId);

      res.status(200).json({
        user: req.user,
        company,
      });
    } catch (error) {
      next(error);
    }
  }
}
