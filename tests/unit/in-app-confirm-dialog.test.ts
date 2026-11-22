import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ConfirmDialog,
  executeConfirmedAction,
} from '../../src/client/components/common/ConfirmDialog.tsx';
import { validateSalaryAdvanceAmount } from '../../src/client/pages/EmployeeSelfServicePage.tsx';

describe('P2-9: In-App Confirmation Dialog & Inline Feedback Replacements', () => {
  describe('ConfirmDialog rendering & accessibility', () => {
    it('renders nothing when closed', () => {
      const html = renderToStaticMarkup(
        React.createElement(ConfirmDialog, {
          isOpen: false,
          title: 'Deactivate Department',
          message: "Are you sure you want to deactivate department 'Engineering'?",
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        })
      );
      expect(html).toBe('');
    });

    it('renders accessible confirmation dialog with title, message, cancel, and confirm buttons when open', () => {
      const html = renderToStaticMarkup(
        React.createElement(ConfirmDialog, {
          isOpen: true,
          title: 'Cancel Payroll Period',
          message: 'Cancel payroll period November 2026? This will mark it as CANCELLED.',
          confirmLabel: 'Cancel Period',
          cancelLabel: 'Cancel',
          variant: 'danger',
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        })
      );

      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain('Cancel Payroll Period');
      expect(html).toContain(
        'Cancel payroll period November 2026? This will mark it as CANCELLED.'
      );
      expect(html).toContain('Cancel Period');
      expect(html).toContain('>Cancel<');
      expect(html).toContain('bg-rose-600');
    });

    it('supports warning and primary variants, busy state disabling, and inline error display', () => {
      const warningHtml = renderToStaticMarkup(
        React.createElement(ConfirmDialog, {
          isOpen: true,
          title: 'Recalculate Approved Payroll Period',
          message:
            'Recalculate payslips for November 2026? WARNING: This period is currently ACCOUNTS_APPROVED.',
          confirmLabel: 'Recalculate Payslips',
          confirmBusyLabel: 'Processing...',
          variant: 'warning',
          isSubmitting: true,
          errorMessage: 'Payroll lock conflict detected.',
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        })
      );

      expect(warningHtml).toContain('bg-amber-600');
      expect(warningHtml).toContain('Processing...');
      expect(warningHtml).toContain('disabled=""');
      expect(warningHtml).toContain('role="alert"');
      expect(warningHtml).toContain('Payroll lock conflict detected.');

      const primaryHtml = renderToStaticMarkup(
        React.createElement(ConfirmDialog, {
          isOpen: true,
          title: 'Approve Leave Request',
          message: 'Approve leave request for Jane Employee (2026-11-10 to 2026-11-12)?',
          confirmLabel: 'Approve Request',
          variant: 'primary',
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        })
      );

      expect(primaryHtml).toContain('bg-indigo-600');
      expect(primaryHtml).toContain('Approve Request');
    });
  });

  describe('Confirmation gating, cancellation safety, and error/success feedback', () => {
    it('does not execute async mutation and leaves underlying data unchanged when cancelled', async () => {
      const records = [
        { id: 'dept-1', name: 'Engineering', isActive: true },
        { id: 'shift-1', name: 'Day Shift', isActive: true },
      ];
      const deactivateApi = vi.fn(async (id: string) => {
        const target = records.find((r) => r.id === id);
        if (target) target.isActive = false;
      });

      const outcome = await executeConfirmedAction(
        false,
        () => deactivateApi('dept-1'),
        'Failed to deactivate department.'
      );

      expect(outcome).toBeNull();
      expect(deactivateApi).not.toHaveBeenCalled();
      expect(records[0].isActive).toBe(true);
      expect(records[1].isActive).toBe(true);
    });

    it('executes async action only after explicit confirmation and returns success outcome', async () => {
      const state = { status: 'PENDING' };
      const approveApi = vi.fn(async () => {
        state.status = 'APPROVED';
        return { id: 'leave-1', status: 'APPROVED' };
      });

      const outcome = await executeConfirmedAction(
        true,
        approveApi,
        'Failed to approve leave request.'
      );

      expect(approveApi).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual({
        ok: true,
        result: { id: 'leave-1', status: 'APPROVED' },
      });
      expect(state.status).toBe('APPROVED');
    });

    it('captures API error messages cleanly for in-app error banners and falls back when error message is empty', async () => {
      const failingLeaveApi = vi.fn(async () => {
        throw new Error('Managers cannot approve their own leave requests.');
      });

      const namedErrorOutcome = await executeConfirmedAction(
        true,
        failingLeaveApi,
        'Failed to approve leave request.'
      );
      expect(namedErrorOutcome).toEqual({
        ok: false,
        errorMessage: 'Managers cannot approve their own leave requests.',
      });

      const emptyErrorShiftApi = vi.fn(async () => {
        throw new Error('   ');
      });

      const fallbackOutcome = await executeConfirmedAction(
        true,
        emptyErrorShiftApi,
        'Failed to deactivate shift.'
      );
      expect(fallbackOutcome).toEqual({
        ok: false,
        errorMessage: 'Failed to deactivate shift.',
      });
    });
  });

  describe('EmployeeSelfServicePage salary advance inline validation (replaces alert())', () => {
    it('returns user-friendly validation error for zero, negative, empty, or non-numeric amounts', () => {
      for (const badInput of ['', '0', '-150', 'abc', '   ']) {
        expect(validateSalaryAdvanceAmount(badInput)).toEqual({
          valid: false,
          error: 'Please provide a valid non-zero advance amount.',
        });
      }
    });

    it('accepts valid positive advance amounts', () => {
      expect(validateSalaryAdvanceAmount('500.00')).toEqual({
        valid: true,
        amount: 500,
      });
      expect(validateSalaryAdvanceAmount('125.5')).toEqual({
        valid: true,
        amount: 125.5,
      });
    });
  });

  describe('Regression guard: zero browser-native confirm/alert calls across updated pages', () => {
    const affectedFiles = [
      'src/client/pages/EmployeeSelfServicePage.tsx',
      'src/client/pages/LeavePage.tsx',
      'src/client/pages/DepartmentsPage.tsx',
      'src/client/pages/PayrollPage.tsx',
      'src/client/pages/AttendancePage.tsx',
      'src/client/components/common/ConfirmDialog.tsx',
    ];

    it('contains no window.confirm, window.alert, bare confirm(), or bare alert() calls', () => {
      const nativeDialogRegex = /\b(?:window\.|globalThis\.)?(?:confirm|alert|prompt)\s*\(/g;

      for (const relPath of affectedFiles) {
        const absPath = path.resolve(process.cwd(), relPath);
        const content = fs.readFileSync(absPath, 'utf8');
        const matches = content.match(nativeDialogRegex) || [];
        expect(matches, `Unexpected browser-native dialog call in ${relPath}`).toEqual([]);
      }
    });

    it('wires in-app ConfirmDialog in LeavePage, DepartmentsPage, PayrollPage, and AttendancePage', () => {
      for (const relPath of [
        'src/client/pages/LeavePage.tsx',
        'src/client/pages/DepartmentsPage.tsx',
        'src/client/pages/PayrollPage.tsx',
        'src/client/pages/AttendancePage.tsx',
      ]) {
        const absPath = path.resolve(process.cwd(), relPath);
        const content = fs.readFileSync(absPath, 'utf8');
        expect(content).toContain('<ConfirmDialog');
        expect(content).toContain('executeConfirmedAction');
      }
    });
  });
});
