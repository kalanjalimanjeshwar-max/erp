import { Request, Response } from 'express';
import { checkPostgresHealth } from '../db/health.js';
import { HealthResponse, ReadinessResponse } from '../../shared/types.js';
import { APP_VERSION } from '../../shared/constants.js';

const processStartTime = Date.now();

export class HealthController {
  /**
   * GET /api/health
   * Liveness probe: Returns process health, uptime, and version
   */
  static getHealth(_req: Request, res: Response<HealthResponse>): void {
    const uptimeSeconds = Math.floor((Date.now() - processStartTime) / 1000);
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds,
      environment: process.env.NODE_ENV || 'development',
      version: APP_VERSION,
    });
  }

  /**
   * GET /api/ready
   * Readiness probe: Checks real PostgreSQL database connectivity
   * Returns 200 when ready, 503 Service Unavailable when PostgreSQL is unreachable
   */
  static async getReadiness(_req: Request, res: Response<ReadinessResponse>): Promise<void> {
    const postgresCheck = await checkPostgresHealth();
    const isReady = postgresCheck.status === 'connected';

    const response: ReadinessResponse = {
      status: isReady ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        postgres: postgresCheck,
      },
      details: isReady
        ? 'All dependencies are operational and accepting requests.'
        : `PostgreSQL connection check failed: ${postgresCheck.error || 'Unavailable'}. Action required: Ensure PostgreSQL is running and DATABASE_URL is reachable.`,
    };

    res.status(isReady ? 200 : 503).json(response);
  }
}
