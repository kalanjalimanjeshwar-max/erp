import { prisma } from '../db/client.js';
import { AuditSeverity } from '../../shared/types.js';

// Keys that must NEVER be written to audit log records
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /passwordhash/i,
  /secret/i,
  /token/i,
  /apikey/i,
  /privatekey/i,
  /auth/i,
  /authorization/i,
  /session/i,
  /cookie/i,
  /bridgetoken/i,
  /smstoken/i,
  /creditcard/i,
  /cvv/i,
  /pin/i,
];

/**
 * Deeply sanitizes metadata objects to remove passwords, tokens, and secrets before persistence
 */
export function sanitizeAuditMetadata(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    // Redact connection strings or tokens embedded in strings
    return data.replace(/(postgresql|postgres):\/\/[^@\s]+@/gi, '$1://***:***@');
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeAuditMetadata(item));
  }

  if (typeof data === 'object') {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const isSensitiveKey = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
      if (isSensitiveKey) {
        sanitizedObj[key] = '[REDACTED]';
      } else {
        sanitizedObj[key] = sanitizeAuditMetadata(value);
      }
    }
    return sanitizedObj;
  }

  return data;
}

export interface CreateAuditEntryInput {
  companyId?: string | null;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  severity?: AuditSeverity;
  correlationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | string | null;
  details?: Record<string, unknown> | string | null;
}

export class AuditService {
  /**
   * Persists an audit log entry after strictly sanitizing all metadata to prevent secret leakage.
   * Supports an optional Prisma transaction client (txClient) to enable atomic audit logging
   * within database business transactions. If omitted, uses the default global prisma client.
   */
  static async log(input: CreateAuditEntryInput, txClient?: any) {
    let sanitizedDetails: string | undefined = undefined;
    const rawData = input.metadata ?? input.details;

    if (rawData) {
      if (typeof rawData === 'string') {
        try {
          const parsed = JSON.parse(rawData);
          sanitizedDetails = JSON.stringify(sanitizeAuditMetadata(parsed));
        } catch {
          sanitizedDetails = String(sanitizeAuditMetadata(rawData));
        }
      } else {
        sanitizedDetails = JSON.stringify(sanitizeAuditMetadata(rawData));
      }
    }

    const client = (txClient || prisma) as typeof prisma;
    return client.auditLog.create({
      data: {
        companyId: input.companyId || null,
        userId: input.userId || null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId || null,
        severity: input.severity || 'INFO',
        correlationId: input.correlationId || null,
        ipAddress: input.ipAddress || null,
        userAgent: input.userAgent || null,
        details: sanitizedDetails || null,
      },
    });
  }

  /**
   * Retrieves audit logs strictly scoped to a specific company
   * Prevents any cross-company visibility of audit trails
   */
  static async getCompanyAuditLogs(
    companyId: string,
    options?: { limit?: number; offset?: number; entity?: string }
  ) {
    if (!companyId) {
      throw new Error('companyId is mandatory for querying company audit records.');
    }

    const where: { companyId: string; entity?: string } = {
      companyId,
    };

    if (options?.entity) {
      where.entity = options.entity;
    }

    return prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: options?.limit || 50,
      skip: options?.offset || 0,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true,
          },
        },
      },
    });
  }

  /**
   * Safe audit log retention cleanup
   * Deletes audit logs older than the specified retention window for a given company
   */
  static async purgeExpiredLogs(companyId: string, retentionDays: number) {
    if (!companyId) {
      throw new Error('companyId is required for audit log retention purge.');
    }
    if (retentionDays < 90) {
      throw new Error('Regulatory retention policy mandates keeping audit records for at least 90 days.');
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    return prisma.auditLog.deleteMany({
      where: {
        companyId,
        createdAt: {
          lt: cutoffDate,
        },
      },
    });
  }
}
