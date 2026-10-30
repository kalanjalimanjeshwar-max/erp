import { Request, Response, NextFunction } from 'express';
import { AuthService, SESSION_COOKIE_NAME, SESSION_DURATION_SECONDS } from '../services/auth.service.js';
import { CompanyService } from '../services/company.service.js';
import { LoginResponse } from '../../shared/types.js';

export class AuthController {
  /**
   * POST /api/auth/login
   */
  static async login(req: Request, res: Response<LoginResponse>, next: NextFunction): Promise<void> {
    try {
      const { email, password } = req.body;

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
      };

      const { sessionToken, response } = await AuthService.login(email, password, metadata);

      // Set tamper-evident HTTP-Only cookie
      res.cookie(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_DURATION_SECONDS * 1000,
      });

      res.status(200).json(response);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/auth/logout
   */
  static async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (req.user) {
        await AuthService.logout(req.user.id, req.user.companyId, {
          ipAddress: req.ip || req.socket.remoteAddress,
          userAgent: req.get('User-Agent'),
          correlationId: req.correlationId,
        });
      }

      // Clear session cookie
      res.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        path: '/',
      });

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
