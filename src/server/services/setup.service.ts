import bcrypt from 'bcryptjs';
import { prisma } from '../db/client.js';
import { checkPostgresHealth } from '../db/health.js';
import { InitialSetupInput } from '../validation/setup.schema.js';
import { InitialSetupResult, SetupStatusResponse } from '../../shared/types.js';

export class SetupService {
  /**
   * Evaluates whether initial company and super admin setup is required
   */
  static async getSetupStatus(): Promise<SetupStatusResponse> {
    const health = await checkPostgresHealth();
    if (health.status !== 'connected') {
      return {
        isSetupRequired: false,
        hasCompany: false,
        hasSuperAdmin: false,
        databaseConnected: false,
      };
    }

    try {
      const companyCount = await prisma.company.count();
      const superAdminCount = await prisma.user.count({
        where: { role: 'SUPER_ADMIN' },
      });

      const isSetupRequired = companyCount === 0 || superAdminCount === 0;

      let companyInfo;
      if (companyCount > 0) {
        const company = await prisma.company.findFirst({
          select: {
            name: true,
            code: true,
            currency: true,
            timezone: true,
            logoUrl: true,
          },
        });
        if (company) {
          companyInfo = company;
        }
      }

      return {
        isSetupRequired,
        hasCompany: companyCount > 0,
        hasSuperAdmin: superAdminCount > 0,
        databaseConnected: true,
        companyInfo,
      };
    } catch {
      return {
        isSetupRequired: false,
        hasCompany: false,
        hasSuperAdmin: false,
        databaseConnected: false,
      };
    }
  }

  /**
   * Atomically bootstraps the initial company and super admin user
   */
  static async bootstrapInitialSetup(
    input: InitialSetupInput,
    metadata?: { ipAddress?: string; userAgent?: string }
  ): Promise<InitialSetupResult> {
    const health = await checkPostgresHealth();
    if (health.status !== 'connected') {
      const err = new Error(
        'Cannot bootstrap initial setup: PostgreSQL database is currently unreachable.'
      );
      (err as { statusCode?: number }).statusCode = 503;
      throw err;
    }

    // Check if initial setup has already been completed to prevent hijacking
    const currentCompanyCount = await prisma.company.count();
    const currentAdminCount = await prisma.user.count({
      where: { role: 'SUPER_ADMIN' },
    });

    if (currentCompanyCount > 0 && currentAdminCount > 0) {
      const err = new Error(
        'Initial setup has already been completed. Further super administrators must be invited by an existing Super Admin.'
      );
      (err as { statusCode?: number }).statusCode = 409;
      throw err;
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(input.superAdmin.password, saltRounds);

    // Execute atomic transaction: Company + User + Base Currency + Audit Log
    const result = await prisma.$transaction(async (tx) => {
      // 0. Protect against concurrent bootstrap races inside the transaction
      const companyCountInTx = await tx.company.count();
      const adminCountInTx = await tx.user.count({ where: { role: 'SUPER_ADMIN' } });
      if (companyCountInTx > 0 && adminCountInTx > 0) {
        const err = new Error(
          'Initial setup has already been completed. Further super administrators must be invited by an existing Super Admin.'
        );
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      // Explicit duplicate checks
      const existingCompany = await tx.company.findUnique({
        where: { code: input.company.code },
      });
      if (existingCompany) {
        const err = new Error(`Company code '${input.company.code}' is already registered in the system.`);
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      const normalizedEmail = input.superAdmin.email.toLowerCase();
      const existingUser = await tx.user.findFirst({
        where: { email: normalizedEmail },
      });
      if (existingUser) {
        const err = new Error(`User with email '${normalizedEmail}' already exists.`);
        (err as { statusCode?: number }).statusCode = 409;
        throw err;
      }

      // 1. Create Company
      const company = await tx.company.create({
        data: {
          name: input.company.name,
          code: input.company.code,
          legalName: input.company.legalName || null,
          taxId: input.company.taxId || null,
          currency: input.company.currency,
          timezone: input.company.timezone,
          logoUrl: input.company.logoUrl || null,
          isConfigured: true,
        },
      });

      // 2. Create Base Currency with exact decimal rate
      await tx.currencyConfig.create({
        data: {
          companyId: company.id,
          currencyCode: input.company.currency,
          exchangeRate: '1.000000',
          roundingPrecision: 2,
          isBaseCurrency: true,
        },
      });

      // 3. Create Super Admin User
      const superAdmin = await tx.user.create({
        data: {
          companyId: company.id,
          email: input.superAdmin.email.toLowerCase(),
          fullName: input.superAdmin.fullName,
          passwordHash,
          role: 'SUPER_ADMIN',
          isActive: true,
          tokenVersion: 1,
        },
      });

      // 4. Record Audit Log for system bootstrap
      await tx.auditLog.create({
        data: {
          companyId: company.id,
          userId: superAdmin.id,
          action: 'SYSTEM_BOOTSTRAP',
          entity: 'Company',
          entityId: company.id,
          severity: 'INFO',
          correlationId: `bootstrap-${Date.now()}`,
          ipAddress: metadata?.ipAddress,
          userAgent: metadata?.userAgent,
          details: JSON.stringify({
            message: 'First company and Super Admin initialized successfully',
            companyCode: company.code,
            adminEmail: superAdmin.email,
          }),
        },
      });

      return { company, superAdmin };
    });

    return {
      success: true,
      message: 'Initial company and Super Admin created successfully.',
      company: {
        id: result.company.id,
        name: result.company.name,
        code: result.company.code,
        currency: result.company.currency,
      },
      superAdmin: {
        id: result.superAdmin.id,
        email: result.superAdmin.email,
        fullName: result.superAdmin.fullName,
        role: result.superAdmin.role,
      },
    };
  }
}
