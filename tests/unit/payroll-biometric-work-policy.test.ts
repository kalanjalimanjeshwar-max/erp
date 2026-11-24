import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../../src/server/db/client.js';
import { PayrollService } from '../../src/server/services/payroll.service.js';
import { BiometricService } from '../../src/server/services/biometric.service.js';
import { PunchReconciliationService } from '../../src/server/services/punch-reconciliation.service.js';
import { CompanyService } from '../../src/server/services/company.service.js';
import { AuthUser } from '../../src/shared/types.js';

vi.mock('../../src/server/services/audit.service.js', () => ({
  AuditService: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Step 2 Stage 5: PayrollService & BiometricService Integration Tests', () => {
  const companyId = 'comp-stage5-1';
  const periodId = 'pp-stage5-nov';
  const empId = 'emp-stage5-1';

  const adminActor: AuthUser = {
    id: 'user-admin-s5',
    userId: 'user-admin-s5',
    companyId,
    email: 'admin@stage5.local',
    fullName: 'Stage 5 Admin',
    role: 'ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(CompanyService, 'getBaseCurrency').mockResolvedValue('USD');
  });

  it('computes payslip with employee allowance, mid-month hours change short-time deduction, non-offsetting extra time, and overtimePay = 0', async () => {
    const createdPayslips: any[] = [];

    const draftPeriod = {
      id: periodId,
      companyId,
      month: 11,
      year: 2026,
      name: '2026-11 Payroll',
      startDate: new Date('2026-11-01T00:00:00.000Z'),
      endDate: new Date('2026-11-30T23:59:59.999Z'),
      status: 'DRAFT',
      processedAt: null,
      postedAt: null,
      createdByUserId: adminActor.id,
      createdByUser: { fullName: adminActor.fullName },
      payslips: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const empRow = {
      id: empId,
      companyId,
      employeeCode: 'EMP-S5',
      fullName: 'Nadia Payroll',
      dateOfJoining: new Date('2025-01-01T00:00:00.000Z'),
      status: 'ACTIVE',
      shiftId: null,
      shift: null,
      dailyWorkingHours: 6,
      monthlyLeaveAllowance: 2,
      ledgerId: null,
      ledger: null,
    };

    vi.spyOn(prisma.payrollPeriod, 'findUnique').mockImplementation((async () => ({
      ...draftPeriod,
      status: 'PROCESSED',
      payslips: createdPayslips.map((ps) => ({
        ...ps,
        employee: { employeeCode: empRow.employeeCode, fullName: empRow.fullName },
        ledger: null,
      })),
    })) as any);
    // First call in processPeriod reads DRAFT
    vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValueOnce(draftPeriod as any);

    vi.spyOn(prisma.employee, 'findMany').mockResolvedValue([empRow] as any);
    vi.spyOn(prisma, '$transaction').mockImplementation(async (cb: any) => cb(prisma));
    vi.spyOn(prisma as any, '$queryRaw').mockResolvedValue([{ id: periodId }] as any);
    vi.spyOn(prisma.payrollPeriod, 'findUnique').mockResolvedValueOnce(draftPeriod as any);
    vi.spyOn(prisma.payslip, 'deleteMany').mockResolvedValue({ count: 0 } as any);
    vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);

    // Constant monthly salary $3,000 ($100/day)
    vi.spyOn(prisma.salaryRevision, 'findMany').mockResolvedValue([
      {
        id: 'sal-1',
        fixedSalary: '3000.00',
        effectiveFrom: new Date('2025-01-01T00:00:00Z'),
        effectiveTo: null,
      },
    ] as any);

    // LeaveService reads employee with salaryRevisions & work-policy revisions:
    // Days 1..15: 8h/day ($12.50/hr); Days 16..30: 6h/day ($16.6667/hr); Nov allowance: 2 days
    vi.spyOn(prisma.employee, 'findUnique').mockResolvedValue({
      ...empRow,
      salaryRevisions: [
        {
          fixedSalary: '3000.00',
          effectiveFrom: new Date('2025-01-01T00:00:00Z'),
          effectiveTo: null,
        },
      ],
    } as any);

    vi.spyOn((prisma as any).employeeWorkPolicyRevision, 'findMany').mockResolvedValue([
      {
        id: 'wpr-1',
        companyId,
        employeeId: empId,
        shiftId: null,
        shift: null,
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 2,
        effectiveFrom: new Date('2025-01-01T00:00:00Z'),
        effectiveTo: new Date('2026-11-15T00:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'wpr-2',
        companyId,
        employeeId: empId,
        shiftId: null,
        shift: null,
        dailyWorkingHours: 6,
        monthlyLeaveAllowance: 2,
        effectiveFrom: new Date('2026-11-16T00:00:00Z'),
        effectiveTo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.spyOn(prisma.leaveType, 'findMany').mockResolvedValue([
      { id: 'lt-1', code: 'AL', name: 'Annual', isPaid: true, defaultAllowance: 15, isActive: true },
    ] as any);
    // 3 approved days against 2-day allowance -> 1 excess day = $100.00 deduction
    vi.spyOn(prisma.leaveRequest, 'findMany').mockResolvedValue([
      {
        id: 'lr-nov-1',
        companyId,
        employeeId: empId,
        leaveTypeId: 'lt-1',
        startDate: new Date('2026-11-02T00:00:00Z'),
        endDate: new Date('2026-11-04T00:00:00Z'),
        totalDays: 3,
        status: 'APPROVED',
      },
    ] as any);

    vi.spyOn(prisma.attendance, 'findMany').mockResolvedValue([
      // Nov 5: 10h worked vs 8h -> 2h EXTRA TIME (must NEVER offset Nov 10 or add overtimePay!)
      {
        id: 'att-5',
        workDate: new Date('2026-11-05T00:00:00Z'),
        actualWorkedMinutes: 600,
        hasIncompletePunch: false,
        punchPairsCount: 2,
        status: 'PRESENT',
        shift: null,
      },
      // Nov 10: 6h worked vs 8h -> 2h SHORT TIME @ $12.50/hr = $25.00
      {
        id: 'att-10',
        workDate: new Date('2026-11-10T00:00:00Z'),
        actualWorkedMinutes: 360,
        hasIncompletePunch: false,
        punchPairsCount: 1,
        status: 'PRESENT',
        shift: null,
      },
      // Nov 20: 3h worked vs 6h -> 3h SHORT TIME @ $16.6667/hr = $50.00
      {
        id: 'att-20',
        workDate: new Date('2026-11-20T00:00:00Z'),
        actualWorkedMinutes: 180,
        hasIncompletePunch: false,
        punchPairsCount: 1,
        status: 'PRESENT',
        shift: null,
      },
    ] as any);

    vi.spyOn(prisma.payslip, 'create').mockImplementation((async (args: any) => {
      createdPayslips.push(args.data);
      return args.data;
    }) as any);
    vi.spyOn(prisma.payrollPeriod, 'update').mockResolvedValue({ ...draftPeriod, status: 'PROCESSED' } as any);

    // Note: getPeriodById also reads payrollPeriod.findUnique at the end
    await PayrollService.processPeriod(adminActor, periodId);

    expect(createdPayslips).toHaveLength(1);
    const ps = createdPayslips[0];
    expect(ps.basicSalary.toString()).toBe('3000');
    expect(ps.overtimePay.toString()).toBe('0'); // Extra Time NEVER added to salary
    // Excess leave $100.00 + Short Hours ($25.00 + $50.00 = $75.00) = $175.00
    expect(ps.lossOfPayDeduction.toString()).toBe('175');
    expect(ps.netSalary.toString()).toBe('2825');
    expect(ps.notes).toContain('Allowance 2d');
    expect(ps.notes).toContain('5h short, 2h extra informational only');
  });

  it('BiometricService.triggerTerminalSync forwards optional fromPunchTime (clamped to current-day cutoff) to PunchReconciliationService.reconcilePendingPunches', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-19T12:00:00.000Z'));
      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue({
        id: 'term-1',
        companyId,
        deviceSerialNumber: 'SN-100',
        name: 'Gate 1',
        terminalModel: 'eSSL',
        ipAddress: '192.168.1.50',
        port: 4370,
        isActive: true,
        status: 'ONLINE',
        lastSyncAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        registeredByUser: { fullName: adminActor.fullName },
      } as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({ timezone: 'UTC' } as any);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.companySetting, 'upsert').mockResolvedValue({} as any);
      vi.spyOn(BiometricService as any, 'upsertTerminalTelemetry').mockResolvedValue({});

      const reconcileSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePendingPunches')
        .mockResolvedValue({
          success: true,
          totalEvaluated: 0,
          processed: 0,
          pending: 0,
          ignored: 0,
          errors: 0,
          results: [],
        });

      const cutoff = '2026-11-19T06:00:00.000Z';
      await BiometricService.triggerTerminalSync(adminActor, 'term-1', {
        batchSize: 50,
        fromPunchTime: cutoff,
      });

      expect(reconcileSpy).toHaveBeenCalledWith(
        companyId,
        expect.objectContaining({
          terminalId: 'term-1',
          batchSize: 50,
          fromPunchTime: new Date(cutoff),
        }),
        adminActor,
        undefined
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('BiometricService.triggerTerminalSync(actor, terminalId) without fromPunchTime applies company-local start-of-day cutoff to protect historical PENDING punches', async () => {
    vi.useFakeTimers();
    try {
      // 2026-11-20T01:00:00Z -> Asia/Kolkata local day start is 2026-11-19T18:30:00.000Z
      vi.setSystemTime(new Date('2026-11-20T01:00:00.000Z'));

      vi.spyOn(prisma.biometricTerminal, 'findFirst').mockResolvedValue({
        id: 'term-1',
        companyId,
        deviceSerialNumber: 'SN-100',
        name: 'Gate 1',
        terminalModel: 'eSSL',
        ipAddress: '192.168.1.50',
        port: 4370,
        isActive: true,
        status: 'ONLINE',
        lastSyncAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        registeredByUser: { fullName: adminActor.fullName },
      } as any);
      vi.spyOn(prisma.company, 'findUnique').mockResolvedValue({
        timezone: 'Asia/Kolkata',
      } as any);
      vi.spyOn(prisma.companySetting, 'findUnique').mockResolvedValue(null);
      vi.spyOn(prisma.companySetting, 'upsert').mockResolvedValue({} as any);
      vi.spyOn(BiometricService as any, 'upsertTerminalTelemetry').mockResolvedValue({});

      const reconcileSpy = vi
        .spyOn(PunchReconciliationService, 'reconcilePendingPunches')
        .mockResolvedValue({
          success: true,
          totalEvaluated: 0,
          processed: 0,
          pending: 0,
          ignored: 0,
          errors: 0,
          results: [],
        });

      await BiometricService.triggerTerminalSync(adminActor, 'term-1');

      expect(reconcileSpy).toHaveBeenCalledWith(
        companyId,
        expect.objectContaining({
          terminalId: 'term-1',
          fromPunchTime: new Date('2026-11-19T18:30:00.000Z'),
        }),
        adminActor,
        undefined
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
