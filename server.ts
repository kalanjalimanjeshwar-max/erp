import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createApp } from './src/server/app.js';
import { validateEnv, sanitizeDatabaseUrl } from './src/server/config/env.js';
import { checkPostgresHealth } from './src/server/db/health.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  console.log('\n[CoreERP] Initializing CoreERP Platform (Phase 1)...');

  // 1. Resolve port: check CLI args (--port 3000) or default to 3000 for AI Studio dev server
  const portArgIndex = process.argv.findIndex((arg) => arg === '--port' || arg === '-p');
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    process.env.PORT = process.argv[portArgIndex + 1];
  } else if (!process.env.PORT || process.env.NODE_ENV !== 'production') {
    process.env.PORT = '3000';
  }

  // Environment validation
  const config = validateEnv();
  console.log(`[CoreERP] Environment: ${config.NODE_ENV}`);
  console.log(`[CoreERP] Port: ${config.PORT}`);
  console.log(`[CoreERP] PostgreSQL Target: ${sanitizeDatabaseUrl(config.DATABASE_URL)}`);

  // 2. Safe Diagnostics probe
  const dbHealth = await checkPostgresHealth();
  if (dbHealth.status === 'connected') {
    console.log(`[CoreERP] PostgreSQL Connected successfully (${dbHealth.latencyMs}ms).`);
  } else {
    console.warn(
      `[CoreERP] Notice: PostgreSQL is currently not reachable (${dbHealth.error || 'Connection pending'}).`
    );
    console.warn(
      `[CoreERP] The server will still boot to provide health diagnostic endpoints (/api/health, /api/ready) and setup guidance on the frontend.`
    );
  }

  // 3. Create Express Application
  const app = createApp();

  // 4. Vite middleware in dev or static files in production
  const isProduction = config.NODE_ENV === 'production';
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: path.resolve(__dirname, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  // 5. Start listening on port 3000 (standard AI Studio upstream port)
  const port = config.PORT || 3000;
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[CoreERP] Server running at http://0.0.0.0:${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[CoreERP] Port ${port} is already in use.`);
    } else {
      console.error('[CoreERP] Server error:', err);
    }
  });

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`\n[CoreERP] Received ${signal}. Shutting down gracefully...`);
    server.close(async () => {
      console.log('[CoreERP] HTTP server closed.');
      try {
        const { prisma } = await import('./src/server/db/client.js');
        await prisma.$disconnect();
        console.log('[CoreERP] PostgreSQL connections closed.');
      } catch {
        // Disconnect error ignored during shutdown
      }
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('[CoreERP] Fatal server startup failure:', err);
  process.exit(1);
});
