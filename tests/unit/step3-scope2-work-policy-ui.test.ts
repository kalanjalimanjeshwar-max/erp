import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { api } from '../../src/client/services/api.ts';
import {
  STANDARD_MONTHLY_LEAVE_ALLOWANCE_OPTIONS,
  normalizePermittedMonthlyLeaveAllowances,
  validatePermittedMonthlyLeaveAllowancesSelection,
  PermittedMonthlyLeaveAllowancesCard,
} from '../../src/client/pages/CompanyAdminPage.tsx';
import {
  resolvePermittedLeaveAllowanceOptions,
  sortWorkPolicyRevisionsChronologically,
  resolveExplicitDailyWorkingHoursInput,
  getInitialWorkPolicyRevisionFormValues,
  buildEmployeePolicyFieldsForCreate,
  buildEmployeePolicyFieldsForUpdate,
  buildWorkPolicyRevisionPayload,
  WorkPolicyHistoryPanel,
} from '../../src/client/pages/EmployeesPage.tsx';
import {
  CompanyProfile,
  EmployeeItem,
  EmployeeWorkPolicyRevisionItem,
  ShiftItem,
} from '../../src/shared/types.ts';

describe('Step 3 Scope 2: CompanyAdminPage & EmployeesPage Work-Policy Frontend UI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const sampleEmployee: EmployeeItem = {
    id: 'emp-1',
    companyId: 'comp-1',
    employeeCode: 'EMP-001',
    fullName: 'Alice Worker',
    email: 'alice@company.local',
    phone: null,
    address: null,
    photoUrl: null,
    dateOfBirth: '1992-05-10',
    dateOfJoining: '2026-01-01',
    departmentId: null,
    designationId: null,
    employmentType: 'FULL_TIME',
    status: 'ACTIVE',
    notes: null,
    biometricDeviceId: null,
    userId: 'user-emp-1',
    ledgerId: null,
    shiftId: null,
    shiftName: null,
    dailyWorkingHours: 8,
    monthlyLeaveAllowance: 4,
    effectiveWorkPolicy: {
      dailyWorkingHours: 8,
      monthlyLeaveAllowance: 4,
      shiftId: null,
      effectiveFrom: '2026-11-01',
      effectiveTo: null,
      source: 'REVISION',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };

  const sampleShifts: ShiftItem[] = [
    {
      id: 'shift-day',
      companyId: 'comp-1',
      code: 'DAY',
      name: 'Day Shift',
      startTime: '09:00',
      endTime: '17:00',
      graceMinutes: 15,
      halfDayMinutes: 240,
      isOvernight: false,
      isActive: true,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  const sampleRevisions: EmployeeWorkPolicyRevisionItem[] = [
    {
      id: 'rev-2',
      companyId: 'comp-1',
      employeeId: 'emp-1',
      shiftId: null,
      shiftName: null,
      dailyWorkingHours: 8.5,
      monthlyLeaveAllowance: 5,
      effectiveDailyWorkingHours: 8.5,
      effectiveMonthlyLeaveAllowance: 5,
      effectiveFrom: '2026-12-01',
      effectiveTo: null,
      revisionReason: 'Year-end schedule & allowance update',
      notes: 'Approved by HR',
      createdByUserId: 'admin-1',
      createdByUserName: 'HR Admin',
      createdAt: '2026-11-15T10:00:00.000Z',
      updatedAt: '2026-11-15T10:00:00.000Z',
    },
    {
      id: 'rev-1',
      companyId: 'comp-1',
      employeeId: 'emp-1',
      shiftId: 'shift-day',
      shiftName: 'Day Shift',
      shiftStartTime: '09:00',
      shiftEndTime: '17:00',
      shiftIsOvernight: false,
      dailyWorkingHours: 8,
      monthlyLeaveAllowance: 4,
      effectiveDailyWorkingHours: 8,
      effectiveMonthlyLeaveAllowance: 4,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-11-30',
      revisionReason: 'Initial onboarding policy',
      notes: null,
      createdByUserId: 'admin-1',
      createdByUserName: 'HR Admin',
      createdAt: '2026-01-01T09:00:00.000Z',
      updatedAt: '2026-01-01T09:00:00.000Z',
    },
  ];

  describe('1. Company Allowance Options (Loading, [4, 5, 6] Default, Saving, ADMIN Maker-Checker)', () => {
    it('defaults to [4, 5, 6] when company profile has no configured allowances', () => {
      expect([...STANDARD_MONTHLY_LEAVE_ALLOWANCE_OPTIONS]).toEqual([4, 5, 6]);
      expect(normalizePermittedMonthlyLeaveAllowances(undefined)).toEqual([4, 5, 6]);
      expect(normalizePermittedMonthlyLeaveAllowances(null)).toEqual([4, 5, 6]);
      expect(normalizePermittedMonthlyLeaveAllowances([])).toEqual([4, 5, 6]);
      expect(normalizePermittedMonthlyLeaveAllowances([6, 4])).toEqual([4, 6]);
    });

    it('rejects empty or out-of-range allowance selections before API submission', () => {
      expect(validatePermittedMonthlyLeaveAllowancesSelection([])).toMatch(
        /Select at least one permitted monthly leave allowance/i
      );
      expect(validatePermittedMonthlyLeaveAllowancesSelection([4, 7])).toMatch(
        /only include 4, 5, or 6 days/i
      );
      expect(validatePermittedMonthlyLeaveAllowancesSelection([4, 6])).toBeNull();
    });

    it('renders 4, 5, and 6 day allowance options with ADMIN maker-checker vs SUPER_ADMIN notice', () => {
      const superAdminHtml = renderToStaticMarkup(
        React.createElement(PermittedMonthlyLeaveAllowancesCard, {
          selectedAllowances: [4, 5, 6],
          isSuperAdmin: true,
          onToggle: () => {},
        })
      );
      expect(superAdminHtml).toContain('4 Days / Month');
      expect(superAdminHtml).toContain('5 Days / Month');
      expect(superAdminHtml).toContain('6 Days / Month');
      expect(superAdminHtml).toContain('Super Admin changes apply immediately');

      const adminHtml = renderToStaticMarkup(
        React.createElement(PermittedMonthlyLeaveAllowancesCard, {
          selectedAllowances: [4, 6],
          isSuperAdmin: false,
          onToggle: () => {},
        })
      );
      expect(adminHtml).toContain('Admin changes require Super Admin approval');
      expect(adminHtml).toContain('Disabled for this company');
    });

    it('loads and saves permittedMonthlyLeaveAllowances via existing company profile API without bypassing maker-checker', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'comp-1',
          code: 'ALPHA',
          name: 'Alpha Corp',
          currency: 'USD',
          timezone: 'UTC',
          permittedMonthlyLeaveAllowances: [4, 5],
          pendingApproval: true,
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const saved = await api.updateCompanyProfile({
        name: 'Alpha Corp',
        currency: 'USD',
        timezone: 'UTC',
        permittedMonthlyLeaveAllowances: [4, 5],
      });

      expect(saved.pendingApproval).toBe(true);
      expect(saved.permittedMonthlyLeaveAllowances).toEqual([4, 5]);
      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body)).toMatchObject({
        permittedMonthlyLeaveAllowances: [4, 5],
      });
    });
  });

  describe('2. Employee Create/Edit dailyWorkingHours & Optional shiftId Behavior', () => {
    it('allows creating an employee with explicit dailyWorkingHours and no shift assigned', () => {
      const res = buildEmployeePolicyFieldsForCreate({
        shiftId: '',
        dailyWorkingHours: '8.5',
        monthlyLeaveAllowance: '5',
        policyEffectiveFrom: '2026-11-10',
        dateOfJoining: '2026-11-01',
        permittedAllowances: [4, 5, 6],
      });

      expect(res.error).toBeUndefined();
      expect(res.fields).toEqual({
        shiftId: null,
        dailyWorkingHours: 8.5,
        monthlyLeaveAllowance: 5,
        policyEffectiveFrom: '2026-11-10',
      });
    });

    it('rejects invalid dailyWorkingHours outside (0, 24] or effectiveFrom prior to joining date', () => {
      const zeroHours = buildEmployeePolicyFieldsForCreate({
        shiftId: '',
        dailyWorkingHours: '0',
        monthlyLeaveAllowance: '4',
        policyEffectiveFrom: '',
        dateOfJoining: '2026-11-01',
        permittedAllowances: [4, 5, 6],
      });
      expect(zeroHours.error).toMatch(/greater than 0 and at most 24/i);

      const over24Hours = buildEmployeePolicyFieldsForCreate({
        shiftId: '',
        dailyWorkingHours: '25',
        monthlyLeaveAllowance: '4',
        policyEffectiveFrom: '',
        dateOfJoining: '2026-11-01',
        permittedAllowances: [4, 5, 6],
      });
      expect(over24Hours.error).toMatch(/greater than 0 and at most 24/i);

      const beforeDoj = buildEmployeePolicyFieldsForCreate({
        shiftId: '',
        dailyWorkingHours: '8',
        monthlyLeaveAllowance: '4',
        policyEffectiveFrom: '2026-10-31',
        dateOfJoining: '2026-11-01',
        permittedAllowances: [4, 5, 6],
      });
      expect(beforeDoj.error).toMatch(/cannot be earlier than employee date of joining/i);
    });

    it('omits unchanged policy fields and blank policyEffectiveFrom on employee update while tracking shift removal cleanly', () => {
      const noChange = buildEmployeePolicyFieldsForUpdate({
        employee: sampleEmployee,
        shiftId: '',
        dailyWorkingHours: '8',
        monthlyLeaveAllowance: '4',
        policyEffectiveFrom: '',
        policyRevisionReason: '',
        policyRevisionNotes: '',
        permittedAllowances: [4, 5, 6],
      });
      expect(noChange.error).toBeUndefined();
      expect(noChange.fields).toEqual({});

      const withHoursAndDate = buildEmployeePolicyFieldsForUpdate({
        employee: { ...sampleEmployee, shiftId: 'shift-day' },
        shiftId: '',
        dailyWorkingHours: '7.5',
        monthlyLeaveAllowance: '4',
        policyEffectiveFrom: '2026-11-18',
        policyRevisionReason: 'Flexible hours',
        policyRevisionNotes: 'Shift removed',
        permittedAllowances: [4, 5, 6],
      });
      expect(withHoursAndDate.error).toBeUndefined();
      expect(withHoursAndDate.fields).toEqual({
        shiftId: null,
        dailyWorkingHours: 7.5,
        policyEffectiveFrom: '2026-11-18',
        policyRevisionReason: 'Flexible hours',
        policyRevisionNotes: 'Shift removed',
      });
    });
  });

  describe('3 & 4. Company-Permitted Monthly Leave Allowances & Next-Month Effective-Date Explanation', () => {
    it('restricts monthly leave allowance options to company-permitted values and defaults to [4, 5, 6]', () => {
      const unconfigured: CompanyProfile = {
        id: 'comp-1',
        code: 'ALPHA',
        name: 'Alpha Corp',
        currency: 'USD',
        timezone: 'UTC',
      };
      expect(resolvePermittedLeaveAllowanceOptions(unconfigured)).toEqual([4, 5, 6]);

      const restricted: CompanyProfile = {
        ...unconfigured,
        permittedMonthlyLeaveAllowances: [4, 6],
      };
      expect(resolvePermittedLeaveAllowanceOptions(restricted)).toEqual([4, 6]);

      const disallowedCreate = buildEmployeePolicyFieldsForCreate({
        shiftId: '',
        dailyWorkingHours: '8',
        monthlyLeaveAllowance: '5',
        policyEffectiveFrom: '',
        dateOfJoining: '2026-11-01',
        permittedAllowances: [4, 6],
      });
      expect(disallowedCreate.error).toMatch(/4, 6 days/i);

      // Allows preserving an unchanged legacy allowance (e.g. 5) when editing unrelated employee details
      const legacyEmp: EmployeeItem = {
        ...sampleEmployee,
        monthlyLeaveAllowance: 5,
        effectiveWorkPolicy: {
          dailyWorkingHours: 8,
          monthlyLeaveAllowance: 5,
          shiftId: null,
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
          source: 'REVISION',
        },
      };
      const keepLegacy = buildEmployeePolicyFieldsForUpdate({
        employee: legacyEmp,
        shiftId: '',
        dailyWorkingHours: '8',
        monthlyLeaveAllowance: '5',
        policyEffectiveFrom: '',
        policyRevisionReason: '',
        policyRevisionNotes: '',
        permittedAllowances: [4, 6],
      });
      expect(keepLegacy.error).toBeUndefined();
      expect(keepLegacy.fields.monthlyLeaveAllowance).toBeUndefined();
    });

    it('renders only permitted allowance options and displays the next-month calendar rule explanation', () => {
      const html = renderToStaticMarkup(
        React.createElement(WorkPolicyHistoryPanel, {
          employee: sampleEmployee,
          revisions: sampleRevisions,
          isLoading: false,
          errorMessage: null,
          canEdit: true,
          shifts: sampleShifts,
          permittedAllowances: [4, 6],
          shiftId: '',
          dailyWorkingHours: '8',
          monthlyLeaveAllowance: '',
          effectiveFrom: '2026-11-15',
          onSubmitRevision: () => {},
        })
      );

      expect(html).toContain('No Shift Assigned');
      expect(html).toContain('4 days / month');
      expect(html).toContain('6 days / month');
      expect(html).not.toContain('value="5">5 days / month');
      expect(html).toContain(
        '1st day of the next company-local calendar month regardless of the submission date'
      );
    });
  });

  describe('5. Work Policy History Loading & Chronological Display', () => {
    it('fetches employee work policies from GET /api/employees/:id/work-policies', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleRevisions,
      });
      vi.stubGlobal('fetch', fetchMock);

      const list = await api.getEmployeeWorkPolicies('emp-1');
      expect(list).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/employees/emp-1/work-policies',
        expect.any(Object)
      );
    });

    it('sorts revisions chronologically and renders earliest effectiveFrom before later revisions', () => {
      const ordered = sortWorkPolicyRevisionsChronologically(sampleRevisions);
      expect(ordered.map((r) => r.id)).toEqual(['rev-1', 'rev-2']);

      const html = renderToStaticMarkup(
        React.createElement(WorkPolicyHistoryPanel, {
          employee: sampleEmployee,
          revisions: sampleRevisions,
          isLoading: false,
          errorMessage: null,
          canEdit: true,
          shifts: sampleShifts,
          permittedAllowances: [4, 5, 6],
          onSubmitRevision: () => {},
        })
      );

      const idxRev1 = html.indexOf('2026-01-01');
      const idxRev2 = html.indexOf('2026-12-01');
      expect(idxRev1).toBeGreaterThan(-1);
      expect(idxRev2).toBeGreaterThan(idxRev1);
      expect(html).toContain('Current / Ongoing');
      expect(html).toContain('Day Shift (09:00–17:00)');
    });
  });

  describe('6. Revision Submission & Returned Effective-Date Display', () => {
    it('validates revision payload and submits POST /api/employees/:id/work-policies', async () => {
      const built = buildWorkPolicyRevisionPayload({
        shiftId: '',
        dailyWorkingHours: '9',
        monthlyLeaveAllowance: '6',
        effectiveFrom: '2026-11-15',
        revisionReason: 'Schedule & leave revision',
        notes: 'Mid-month change',
        permittedAllowances: [4, 5, 6],
      });
      expect(built.error).toBeUndefined();
      expect(built.payload).toEqual({
        shiftId: null,
        dailyWorkingHours: 9,
        monthlyLeaveAllowance: 6,
        effectiveFrom: '2026-11-15',
        revisionReason: 'Schedule & leave revision',
        notes: 'Mid-month change',
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          employee: sampleEmployee,
          revisions: sampleRevisions,
          workPolicyEffectiveFrom: '2026-11-15',
          allowanceEffectiveFrom: '2026-12-01',
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const response = await api.createEmployeeWorkPolicyRevision('emp-1', built.payload!);
      expect(response.workPolicyEffectiveFrom).toBe('2026-11-15');
      expect(response.allowanceEffectiveFrom).toBe('2026-12-01');
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/employees/emp-1/work-policies',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('renders returned workPolicyEffectiveFrom and allowanceEffectiveFrom after revision submission', () => {
      const html = renderToStaticMarkup(
        React.createElement(WorkPolicyHistoryPanel, {
          employee: sampleEmployee,
          revisions: sampleRevisions,
          isLoading: false,
          errorMessage: null,
          canEdit: true,
          shifts: sampleShifts,
          permittedAllowances: [4, 5, 6],
          revisionSuccess: {
            message: 'Work policy revision saved successfully.',
            workPolicyEffectiveFrom: '2026-11-15',
            allowanceEffectiveFrom: '2026-12-01',
          },
          onSubmitRevision: () => {},
        })
      );

      expect(html).toContain('Work policy revision saved successfully.');
      expect(html).toContain('Work Hours / Shift Effective From: 2026-11-15');
      expect(html).toContain('Monthly Allowance Effective From: 2026-12-01');
    });
  });

  describe('7. EMPLOYEE Self-Service Read-Only Behavior', () => {
    it('renders current policy and chronological revision history without exposing revision creation controls', () => {
      const html = renderToStaticMarkup(
        React.createElement(WorkPolicyHistoryPanel, {
          employee: sampleEmployee,
          revisions: sampleRevisions,
          isLoading: false,
          errorMessage: null,
          canEdit: false,
        })
      );

      expect(html).toContain('My Work Policy Revision History');
      expect(html).toContain('8 hrs / day');
      expect(html).toContain('4 days / month');
      expect(html).toContain('2026-01-01');
      expect(html).toContain('2026-12-01');
      expect(html).not.toContain('Create Work Policy Revision');
      expect(html).not.toContain('Save Work Policy Revision');
      expect(html).not.toContain('<form');
    });
  });

  describe('8. P2-4: Shift-Derived Hours vs Explicit dailyWorkingHours Override', () => {
    const shiftBasedEmployee: EmployeeItem = {
      ...sampleEmployee,
      id: 'emp-shift-1',
      shiftId: 'shift-8h',
      shiftName: 'Standard 8h Shift',
      shiftStartTime: '09:00',
      shiftEndTime: '17:00',
      shiftIsOvernight: false,
      dailyWorkingHours: null,
      configuredDailyWorkingHours: 8,
      effectiveWorkPolicy: {
        dailyWorkingHours: 8,
        monthlyLeaveAllowance: 4,
        shiftId: 'shift-8h',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        source: 'REVISION',
      },
    };

    const shift10h: ShiftItem = {
      ...sampleShifts[0],
      id: 'shift-10h',
      code: 'LONG10',
      name: 'Extended 10h Shift',
      startTime: '08:00',
      endTime: '18:00',
    };

    it('opens the revision form with a blank Daily Working Hours input when employee.dailyWorkingHours is null or undefined', () => {
      const fromNull = getInitialWorkPolicyRevisionFormValues(shiftBasedEmployee, '2026-11-20');
      expect(fromNull.shiftId).toBe('shift-8h');
      expect(fromNull.dailyWorkingHours).toBe('');
      expect(fromNull.effectiveFrom).toBe('2026-11-20');
      expect(resolveExplicitDailyWorkingHoursInput(shiftBasedEmployee)).toBe('');

      const employeeWithUndefinedHours: EmployeeItem = {
        ...shiftBasedEmployee,
        dailyWorkingHours: undefined,
        configuredDailyWorkingHours: 8,
      };
      const fromUndefined = getInitialWorkPolicyRevisionFormValues(
        employeeWithUndefinedHours,
        '2026-11-20'
      );
      expect(fromUndefined.dailyWorkingHours).toBe('');
      expect(resolveExplicitDailyWorkingHoursInput(employeeWithUndefinedHours)).toBe('');

      const html = renderToStaticMarkup(
        React.createElement(WorkPolicyHistoryPanel, {
          employee: shiftBasedEmployee,
          revisions: sampleRevisions,
          isLoading: false,
          errorMessage: null,
          canEdit: true,
          shifts: [...sampleShifts, shift10h],
          permittedAllowances: [4, 5, 6],
          shiftId: fromNull.shiftId,
          dailyWorkingHours: fromNull.dailyWorkingHours,
          monthlyLeaveAllowance: fromNull.monthlyLeaveAllowance,
          effectiveFrom: fromNull.effectiveFrom,
          onSubmitRevision: () => {},
        })
      );

      expect(html).toContain('Derived from assigned shift');
      expect(html).toMatch(/aria-label="Revision Daily Working Hours"[^>]*value=""/);
      expect(html).not.toMatch(/aria-label="Revision Daily Working Hours"[^>]*value="8"/);
    });

    it('changes the shift without entering hours and omits dailyWorkingHours instead of submitting configuredDailyWorkingHours as an override', () => {
      const initial = getInitialWorkPolicyRevisionFormValues(shiftBasedEmployee, '2026-11-20');
      expect(initial.dailyWorkingHours).toBe('');

      // Admin changes shift from shift-8h (8h) to shift-10h (10h) and leaves Daily Working Hours blank
      const built = buildWorkPolicyRevisionPayload({
        shiftId: 'shift-10h',
        dailyWorkingHours: initial.dailyWorkingHours,
        monthlyLeaveAllowance: '',
        effectiveFrom: '2026-11-20',
        revisionReason: 'Moved to 10-hour shift',
        notes: '',
        permittedAllowances: [4, 5, 6],
        initialDailyWorkingHours: shiftBasedEmployee.dailyWorkingHours,
      });

      expect(built.error).toBeUndefined();
      expect(built.payload).toBeDefined();
      expect(built.payload?.shiftId).toBe('shift-10h');
      expect('dailyWorkingHours' in (built.payload || {})).toBe(false);
      expect(built.payload?.dailyWorkingHours).toBeUndefined();
    });

    it('retains explicit dailyWorkingHours when the employee actually has an explicit value', () => {
      const explicitEmployee: EmployeeItem = {
        ...sampleEmployee,
        shiftId: 'shift-8h',
        dailyWorkingHours: 7.5,
        configuredDailyWorkingHours: 7.5,
        effectiveWorkPolicy: {
          dailyWorkingHours: 7.5,
          monthlyLeaveAllowance: 4,
          shiftId: 'shift-8h',
          effectiveFrom: '2026-11-01',
          effectiveTo: null,
          source: 'REVISION',
        },
      };

      const initial = getInitialWorkPolicyRevisionFormValues(explicitEmployee, '2026-11-20');
      expect(initial.shiftId).toBe('shift-8h');
      expect(initial.dailyWorkingHours).toBe('7.5');
      expect(resolveExplicitDailyWorkingHoursInput(explicitEmployee)).toBe('7.5');

      // Clearing a previously explicit dailyWorkingHours value explicitly sends null per API contract
      const cleared = buildWorkPolicyRevisionPayload({
        shiftId: 'shift-10h',
        dailyWorkingHours: '',
        monthlyLeaveAllowance: '',
        effectiveFrom: '2026-11-20',
        revisionReason: 'Revert to shift-derived hours',
        notes: '',
        permittedAllowances: [4, 5, 6],
        initialDailyWorkingHours: explicitEmployee.dailyWorkingHours,
      });
      expect(cleared.error).toBeUndefined();
      expect(cleared.payload?.dailyWorkingHours).toBeNull();
    });

    it('submits explicitly entered dailyWorkingHours correctly for a shift-based employee', () => {
      const built = buildWorkPolicyRevisionPayload({
        shiftId: 'shift-10h',
        dailyWorkingHours: '9.5',
        monthlyLeaveAllowance: '',
        effectiveFrom: '2026-11-20',
        revisionReason: 'Custom explicit daily hours',
        notes: '',
        permittedAllowances: [4, 5, 6],
        initialDailyWorkingHours: shiftBasedEmployee.dailyWorkingHours,
      });

      expect(built.error).toBeUndefined();
      expect(built.payload).toEqual({
        shiftId: 'shift-10h',
        dailyWorkingHours: 9.5,
        effectiveFrom: '2026-11-20',
        revisionReason: 'Custom explicit daily hours',
        notes: null,
      });
    });

    it('keeps employee editing and optional-shift behavior compatible without turning shift-derived hours into an override', () => {
      // Shift-based employee edited in Edit Employee modal: shift changed to shift-10h while hours stays blank
      const editShiftOnly = buildEmployeePolicyFieldsForUpdate({
        employee: shiftBasedEmployee,
        shiftId: 'shift-10h',
        dailyWorkingHours: resolveExplicitDailyWorkingHoursInput(shiftBasedEmployee),
        monthlyLeaveAllowance: '4',
        policyEffectiveFrom: '2026-11-20',
        policyRevisionReason: 'Shift transfer',
        policyRevisionNotes: '',
        permittedAllowances: [4, 5, 6],
      });

      expect(editShiftOnly.error).toBeUndefined();
      expect(editShiftOnly.fields).toEqual({
        shiftId: 'shift-10h',
        policyEffectiveFrom: '2026-11-20',
        policyRevisionReason: 'Shift transfer',
      });
      expect('dailyWorkingHours' in editShiftOnly.fields).toBe(false);

      // Optional-shift employee with explicit dailyWorkingHours continues to work unchanged
      const optionalShiftExplicit = buildEmployeePolicyFieldsForUpdate({
        employee: sampleEmployee,
        shiftId: '',
        dailyWorkingHours: '8.5',
        monthlyLeaveAllowance: '4',
        policyEffectiveFrom: '2026-11-20',
        policyRevisionReason: 'Explicit hours update',
        policyRevisionNotes: '',
        permittedAllowances: [4, 5, 6],
      });

      expect(optionalShiftExplicit.error).toBeUndefined();
      expect(optionalShiftExplicit.fields).toEqual({
        dailyWorkingHours: 8.5,
        policyEffectiveFrom: '2026-11-20',
        policyRevisionReason: 'Explicit hours update',
      });
    });
  });
});
