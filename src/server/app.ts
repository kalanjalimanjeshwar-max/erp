import express, { Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { apiRouter } from './routes/api.routes.js';
import { errorHandler } from './middleware/error.middleware.js';

export function createApp(): Express {
  const app = express();

  // Respect X-Forwarded-Proto and X-Forwarded-For behind HTTPS reverse proxies
  app.set('trust proxy', 1);

  // Standard middleware
  app.use(
    cors({
      origin: true,
      credentials: true,
    })
  );
  app.use(cookieParser());
  app.use('/api/expenses/attachments', express.json({ limit: '15mb' }));
  app.use(
    ['/api/company/branding', '/api/setup/branding', '/api/documents/export'],
    express.json({ limit: '5mb' })
  );
  app.use(
    ['/api/company/branding', '/api/setup/branding'],
    express.raw({
      type: ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'],
      limit: '2.2mb',
    })
  );
  app.use(express.json());

  // Mount API endpoints
  app.use('/api', apiRouter);

  // Global Error Handler
  app.use(errorHandler);

  return app;
}
