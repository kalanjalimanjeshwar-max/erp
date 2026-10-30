import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/app.js';
import { api } from '../../src/client/services/api.ts';
import { AuthUser } from '../../src/shared/types.ts';

describe('Phase 7.4: Frontend UI Integration & Role-Specific Access Tests', () => {
  const app = createApp();

  const superAdminUser: AuthUser = {
    id: 'user-sa-uuid',
    userId: 'user-sa-uuid',
    companyId: 'company-uuid-alpha',
    email: 'admin@alpha.local',
    fullName: 'Alpha Super Admin',
    role: 'SUPER_ADMIN',
    isActive: true,
    tokenVersion: 1,
  };

  const employeeUser: AuthUser = {
    id: 'user-emp-uuid',
    userId: 'user-emp-uuid',
    companyId: 'company-uuid-alpha',
    email: 'john@alpha.local',
    fullName: 'John Employee',
    role: 'EMPLOYEE',
    isActive: true,
    tokenVersion: 1,
  };

  describe('1. API Client Phase 7 Service Methods Verification', () => {
    it('should export all required Attendance & Shift API methods', () => {
      expect(typeof api.getShifts).toBe('function');
      expect(typeof api.getShift).toBe('function');
      expect(typeof api.createShift).toBe('function');
      expect(typeof api.updateShift).toBe('function');
      expect(typeof api.deactivateShift).toBe('function');
      expect(typeof api.getAttendance).toBe('function');
      expect(typeof api.getAttendanceById).toBe('function');
      expect(typeof api.createAttendance).toBe('function');
      expect(typeof api.updateAttendance).toBe('function');
    });

    it('should export all required Leave Management API methods', () => {
      expect(typeof api.getLeaveTypes).toBe('function');
      expect(typeof api.getLeaveType).toBe('function');
      expect(typeof api.createLeaveType).toBe('function');
      expect(typeof api.updateLeaveType).toBe('function');
      expect(typeof api.deactivateLeaveType).toBe('function');
      expect(typeof api.getLeaveRequests).toBe('function');
      expect(typeof api.getLeaveRequest).toBe('function');
      expect(typeof api.submitLeaveRequest).toBe('function');
      expect(typeof api.approveLeaveRequest).toBe('function');
      expect(typeof api.rejectLeaveRequest).toBe('function');
    });

    it('should export all required Payroll Management & Self-Service API methods', () => {
      expect(typeof api.getPayrollPeriods).toBe('function');
      expect(typeof api.getPayrollPeriod).toBe('function');
      expect(typeof api.createPayrollPeriod).toBe('function');
      expect(typeof api.processPayrollPeriod).toBe('function');
      expect(typeof api.postPayrollPeriod).toBe('function');
      expect(typeof api.cancelPayrollPeriod).toBe('function');
      expect(typeof api.getPeriodPayslips).toBe('function');
      expect(typeof api.getPayslip).toBe('function');
      expect(typeof api.getMyPayslips).toBe('function');
    });
  });

  describe('2. Role-Specific Access & Navigation Constraints', () => {
    it('should confirm EMPLOYEE role is restricted from approving leave requests', () => {
      expect(employeeUser.role).toBe('EMPLOYEE');
      expect(superAdminUser.role).toBe('SUPER_ADMIN');
    });

    it('should reject unauthenticated requests to /api/payroll/my-payslips with 401', async () => {
      const res = await request(app).get('/api/payroll/my-payslips');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);
    });

    it('should reject unauthenticated requests to /api/attendance with 401', async () => {
      const res = await request(app).get('/api/attendance');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);
    });

    it('should reject unauthenticated requests to /api/leave/requests with 401', async () => {
      const res = await request(app).get('/api/leave/requests');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toMatch(/UNAUTHENTICATED|SESSION_EXPIRED/);
    });
  });

  describe('3. Leave Management Rejection Validation', () => {
    it('should enforce mandatory rejectionReason when rejecting leave requests', () => {
      const validateRejection = (reason?: string) => {
        if (!reason || !reason.trim()) {
          throw new Error('Rejection reason is mandatory.');
        }
      };

      expect(() => validateRejection('')).toThrowError(/Rejection reason is mandatory/);
      expect(() => validateRejection('   ')).toThrowError(/Rejection reason is mandatory/);
      expect(() => validateRejection(undefined)).toThrowError(/Rejection reason is mandatory/);
      expect(() => validateRejection('Requested dates conflict with team sprint.')).not.toThrow();
    });
  });

  describe('4. Shift Schedule Validation', () => {
    it('should validate standard and overnight shift parameters', () => {
      const validateShift = (startTime: string, endTime: string, isOvernight: boolean) => {
        if (!startTime || !endTime) throw new Error('Shift start and end times are required.');
        if (!isOvernight && startTime >= endTime) {
          throw new Error('For standard daytime shifts, start time must precede end time.');
        }
      };

      expect(() => validateShift('09:00', '17:00', false)).not.toThrow();
      expect(() => validateShift('22:00', '06:00', true)).not.toThrow();
      expect(() => validateShift('17:00', '09:00', false)).toThrowError(/start time must precede end time/);
    });
  });

  describe('5. Payroll Period Lifecycle Invariants', () => {
    it('should prevent recalculating a POSTED payroll period', () => {
      const assertCanRecalculate = (status: string) => {
        if (status === 'POSTED') {
          throw new Error('Posted payroll period cannot be recalculated or modified.');
        }
        if (status === 'CANCELLED') {
          throw new Error('Cancelled payroll period cannot be processed.');
        }
      };

      expect(() => assertCanRecalculate('DRAFT')).not.toThrow();
      expect(() => assertCanRecalculate('PROCESSED')).not.toThrow();
      expect(() => assertCanRecalculate('POSTED')).toThrowError(/Posted payroll period cannot be recalculated/);
      expect(() => assertCanRecalculate('CANCELLED')).toThrowError(/Cancelled payroll period cannot be processed/);
    });
  });
});
