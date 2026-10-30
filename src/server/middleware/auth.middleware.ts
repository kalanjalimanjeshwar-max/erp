import { Request, Response, NextFunction } from 'express';
import { AuthService, SESSION_COOKIE_NAME } from '../services/auth.service.js';
import { PermissionService } from '../services/permission.service.js';
import { AuthUser, AppModule, AppAction, ApiErrorResponse } from '../../shared/types.js';

// Extend Express Request with authenticated user context
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      correlationId?: string;
    }
  }
}

/**
 * Extracts and verifies session token from HTTP-only cookie or Bearer authorization header
 */
export async function requireAuth(
  req: Request,
  res: Response<ApiErrorResponse>,
  next: NextFunction
): Promise<void> {
  const timestamp = new Date().toISOString();

  // Extract correlation ID or assign one
  req.correlationId = (req.headers['x-correlation-id'] as string) || `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // 1. Check HttpOnly cookie first, then fallback to Authorization header
  let rawToken: string | undefined = req.cookies?.[SESSION_COOKIE_NAME];

  if (!rawToken && req.headers.authorization?.startsWith('Bearer ')) {
    rawToken = req.headers.authorization.substring(7);
  }

  if (!rawToken) {
    res.status(401).json({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication session required to access this endpoint.',
        timestamp,
      },
    });
    return;
  }

  const sessionPayload = AuthService.verifySessionToken(rawToken);

  if (!sessionPayload) {
    res.status(401).json({
      error: {
        code: 'SESSION_EXPIRED',
        message: 'Session has expired or is invalid. Please sign in again.',
        timestamp,
      },
    });
    return;
  }

  // Validate active account and tokenVersion
  const freshUser = await AuthService.validateSessionUser(sessionPayload);

  if (!freshUser) {
    res.status(401).json({
      error: {
        code: 'ACCOUNT_INACTIVE_OR_REVOKED',
        message: 'Account is inactive or session has been revoked.',
        timestamp,
      },
    });
    return;
  }

  req.user = freshUser;
  next();
}

/**
 * Server-side authorization check enforcing the explicit permission matrix
 */
export function requirePermission(module: AppModule, action: AppAction) {
  return async (req: Request, res: Response<ApiErrorResponse>, next: NextFunction): Promise<void> => {
    const timestamp = new Date().toISOString();

    if (!req.user) {
      res.status(401).json({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authentication required.',
          timestamp,
        },
      });
      return;
    }

    const isGranted = await PermissionService.hasPermission(
      req.user.companyId,
      req.user.role,
      module,
      action
    );

    if (!isGranted) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN_PERMISSION_DENIED',
          message: `Access denied. Role "${req.user.role}" does not have permission "${action}" on module "${module}".`,
          timestamp,
        },
      });
      return;
    }

    next();
  };
}

/**
 * Enforces company boundary isolation
 * Guarantees that any companyId route parameter matches the authenticated user's company scope
 */
export function enforceCompanyScope(
  req: Request,
  res: Response<ApiErrorResponse>,
  next: NextFunction
): void {
  const timestamp = new Date().toISOString();
  const routeCompanyId = req.params.companyId;

  if (routeCompanyId && req.user && routeCompanyId !== req.user.companyId) {
    res.status(403).json({
      error: {
        code: 'CROSS_COMPANY_ACCESS_FORBIDDEN',
        message: 'Access denied. You cannot access or modify resources from another company.',
        timestamp,
      },
    });
    return;
  }

  next();
}
