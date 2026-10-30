import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ApiErrorResponse } from '../../shared/types.js';

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response<ApiErrorResponse>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const timestamp = new Date().toISOString();

  // 1. Zod Validation Errors
  if (err instanceof ZodError) {
    const formattedIssues = err.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));

    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data provided',
        details: formattedIssues,
        timestamp,
      },
    });
    return;
  }

  // 2. Custom status code errors
  const customErr = err as { statusCode?: number; status?: number; message?: string; code?: string };
  const statusCode = customErr.statusCode || customErr.status || 500;
  const message = customErr.message || 'An unexpected internal error occurred';

  // 3. PostgreSQL / Prisma specific safe error parsing
  if (customErr.code === 'P2002') {
    res.status(409).json({
      error: {
        code: 'UNIQUE_CONSTRAINT_VIOLATION',
        message: 'A record with this identifier or unique attribute already exists',
        timestamp,
      },
    });
    return;
  }

  if (customErr.code === 'P1001' || message.includes('connect ECONNREFUSED')) {
    res.status(503).json({
      error: {
        code: 'DATABASE_UNREACHABLE',
        message: 'PostgreSQL database service is currently unavailable. Please verify container or connection state.',
        timestamp,
      },
    });
    return;
  }

  // Never leak credentials or stack traces
  const safeMessage = message.replace(/(postgresql|postgres):\/\/[^@\s]+@/gi, '$1://***:***@');

  res.status(statusCode).json({
    error: {
      code: customErr.code || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: safeMessage,
      timestamp,
    },
  });
}
