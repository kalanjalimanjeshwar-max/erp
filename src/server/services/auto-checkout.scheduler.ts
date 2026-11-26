import {
  AutoCheckoutCycleResult,
  AutoCheckoutService,
} from './auto-checkout.service.js';
import {
  isPostgresPortReachable,
  parseHostAndPort,
  sanitizeDatabaseError,
} from '../db/health.js';

export const DEFAULT_AUTO_CHECKOUT_POLL_INTERVAL_MS = 30_000;

export interface AutoCheckoutSchedulerOptions {
  pollIntervalMs?: number;
  nowProvider?: () => Date;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  /**
   * Optional override for database reachability check before running a cycle.
   * In non-test runtimes, defaults to a fast non-blocking TCP socket probe against
   * DATABASE_URL so Prisma does not emit noisy PrismaClientInitializationError traces
   * when PostgreSQL is offline or starting up.
   */
  dbReachabilityCheck?: () => Promise<boolean>;
}

function isPrismaConnectivityError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const e = err as { name?: string; code?: string; errorCode?: string; message?: string };
  const code = e.code || e.errorCode;
  if (e.name === 'PrismaClientInitializationError') {
    return true;
  }
  if (code === 'P1001' || code === 'P1002' || code === 'P1003' || code === 'P1017') {
    return true;
  }
  const msg = typeof e.message === 'string' ? e.message : '';
  return (
    msg.includes('PrismaClientInitializationError') ||
    msg.includes("Can't reach database server") ||
    msg.includes('Server has closed the connection') ||
    msg.includes('Connection refused') ||
    msg.includes('ECONNREFUSED')
  );
}

async function defaultDbReachabilityCheck(): Promise<boolean> {
  // Unit tests mock Prisma delegates without a live PostgreSQL instance
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    return true;
  }
  const rawUrl = process.env.DATABASE_URL?.trim().replace(/^["']|["']$/g, '') || '';
  if (!rawUrl) {
    return false;
  }
  const { host, port } = parseHostAndPort(rawUrl);
  return isPostgresPortReachable(host, port, 1500);
}

/**
 * Lightweight, non-overlapping scheduler that polls company timezones every 30 seconds
 * (by default) and triggers `AutoCheckoutService.runScheduledCycle()` to:
 * 1. Detect and safely recover missed prior-date Auto Check-Outs on startup and every cycle
 *    (e.g. after server downtime across the 23:55–23:59 local-time window).
 * 2. Execute normal daily 11:55 PM (23:55) local-time check-out for due companies.
 *
 * Per-company-date deduplication prevents redundant runs within the same cycle/window,
 * and database-level conditional updates + advisory locks guarantee strict idempotency
 * across server restarts or multi-instance deployments.
 */
export class AutoCheckoutScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningCycle = false;
  private dbUnavailableLogged = false;
  private readonly completedKeys = new Set<string>();
  private readonly pollIntervalMs: number;
  private readonly nowProvider: () => Date;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly dbReachabilityCheck: () => Promise<boolean>;

  constructor(options: AutoCheckoutSchedulerOptions = {}) {
    this.pollIntervalMs =
      options.pollIntervalMs && options.pollIntervalMs > 0
        ? options.pollIntervalMs
        : DEFAULT_AUTO_CHECKOUT_POLL_INTERVAL_MS;
    this.nowProvider = options.nowProvider || (() => new Date());
    this.logger = options.logger || console;
    this.dbReachabilityCheck = options.dbReachabilityCheck || defaultDbReachabilityCheck;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    // Immediate non-blocking check on startup to recover any missed prior dates after an
    // outage and handle servers started inside the 23:55–23:59 local-time window
    void this.tick().catch((err) => {
      this.logger.error('[AutoCheckoutScheduler] Initial tick failed:', err);
    });

    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.error('[AutoCheckoutScheduler] Scheduled tick failed:', err);
      });
    }, this.pollIntervalMs);

    // Prevent timer from keeping short-lived scripts or graceful shutdowns alive
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(referenceNow?: Date): Promise<AutoCheckoutCycleResult | null> {
    if (this.runningCycle) {
      return null;
    }

    this.runningCycle = true;
    try {
      const dbReachable = await this.dbReachabilityCheck();
      if (!dbReachable) {
        if (!this.dbUnavailableLogged) {
          this.dbUnavailableLogged = true;
          this.logger.warn(
            '[AutoCheckoutScheduler] PostgreSQL is currently unreachable; deferring auto check-out cycles until database connectivity is restored.'
          );
        }
        return null;
      }

      const now = referenceNow || this.nowProvider();
      const result = await AutoCheckoutService.runScheduledCycle(now, this.completedKeys);

      const connectivityErrors = result.errors.filter((e) =>
        isPrismaConnectivityError({ message: e.message })
      );
      const nonConnectivityErrors = result.errors.filter(
        (e) => !isPrismaConnectivityError({ message: e.message })
      );

      if (connectivityErrors.length > 0) {
        if (!this.dbUnavailableLogged) {
          this.dbUnavailableLogged = true;
          const sanitized = sanitizeDatabaseError(
            new Error(connectivityErrors[0].message),
            process.env.DATABASE_URL
          );
          this.logger.warn(
            `[AutoCheckoutScheduler] Database connectivity unavailable during cycle (${sanitized.sanitizedMessage}); deferring auto check-out cycles until restored.`
          );
        }
      } else if (this.dbUnavailableLogged) {
        this.dbUnavailableLogged = false;
        this.logger.info(
          '[AutoCheckoutScheduler] PostgreSQL connectivity restored; resumed auto check-out cycles.'
        );
      }

      if (result.totalAutoCheckedOut > 0) {
        this.logger.info(
          `[AutoCheckoutScheduler] Auto checked out ${result.totalAutoCheckedOut} attendance record(s) across ${result.companyResults.length} company-date run(s) (due: ${result.dueCompanies}, outage-recovered: ${result.recoveredCompanyDates}).`
        );
      }

      if (nonConnectivityErrors.length > 0) {
        for (const err of nonConnectivityErrors) {
          this.logger.error(
            `[AutoCheckoutScheduler] Company ${err.companyId} auto check-out error: ${err.message}`
          );
        }
      }

      return result;
    } catch (err) {
      if (isPrismaConnectivityError(err)) {
        if (!this.dbUnavailableLogged) {
          this.dbUnavailableLogged = true;
          const sanitized = sanitizeDatabaseError(err, process.env.DATABASE_URL);
          this.logger.warn(
            `[AutoCheckoutScheduler] Database connectivity unavailable (${sanitized.sanitizedMessage}); deferring auto check-out cycles until restored.`
          );
        }
        return null;
      }
      throw err;
    } finally {
      this.runningCycle = false;
    }
  }
}

export const defaultAutoCheckoutScheduler = new AutoCheckoutScheduler();
