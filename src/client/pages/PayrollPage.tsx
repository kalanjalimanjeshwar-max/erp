import React, { useState, useEffect, useCallback } from 'react';
import {
  DollarSign,
  Calendar,
  Plus,
  Filter,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  XCircle,
  X,
  BookOpen,
  ArrowRight,
  Eye,
  Play,
  Check,
  FileText,
  Building2,
  Printer,
  ChevronRight,
  Lock,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { LoadingSpinner } from '../components/common/LoadingSpinner.tsx';
import { EmptyState } from '../components/common/EmptyState.tsx';
import { ConfirmDialog, executeConfirmedAction } from '../components/common/ConfirmDialog.tsx';
import {
  AuthUser,
  PayrollPeriodItem,
  PayslipItem,
  PayrollStatus,
  PayslipStatus,
  CreatePayrollPeriodRequest,
  AccountLedgerItem,
  CompanyProfile,
} from '../../shared/types.ts';
import { formatMoney } from '../../shared/currency.ts';
import { formatDateTimeInTimezone, formatUtcTimestamp } from '../../shared/timezone.ts';
import {
  PREVIEW_PAYROLL_PERIODS,
  PREVIEW_PAYSLIPS,
  PREVIEW_ACCOUNT_LEDGERS,
} from '../services/previewStore.ts';

interface PayrollPageProps {
  currentUser: AuthUser;
  companyProfile?: CompanyProfile | null;
  onNavigateToJournals?: () => void;
}

export function computePayslipDeductionSummary(
  ps: Pick<PayslipItem, 'deductions' | 'lossOfPayDeduction'>
): {
  lopDeduction: number;
  otherDeductions: number;
  totalDeductions: number;
} {
  const totalDeductions = Math.max(0, Number(ps.deductions) || 0);
  const lopDeduction = Math.max(0, Number(ps.lossOfPayDeduction) || 0);
  const otherDeductions = Math.max(0, Number((totalDeductions - lopDeduction).toFixed(2)));
  return {
    lopDeduction,
    otherDeductions,
    totalDeductions,
  };
}

export interface PayslipDetailModalContentProps {
  payslip: PayslipItem;
  baseCurrency?: string;
  roundingPrecision?: number;
  statusTextClass?: string;
}

export const PayslipDetailModalContent: React.FC<PayslipDetailModalContentProps> = ({
  payslip,
  baseCurrency,
  roundingPrecision,
  statusTextClass = 'text-indigo-400',
}) => {
  const { lopDeduction, otherDeductions, totalDeductions } = computePayslipDeductionSummary(payslip);
  const breakdown = payslip.reconciliationBreakdown;
  const currency = breakdown?.currency || baseCurrency;
  const overtimeVal = Number(payslip.overtimePay) || 0;

  return (
    <div className="space-y-5">
      {/* Employee & Period Lockup */}
      <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 grid grid-cols-2 gap-4 text-xs">
        <div>
          <span className="text-slate-500 uppercase tracking-wider text-[10px] block">Employee</span>
          <span className="font-semibold text-slate-200 text-sm">{payslip.employeeName}</span>
          <span className="text-slate-400 font-mono block mt-0.5">Code: {payslip.employeeCode}</span>
        </div>
        <div>
          <span className="text-slate-500 uppercase tracking-wider text-[10px] block">Status &amp; Disbursement</span>
          <span className={`font-semibold text-sm ${statusTextClass}`}>{payslip.status}</span>
          <span className="text-slate-400 block mt-0.5">
            {payslip.paymentDate ? `Paid on ${payslip.paymentDate}` : 'Pending settlement'}
          </span>
        </div>
      </div>

      {/* Earnings & Deductions Breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-xs">
        {/* Earnings Column */}
        <div className="space-y-3">
          <h4 className="font-semibold text-slate-300 uppercase tracking-wider text-[11px] border-b border-slate-800 pb-1.5">
            Gross Earnings
          </h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Basic Salary</span>
              <span className="font-mono tabular-nums text-slate-200">
                {formatMoney(payslip.basicSalary, currency, { decimals: roundingPrecision })}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Allowances</span>
              <span className="font-mono tabular-nums text-slate-200">
                {formatMoney(payslip.allowances, currency, { decimals: roundingPrecision })}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-slate-400 block">Overtime Pay</span>
                {overtimeVal === 0 && (
                  <span className="text-[10px] text-slate-500">0.00 (Extra Time is not paid as OT)</span>
                )}
              </div>
              <span className="font-mono tabular-nums text-slate-200">
                {formatMoney(payslip.overtimePay, currency, { decimals: roundingPrecision })}
              </span>
            </div>
            <div className="flex items-center justify-between pt-2 border-t border-slate-800 font-semibold">
              <span className="text-slate-300">Total Gross Pay</span>
              <span className="font-mono tabular-nums text-indigo-300">
                {formatMoney(payslip.grossSalary, currency, { decimals: roundingPrecision })}
              </span>
            </div>
          </div>
        </div>

        {/* Deductions Column (Strictly non-duplicated) */}
        <div className="space-y-3">
          <h4 className="font-semibold text-slate-300 uppercase tracking-wider text-[11px] border-b border-slate-800 pb-1.5">
            Deductions
          </h4>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Loss of Pay (LOP)</span>
              <span className="font-mono tabular-nums text-amber-400">
                {formatMoney(lopDeduction, currency, { decimals: roundingPrecision })}
              </span>
            </div>
            {breakdown && (
              <div className="pl-3 border-l border-slate-800 space-y-1 text-[11px]">
                <div className="flex items-center justify-between text-slate-500">
                  <span>↳ Excess Leave Deduction (incl. in LOP)</span>
                  <span className="font-mono tabular-nums text-amber-300/90">
                    {formatMoney(breakdown.excessLeaveDeduction || 0, currency, { decimals: roundingPrecision })}
                  </span>
                </div>
                <div className="flex items-center justify-between text-slate-500">
                  <span>↳ Short-Hours Deduction (incl. in LOP)</span>
                  <span className="font-mono tabular-nums text-amber-300/90">
                    {formatMoney(breakdown.shortHoursDeduction || 0, currency, { decimals: roundingPrecision })}
                  </span>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Other Deductions</span>
              <span className="font-mono tabular-nums text-rose-400">
                {formatMoney(otherDeductions, currency, { decimals: roundingPrecision })}
              </span>
            </div>
            <div className="flex items-center justify-between pt-2 border-t border-slate-800 font-semibold">
              <span className="text-slate-300">Total Deductions</span>
              <span className="font-mono tabular-nums text-rose-400">
                {totalDeductions > 0
                  ? formatMoney(-Math.abs(totalDeductions), currency, { decimals: roundingPrecision })
                  : formatMoney(0, currency, { decimals: roundingPrecision })}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Policy & Working-Hours Reconciliation Breakdown */}
      {breakdown && (
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3 text-xs">
          <div className="flex items-center justify-between">
            <h4 className="font-semibold text-slate-300 uppercase tracking-wider text-[11px]">
              Policy &amp; Attendance Reconciliation
            </h4>
            <span className="text-[10px] text-slate-500">Derived from persisted payslip notes</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <div className="p-2.5 bg-slate-900/70 border border-slate-800 rounded-lg">
              <span className="text-[10px] text-slate-500 uppercase block">Monthly Leave Allowance</span>
              <span className="font-mono font-semibold text-indigo-300 text-sm">
                {breakdown.monthlyLeaveAllowance !== null ? `${breakdown.monthlyLeaveAllowance} days` : '--'}
              </span>
            </div>

            <div className="p-2.5 bg-slate-900/70 border border-slate-800 rounded-lg">
              <span className="text-[10px] text-slate-500 uppercase block">Short Time Hours</span>
              <span
                className={`font-mono font-semibold text-sm ${
                  (breakdown.shortTimeHours ?? 0) > 0 ? 'text-rose-400' : 'text-slate-200'
                }`}
              >
                {breakdown.shortTimeHours !== null ? `${breakdown.shortTimeHours} hrs` : '--'}
              </span>
            </div>

            <div className="p-2.5 bg-slate-900/70 border border-sky-900/50 rounded-lg">
              <span className="text-[10px] text-sky-400 uppercase block">Extra Time (Informational Only)</span>
              <span className="font-mono font-semibold text-sky-300 text-sm">
                {breakdown.extraTimeHours !== null ? `${breakdown.extraTimeHours} hrs` : '--'}
              </span>
              <span className="text-[10px] text-sky-300/75 block mt-0.5">
                Informational only — never offsets Short Time
              </span>
            </div>
          </div>

          {breakdown.warnings.length > 0 && (
            <div className="space-y-1.5 pt-1">
              {breakdown.warnings.map((warning, idx) => (
                <div
                  key={idx}
                  className="p-2.5 bg-amber-950/40 border border-amber-800/70 rounded-lg flex items-start gap-2 text-[11px] text-amber-200"
                >
                  <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Preserved Original Persisted Notes */}
      {payslip.notes && (
        <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3 text-[11px] space-y-1">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-500">
            Persisted Reconciliation Notes
          </div>
          <p className="text-slate-300 leading-relaxed font-mono break-words">{payslip.notes}</p>
        </div>
      )}

      {/* Net Salary Highlight Box */}
      <div className="bg-emerald-950/30 border border-emerald-800/60 rounded-xl p-4 flex items-center justify-between">
        <div>
          <span className="text-emerald-400 font-semibold text-xs uppercase tracking-wider block">
            Net Take-Home Pay
          </span>
          <span className="text-slate-400 text-[11px]">
            Account Ledger: {payslip.ledgerName || 'General Payroll Payable'}
          </span>
        </div>
        <div className="text-2xl font-bold font-mono tabular-nums text-emerald-300">
          {formatMoney(payslip.netSalary, currency, { decimals: roundingPrecision })}
        </div>
      </div>

      {/* Voucher Reference if Posted */}
      {payslip.journalVoucherNumber && (
        <div className="text-xs text-slate-400 flex items-center justify-between bg-slate-950 p-2.5 rounded-lg border border-slate-800">
          <span>General Journal Voucher:</span>
          <span className="font-mono font-semibold text-indigo-400">{payslip.journalVoucherNumber}</span>
        </div>
      )}
    </div>
  );
};

export const PayrollPage: React.FC<PayrollPageProps> = ({
  currentUser,
  companyProfile,
  onNavigateToJournals,
}) => {
  const isEmployee = currentUser.role === 'EMPLOYEE';
  const baseCurrency = companyProfile?.currency;
  const roundingPrecision = companyProfile?.roundingPrecision;
  const timezone = companyProfile?.timezone;

  // Manager State: Payroll Periods
  const [periods, setPeriods] = useState<PayrollPeriodItem[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<PayrollPeriodItem | null>(null);
  const [periodPayslips, setPeriodPayslips] = useState<PayslipItem[]>([]);
  const [isLoadingPeriods, setIsLoadingPeriods] = useState<boolean>(false);
  const [isLoadingPayslips, setIsLoadingPayslips] = useState<boolean>(false);
  const [periodsError, setPeriodsError] = useState<string | null>(null);

  // Filter State
  const [filterYear, setFilterYear] = useState<number | ''>(new Date().getFullYear());
  const [filterStatus, setFilterStatus] = useState<string>('');

  // Employee State: Self-Service Payslips
  const [myPayslips, setMyPayslips] = useState<PayslipItem[]>([]);
  const [isLoadingMyPayslips, setIsLoadingMyPayslips] = useState<boolean>(false);
  const [myPayslipsError, setMyPayslipsError] = useState<string | null>(null);

  // Payslip Detail Modal
  const [viewingPayslip, setViewingPayslip] = useState<PayslipItem | null>(null);

  // Create Period Modal
  const [isCreatePeriodModalOpen, setIsCreatePeriodModalOpen] = useState<boolean>(false);
  const [createPeriodError, setCreatePeriodError] = useState<string | null>(null);
  const [isSubmittingPeriod, setIsSubmittingPeriod] = useState<boolean>(false);
  const [formMonth, setFormMonth] = useState<number>(new Date().getMonth() + 1);
  const [formYear, setFormYear] = useState<number>(new Date().getFullYear());
  const [formStartDate, setFormStartDate] = useState<string>('');
  const [formEndDate, setFormEndDate] = useState<string>('');
  const [formName, setFormName] = useState<string>('');

  // Processing & Posting Action States
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isPosting, setIsPosting] = useState<boolean>(false);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  const [pendingConfirm, setPendingConfirm] = useState<
    | { kind: 'process'; period: PayrollPeriodItem; promptMsg: string; isAccountsApproved: boolean }
    | { kind: 'cancel'; period: PayrollPeriodItem }
    | null
  >(null);

  // Accounts Approval Action State
  const [isAccountsApproveModalOpen, setIsAccountsApproveModalOpen] = useState<boolean>(false);
  const [accountsApprovalNotes, setAccountsApprovalNotes] = useState<string>('');
  const [isApprovingAccounts, setIsApprovingAccounts] = useState<boolean>(false);

  // Post Period Modal
  const [isPostModalOpen, setIsPostModalOpen] = useState<boolean>(false);
  const [ledgers, setLedgers] = useState<AccountLedgerItem[]>([]);
  const [expenseLedgerId, setExpenseLedgerId] = useState<string>('');
  const [payableLedgerId, setPayableLedgerId] = useState<string>('');
  const [deductionsLedgerId, setDeductionsLedgerId] = useState<string>('');

  // Auto-populate dates when month/year change in Create Period modal
  const updateDatesForMonthYear = useCallback((m: number, y: number) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const start = `${y}-${pad(m)}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const end = `${y}-${pad(m)}-${pad(lastDay)}`;
    setFormStartDate(start);
    setFormEndDate(end);
    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    setFormName(`${monthNames[m - 1]} ${y}`);
  }, []);

  // Load My Payslips (Employee View)
  const loadMyPayslips = useCallback(async () => {
    setIsLoadingMyPayslips(true);
    setMyPayslipsError(null);

    if (currentUser?.isPreview) {
      let filtered = [...PREVIEW_PAYSLIPS];
      if (typeof filterYear === 'number') {
        filtered = filtered.filter((p) => p.payrollPeriodYear === filterYear);
      }
      setMyPayslips(filtered);
      setIsLoadingMyPayslips(false);
      return;
    }

    try {
      const data = await api.getMyPayslips({
        year: typeof filterYear === 'number' ? filterYear : undefined,
      });
      setMyPayslips(data);
    } catch (err: unknown) {
      setMyPayslipsError((err as Error).message || 'Failed to load your personal payslips.');
    } finally {
      setIsLoadingMyPayslips(false);
    }
  }, [currentUser?.isPreview, filterYear]);

  // Load Payroll Periods (Manager View)
  const loadPeriods = useCallback(async () => {
    if (isEmployee) return;
    setIsLoadingPeriods(true);
    setPeriodsError(null);

    if (currentUser?.isPreview) {
      let filtered = [...PREVIEW_PAYROLL_PERIODS];
      if (typeof filterYear === 'number') {
        filtered = filtered.filter((p) => p.year === filterYear);
      }
      if (filterStatus) {
        filtered = filtered.filter((p) => p.status === filterStatus);
      }
      setPeriods(filtered);
      if (filtered.length > 0 && !selectedPeriod) {
        setSelectedPeriod(filtered[0]);
        setPeriodPayslips(PREVIEW_PAYSLIPS);
      }
      setIsLoadingPeriods(false);
      return;
    }

    try {
      const data = await api.getPayrollPeriods({
        year: typeof filterYear === 'number' ? filterYear : undefined,
        status: (filterStatus as PayrollStatus) || undefined,
      });
      setPeriods(data);
    } catch (err: unknown) {
      setPeriodsError((err as Error).message || 'Failed to load company payroll periods.');
    } finally {
      setIsLoadingPeriods(false);
    }
  }, [currentUser?.isPreview, isEmployee, filterYear, filterStatus, selectedPeriod]);

  // Load Payslips for Selected Period
  const loadPeriodPayslips = useCallback(async (periodId: string) => {
    setIsLoadingPayslips(true);
    setActionError(null);

    if (currentUser?.isPreview) {
      setPeriodPayslips(PREVIEW_PAYSLIPS);
      setIsLoadingPayslips(false);
      return;
    }

    try {
      const slips = await api.getPeriodPayslips(periodId);
      setPeriodPayslips(slips);
    } catch (err: unknown) {
      setActionError((err as Error).message || 'Failed to load payslips for this period.');
    } finally {
      setIsLoadingPayslips(false);
    }
  }, [currentUser?.isPreview]);

  // Load ledgers for optional posting overrides
  const loadLedgers = useCallback(async () => {
    if (isEmployee) return;

    if (currentUser?.isPreview) {
      setLedgers(PREVIEW_ACCOUNT_LEDGERS);
      return;
    }

    try {
      const data = await api.getLedgers({ isActive: true });
      setLedgers(data);
    } catch {
      // Safe fallback
    }
  }, [currentUser?.isPreview, isEmployee]);

  useEffect(() => {
    if (isEmployee) {
      loadMyPayslips();
    } else {
      loadPeriods();
      loadLedgers();
    }
  }, [isEmployee, loadMyPayslips, loadPeriods, loadLedgers]);

  // Select period
  const handleSelectPeriod = (period: PayrollPeriodItem) => {
    setSelectedPeriod(period);
    loadPeriodPayslips(period.id);
  };

  // Open Create Period Modal
  const handleOpenCreatePeriod = () => {
    const nextMonth = new Date().getMonth() + 1;
    const nextYear = new Date().getFullYear();
    setFormMonth(nextMonth);
    setFormYear(nextYear);
    updateDatesForMonthYear(nextMonth, nextYear);
    setCreatePeriodError(null);
    setIsCreatePeriodModalOpen(true);
  };

  const handleCreatePeriod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (currentUser?.isPreview) {
      setCreatePeriodError('Saving is unavailable in Preview Mode: PostgreSQL is offline in sandbox.');
      return;
    }
    setCreatePeriodError(null);
    setIsSubmittingPeriod(true);

    try {
      const payload: CreatePayrollPeriodRequest = {
        month: Number(formMonth),
        year: Number(formYear),
        startDate: formStartDate,
        endDate: formEndDate,
        name: formName.trim() || undefined,
      };
      const created = await api.createPayrollPeriod(payload);
      setIsCreatePeriodModalOpen(false);
      loadPeriods();
      handleSelectPeriod(created);
    } catch (err: unknown) {
      setCreatePeriodError((err as Error).message || 'Failed to create payroll period.');
    } finally {
      setIsSubmittingPeriod(false);
    }
  };

  // Process / Recalculate Period (opens confirmation dialog)
  const handleProcessPeriod = () => {
    if (!selectedPeriod) return;
    if (currentUser?.isPreview) {
      setActionError('Processing payroll is unavailable in Preview Mode: PostgreSQL is offline in sandbox.');
      return;
    }
    const isAccountsApproved = selectedPeriod.status === 'ACCOUNTS_APPROVED';
    const periodLabel = selectedPeriod.name || `${selectedPeriod.year}-${selectedPeriod.month}`;
    const promptMsg = isAccountsApproved
      ? `Recalculate payslips for ${periodLabel}? WARNING: This period is currently ACCOUNTS_APPROVED. Recalculation will invalidate previous Accounts approval and return status to PROCESSED.`
      : `Calculate and process payslips for ${periodLabel}? This evaluates active employees, salary revisions, and deduplicated unpaid absences.`;

    setActionError(null);
    setPendingConfirm({
      kind: 'process',
      period: selectedPeriod,
      promptMsg,
      isAccountsApproved,
    });
  };

  // Open Accounts Approval Modal
  const handleOpenAccountsApproveModal = () => {
    setAccountsApprovalNotes('');
    setActionError(null);
    setIsAccountsApproveModalOpen(true);
  };

  // Confirm Accounts Approval
  const handleConfirmAccountsApprove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPeriod) return;
    if (currentUser?.isPreview) {
      setActionError('Accounts approval is unavailable in Preview Mode: PostgreSQL is offline in sandbox.');
      return;
    }

    setIsApprovingAccounts(true);
    setActionError(null);
    try {
      const updated = await api.approvePayrollAccounts(selectedPeriod.id, {
        notes: accountsApprovalNotes.trim() || undefined,
      });
      setSelectedPeriod(updated);
      setIsAccountsApproveModalOpen(false);
      loadPeriods();
      loadPeriodPayslips(updated.id);
    } catch (err: unknown) {
      setActionError((err as Error).message || 'Failed to grant Accounts approval.');
    } finally {
      setIsApprovingAccounts(false);
    }
  };

  // Open Post Modal
  const handleOpenPostModal = () => {
    setActionError(null);
    setIsPostModalOpen(true);
  };

  // Confirm Post to General Ledger
  const handleConfirmPost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPeriod) return;
    if (currentUser?.isPreview) {
      setActionError('Posting payroll to General Ledger is unavailable in Preview Mode: PostgreSQL is offline in sandbox.');
      return;
    }

    setIsPosting(true);
    setActionError(null);
    try {
      const updated = await api.postPayrollPeriod(selectedPeriod.id, {
        payrollExpenseLedgerId: expenseLedgerId || undefined,
        payrollPayableLedgerId: payableLedgerId || undefined,
        deductionsLedgerId: deductionsLedgerId || undefined,
      });
      setSelectedPeriod(updated);
      setIsPostModalOpen(false);
      loadPeriods();
      loadPeriodPayslips(updated.id);
    } catch (err: unknown) {
      setActionError((err as Error).message || 'Failed to post payroll to General Ledger.');
    } finally {
      setIsPosting(false);
    }
  };

  // Cancel Period (opens confirmation dialog)
  const handleCancelPeriod = () => {
    if (!selectedPeriod) return;
    if (currentUser?.isPreview) {
      setActionError('Cancelling payroll periods is unavailable in Preview Mode: PostgreSQL is offline in sandbox.');
      return;
    }
    setActionError(null);
    setPendingConfirm({ kind: 'cancel', period: selectedPeriod });
  };

  // Execute confirmed Process / Cancel action
  const handleConfirmPeriodAction = async () => {
    if (!pendingConfirm) return;
    setActionError(null);

    if (pendingConfirm.kind === 'process') {
      const { period, isAccountsApproved } = pendingConfirm;
      setIsProcessing(true);
      try {
        const outcome = await executeConfirmedAction(
          true,
          () => api.processPayrollPeriod(period.id),
          'Failed to process payroll period.'
        );
        if (outcome?.ok && outcome.result) {
          setSelectedPeriod(outcome.result);
          setActionSuccess(
            isAccountsApproved
              ? `Recalculated payslips for ${period.name || `${period.year}-${period.month}`}. Status returned to PROCESSED.`
              : `Processed payslips for ${period.name || `${period.year}-${period.month}`}.`
          );
          setPendingConfirm(null);
          loadPeriods();
          loadPeriodPayslips(outcome.result.id);
        } else if (outcome?.errorMessage) {
          setActionError(outcome.errorMessage);
          setPendingConfirm(null);
        }
      } finally {
        setIsProcessing(false);
      }
    } else {
      const { period } = pendingConfirm;
      setIsCancelling(true);
      try {
        const outcome = await executeConfirmedAction(
          true,
          () => api.cancelPayrollPeriod(period.id),
          'Failed to cancel payroll period.'
        );
        if (outcome?.ok && outcome.result) {
          setSelectedPeriod(outcome.result);
          setActionSuccess(`Payroll period ${period.name} has been cancelled.`);
          setPendingConfirm(null);
          loadPeriods();
          loadPeriodPayslips(outcome.result.id);
        } else if (outcome?.errorMessage) {
          setActionError(outcome.errorMessage);
          setPendingConfirm(null);
        }
      } finally {
        setIsCancelling(false);
      }
    }
  };

  const getStatusTextClass = (status: PayrollStatus | PayslipStatus) => {
    switch (status) {
      case 'POSTED':
      case 'PAID':
      case 'APPROVED':
        return 'text-emerald-400';
      case 'ACCOUNTS_APPROVED':
        return 'text-cyan-400';
      case 'PROCESSED':
        return 'text-sky-400';
      case 'DRAFT':
        return 'text-amber-400';
      case 'CANCELLED':
        return 'text-rose-400';
      default:
        return 'text-slate-400';
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2.5">
            <DollarSign className="w-6 h-6 text-indigo-400" />
            <span>{isEmployee ? 'My Payslips & Compensation' : 'Payroll Management & Disbursement'}</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            {isEmployee
              ? 'Review your official company payslips, gross earnings, Loss-of-Pay deductions, and net disbursements.'
              : 'End-to-end payroll cycle management: batch calculations, attendance deductions, and General Ledger posting.'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {!isEmployee && (
            <button
              onClick={() => !currentUser?.isPreview && handleOpenCreatePeriod()}
              disabled={currentUser?.isPreview}
              title={
                currentUser?.isPreview
                  ? 'Saving is unavailable in Preview Mode: PostgreSQL is offline in sandbox'
                  : 'New Payroll Period'
              }
              className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 shadow-sm ${
                currentUser?.isPreview
                  ? 'bg-slate-900/60 text-slate-500 border border-slate-800 cursor-not-allowed opacity-75'
                  : 'text-white bg-indigo-600 hover:bg-indigo-500 cursor-pointer'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Payroll Period</span>
              {currentUser?.isPreview && (
                <span className="text-[9px] font-mono uppercase bg-amber-950/80 text-amber-300 px-1.5 py-0.5 rounded border border-amber-800/80 ml-1">
                  Disabled
                </span>
              )}
            </button>
          )}

          <button
            onClick={isEmployee ? loadMyPayslips : loadPeriods}
            disabled={isLoadingPeriods || isLoadingMyPayslips}
            className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${isLoadingPeriods || isLoadingMyPayslips ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Preview Mode Notice */}
      {currentUser?.isPreview && (
        <div className="bg-amber-950/60 border border-amber-800/70 rounded-xl p-4 text-xs text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow">
          <div className="flex items-center gap-2.5">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
            <div>
              <strong className="text-amber-100">UI Exploration Mode — Read-Only Demo Payroll</strong>
              <p className="text-amber-300/80 mt-0.5">
                Displaying sample payroll periods, payslips, and compensation calculations. Creating, processing, or posting periods is disabled while PostgreSQL is offline in sandbox.
              </p>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-900/60 border border-amber-700/60 text-amber-300 self-start sm:self-auto shrink-0">
            Read-Only Exploration
          </span>
        </div>
      )}

      {/* ========================================================================= */}
      {/* EMPLOYEE SELF-SERVICE VIEW                                               */}
      {/* ========================================================================= */}
      {isEmployee && (
        <div className="space-y-4">
          {/* Year Filter */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400 flex items-center gap-1.5">
                <Filter className="w-3.5 h-3.5" /> Year:
              </span>
              <select
                value={filterYear}
                onChange={(e) => setFilterYear(e.target.value ? Number(e.target.value) : '')}
                className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 font-mono tabular-nums focus:outline-none focus:border-indigo-500"
              >
                <option value="">All Years</option>
                {[2024, 2025, 2026, 2027].map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
            <div className="text-xs text-slate-400 font-mono">
              Authenticated Employee: <span className="text-indigo-300 font-semibold">{currentUser.fullName}</span>
            </div>
          </div>

          {myPayslipsError && (
            <div className="bg-rose-950/40 border border-rose-900 rounded-xl p-4 text-xs text-rose-300 flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{myPayslipsError}</span>
            </div>
          )}

          {isLoadingMyPayslips ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-12">
              <LoadingSpinner message="Retrieving your official payslips..." />
            </div>
          ) : myPayslips.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-8">
              <EmptyState
                icon={<DollarSign className="w-6 h-6" />}
                title="No Payslips Available"
                description="No processed or approved payslips have been issued for your account in the selected period."
              />
            </div>
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4 font-medium">Payroll Period</th>
                    <th className="py-3 px-4 font-medium text-right">Basic Salary</th>
                    <th className="py-3 px-4 font-medium text-right">Allowances</th>
                    <th className="py-3 px-4 font-medium text-right">Gross Pay</th>
                    <th className="py-3 px-4 font-medium text-right">LOP Deduction</th>
                    <th className="py-3 px-4 font-medium text-right">Total Deductions</th>
                    <th className="py-3 px-4 font-medium text-right">Net Payable</th>
                    <th className="py-3 px-4 font-medium">Status</th>
                    <th className="py-3 px-4 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {myPayslips.map((ps) => (
                    <tr key={ps.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-200">{ps.payrollPeriodName || 'Monthly Payroll'}</div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          {ps.payrollPeriodYear}-{String(ps.payrollPeriodMonth).padStart(2, '0')}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300">
                        {formatMoney(ps.basicSalary, baseCurrency, { decimals: roundingPrecision })}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-400">
                        {formatMoney(ps.allowances, baseCurrency, { decimals: roundingPrecision })}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-200">
                        {formatMoney(ps.grossSalary, baseCurrency, { decimals: roundingPrecision })}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-amber-400">
                        {Number(ps.lossOfPayDeduction) > 0
                          ? formatMoney(-Math.abs(Number(ps.lossOfPayDeduction)), baseCurrency, { decimals: roundingPrecision })
                          : formatMoney(0, baseCurrency, { decimals: roundingPrecision })}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-rose-400">
                        {Number(ps.deductions) > 0
                          ? formatMoney(-Math.abs(Number(ps.deductions)), baseCurrency, { decimals: roundingPrecision })
                          : formatMoney(0, baseCurrency, { decimals: roundingPrecision })}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-bold text-emerald-400 text-sm">
                        {formatMoney(ps.netSalary, baseCurrency, { decimals: roundingPrecision })}
                      </td>
                      <td className="py-3 px-4">
                        <span className={`font-semibold ${getStatusTextClass(ps.status)}`}>
                          {ps.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={() => setViewingPayslip(ps)}
                          className="px-2.5 py-1 text-xs font-medium text-indigo-300 bg-indigo-950/60 border border-indigo-800 rounded hover:bg-indigo-900/80 transition-colors inline-flex items-center gap-1"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>View Slip</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* MANAGER VIEW: PERIODS & DRILLDOWN                                         */}
      {/* ========================================================================= */}
      {!isEmployee && (
        <div className="space-y-6">
          {/* Action Error Banner */}
          {actionError && (
            <div
              role="alert"
              className="bg-rose-950/40 border border-rose-900 rounded-xl p-4 text-xs text-rose-300 flex items-center justify-between"
            >
              <div className="flex items-center gap-2.5">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{actionError}</span>
              </div>
              <button
                type="button"
                onClick={() => setActionError(null)}
                aria-label="Dismiss error notification"
                className="text-rose-400 hover:text-rose-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Action Success Banner */}
          {actionSuccess && (
            <div
              role="status"
              className="bg-emerald-950/40 border border-emerald-900 rounded-xl p-4 text-xs text-emerald-200 flex items-center justify-between"
            >
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>{actionSuccess}</span>
              </div>
              <button
                type="button"
                onClick={() => setActionSuccess(null)}
                aria-label="Dismiss success notification"
                className="text-emerald-400 hover:text-emerald-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Periods Table & Filters */}
          <div className="space-y-4">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <Filter className="w-3.5 h-3.5" />
                  <span>Periods Filter:</span>
                </div>
                <div>
                  <select
                    value={filterYear}
                    onChange={(e) => setFilterYear(e.target.value ? Number(e.target.value) : '')}
                    className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 font-mono tabular-nums focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">All Years</option>
                    {[2024, 2025, 2026, 2027].map((y) => (
                      <option key={y} value={y}>
                        {y}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <select
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                    className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">All Statuses</option>
                    <option value="DRAFT">Draft</option>
                    <option value="PROCESSED">Processed</option>
                    <option value="ACCOUNTS_APPROVED">Accounts Approved</option>
                    <option value="POSTED">Posted to GL</option>
                    <option value="CANCELLED">Cancelled</option>
                  </select>
                </div>
                {(filterYear !== '' || filterStatus !== '') && (
                  <button
                    onClick={() => {
                      setFilterYear('');
                      setFilterStatus('');
                    }}
                    className="text-xs text-slate-400 hover:text-slate-200 underline transition"
                  >
                    Reset
                  </button>
                )}
              </div>
              <span className="text-xs text-slate-400">
                Click any period row below to review payslips and run calculations.
              </span>
            </div>

            {isLoadingPeriods ? (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-12">
                <LoadingSpinner message="Loading payroll cycles..." />
              </div>
            ) : periods.length === 0 ? (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-8">
                <EmptyState
                  icon={<Calendar className="w-6 h-6" />}
                  title="No Payroll Periods Configured"
                  description="Create your first payroll cycle to calculate monthly salaries, loss of pay deductions, and accounting journals."
                  action={
                    <button
                      onClick={handleOpenCreatePeriod}
                      className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
                    >
                      Create First Period
                    </button>
                  }
                />
              </div>
            ) : (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-3 px-4 font-medium">Period Name</th>
                      <th className="py-3 px-4 font-medium">Dates (Start – End)</th>
                      <th className="py-3 px-4 font-medium">Status</th>
                      <th className="py-3 px-4 font-medium text-right">Employees</th>
                      <th className="py-3 px-4 font-medium text-right">Total Gross</th>
                      <th className="py-3 px-4 font-medium text-right">Total Deductions</th>
                      <th className="py-3 px-4 font-medium text-right">Total Net</th>
                      <th className="py-3 px-4 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300">
                    {periods.map((p) => {
                      const isSelected = selectedPeriod?.id === p.id;
                      return (
                        <tr
                          key={p.id}
                          onClick={() => handleSelectPeriod(p)}
                          className={`cursor-pointer transition-colors ${
                            isSelected ? 'bg-indigo-950/40 border-l-2 border-indigo-500' : 'hover:bg-slate-800/40'
                          }`}
                        >
                          <td className="py-3 px-4">
                            <div className="font-semibold text-slate-100 flex items-center gap-2">
                              <span>{p.name || `${p.year}-${String(p.month).padStart(2, '0')}`}</span>
                              {isSelected && <span className="text-[10px] text-indigo-400">· Active</span>}
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono">
                              Month {p.month}, {p.year}
                            </div>
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums text-slate-400">
                            {p.startDate} <span className="text-slate-600">to</span> {p.endDate}
                          </td>
                          <td className="py-3 px-4">
                            <span className={`font-semibold ${getStatusTextClass(p.status)}`}>
                              {p.status}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300">
                            {p.payslipsCount ?? '—'}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-300">
                            {formatMoney(p.totalGross || 0, baseCurrency, { decimals: roundingPrecision })}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-rose-400">
                            {formatMoney(p.totalDeductions || 0, baseCurrency, { decimals: roundingPrecision })}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-bold text-emerald-400 text-sm">
                            {formatMoney(p.totalNet || 0, baseCurrency, { decimals: roundingPrecision })}
                          </td>
                          <td className="py-3 px-4 text-right">
                            <span className="text-slate-500 inline-flex items-center gap-1 group-hover:text-slate-300">
                              <span>Review</span>
                              <ChevronRight className="w-3.5 h-3.5" />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Drilldown Section for Selected Period */}
          {selectedPeriod && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-6 shadow-sm">
              {/* Selected Period Control Header */}
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
                <div>
                  <div className="flex items-center gap-2.5">
                    <h2 className="text-lg font-bold text-slate-100">
                      {selectedPeriod.name || `${selectedPeriod.year}-${selectedPeriod.month}`}
                    </h2>
                    <span className={`text-xs font-semibold ${getStatusTextClass(selectedPeriod.status)}`}>
                      ({selectedPeriod.status})
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1 font-mono tabular-nums">
                    Period Dates: {selectedPeriod.startDate} to {selectedPeriod.endDate} · Created by{' '}
                    {selectedPeriod.createdByUserName || 'Admin'}
                  </p>
                </div>

                {/* Status-Driven Lifecycle Actions */}
                {(() => {
                  const currentUserId = currentUser.id || (currentUser as unknown as { userId?: string }).userId;
                  const isAccountsApprover = Boolean(
                    selectedPeriod.accountsApprovedByUserId &&
                      selectedPeriod.accountsApprovedByUserId === currentUserId
                  );

                  return (
                    <div className="flex flex-col items-end gap-2.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        {/* Recalculate / Process button (Only if DRAFT, PROCESSED, or ACCOUNTS_APPROVED) */}
                        {selectedPeriod.status !== 'POSTED' && selectedPeriod.status !== 'CANCELLED' && (
                          <button
                            onClick={handleProcessPeriod}
                            disabled={isProcessing}
                            className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                            title="Run calculation engine against employee revisions and attendance records"
                          >
                            <Play className={`w-3.5 h-3.5 ${isProcessing ? 'animate-spin' : ''}`} />
                            <span>
                              {selectedPeriod.status === 'DRAFT'
                                ? 'Process Payroll'
                                : 'Recalculate Period'}
                            </span>
                          </button>
                        )}

                        {/* Stage 1: Accounts Approval (Available when PROCESSED) */}
                        {selectedPeriod.status === 'PROCESSED' && (
                          <button
                            onClick={handleOpenAccountsApproveModal}
                            className="px-3.5 py-1.5 text-xs font-medium text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
                            title="Review and grant Accounts approval (requires ACCOUNTING:APPROVE)"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Approve Accounts</span>
                          </button>
                        )}

                        {/* Stage 2: Post to GL (Available when ACCOUNTS_APPROVED) */}
                        {selectedPeriod.status === 'ACCOUNTS_APPROVED' && (
                          <button
                            onClick={handleOpenPostModal}
                            disabled={isPosting || isAccountsApprover}
                            className={`px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 shadow-sm ${
                              isAccountsApprover
                                ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed opacity-75'
                                : 'text-white bg-emerald-600 hover:bg-emerald-500'
                            }`}
                            title={
                              isAccountsApprover
                                ? 'Four-Eyes Dual Approval: You approved this period in Accounts stage. A distinct administrator must authorize final posting.'
                                : 'Post to General Ledger and lock period (requires PAYROLL:APPROVE)'
                            }
                          >
                            {isAccountsApprover ? (
                              <Lock className="w-3.5 h-3.5" />
                            ) : (
                              <BookOpen className="w-3.5 h-3.5" />
                            )}
                            <span>Post to General Ledger</span>
                          </button>
                        )}

                        {/* Cancel button (Only if DRAFT, PROCESSED, or ACCOUNTS_APPROVED) */}
                        {selectedPeriod.status !== 'POSTED' && selectedPeriod.status !== 'CANCELLED' && (
                          <button
                            onClick={handleCancelPeriod}
                            disabled={isCancelling}
                            className="px-3 py-1.5 text-xs font-medium text-rose-300 bg-rose-950/60 border border-rose-800 hover:bg-rose-900/80 rounded-lg transition-colors disabled:opacity-50"
                          >
                            Cancel Period
                          </button>
                        )}

                        {/* If Posted, Link to Journals */}
                        {selectedPeriod.status === 'POSTED' && onNavigateToJournals && (
                          <button
                            onClick={onNavigateToJournals}
                            className="px-3.5 py-1.5 text-xs font-medium text-indigo-300 bg-indigo-950 border border-indigo-800 rounded-lg hover:bg-indigo-900 transition flex items-center gap-1.5"
                          >
                            <BookOpen className="w-3.5 h-3.5" />
                            <span>View GL Journal Postings</span>
                          </button>
                        )}
                      </div>

                      {/* Four-Eyes Warning Banner when user is the Accounts Approver */}
                      {selectedPeriod.status === 'ACCOUNTS_APPROVED' && isAccountsApprover && (
                        <div className="w-full bg-amber-950/40 border border-amber-800/80 rounded-lg p-2.5 text-xs text-amber-200 flex items-center gap-2">
                          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                          <span>
                            <strong>Four-Eyes Security Policy:</strong> You provided Accounts approval for this period. In accordance with dual-control governance, a distinct administrator with PAYROLL:APPROVE must authorize final posting.
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Four-Eyes Dual Approval Governance Timeline */}
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-indigo-400" />
                    <span>Four-Eyes Dual Approval Governance</span>
                  </span>
                  <span className="text-[11px] text-slate-500 font-mono">
                    Enforced: Accounts &amp; Admin Approvals by Distinct Users
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  {/* Stage 1: Accounts Approval */}
                  <div
                    className={`p-3 rounded-lg border ${
                      selectedPeriod.accountsApprovedAt
                        ? 'bg-cyan-950/20 border-cyan-800/60'
                        : selectedPeriod.status === 'PROCESSED'
                        ? 'bg-slate-900 border-amber-800/60'
                        : 'bg-slate-900/40 border-slate-800/60'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                        <span className="w-5 h-5 rounded-full bg-cyan-900/60 border border-cyan-700 text-cyan-300 flex items-center justify-center text-[10px] font-bold">
                          1
                        </span>
                        <span>Stage 1: Accounts Approval</span>
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold font-mono ${
                          selectedPeriod.accountsApprovedAt
                            ? 'bg-cyan-950 text-cyan-300 border border-cyan-800'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {selectedPeriod.accountsApprovedAt ? 'APPROVED' : 'PENDING'}
                      </span>
                    </div>
                    <div className="mt-2 text-[11px] text-slate-400 space-y-0.5">
                      <div>
                        Required Permission:{' '}
                        <span className="font-mono text-slate-300">ACCOUNTING:APPROVE</span>
                      </div>
                      {selectedPeriod.accountsApprovedAt ? (
                        <>
                          <div>
                            Approver:{' '}
                            <strong className="text-slate-200">
                              {selectedPeriod.accountsApprovedByUserName ||
                                selectedPeriod.accountsApprovedByUserId}
                            </strong>
                          </div>
                          <div>
                            Timestamp:{' '}
                            <span
                              className="font-mono tabular-nums text-slate-300"
                              title={`UTC: ${formatUtcTimestamp(selectedPeriod.accountsApprovedAt)}`}
                            >
                              {formatDateTimeInTimezone(selectedPeriod.accountsApprovedAt, timezone, {
                                includeZoneAbbr: true,
                              })}
                            </span>
                          </div>
                          {selectedPeriod.accountsApprovalNotes && (
                            <div className="italic text-slate-400 mt-1">
                              Notes: &quot;{selectedPeriod.accountsApprovalNotes}&quot;
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="text-slate-500 mt-1">
                          {selectedPeriod.status === 'PROCESSED'
                            ? 'Awaiting review and approval by Accounting.'
                            : 'Requires period to be in PROCESSED status.'}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Stage 2: Admin Posting Approval */}
                  <div
                    className={`p-3 rounded-lg border ${
                      selectedPeriod.adminApprovedAt || selectedPeriod.status === 'POSTED'
                        ? 'bg-emerald-950/20 border-emerald-800/60'
                        : selectedPeriod.status === 'ACCOUNTS_APPROVED'
                        ? 'bg-slate-900 border-indigo-800/60'
                        : 'bg-slate-900/40 border-slate-800/60'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                        <span className="w-5 h-5 rounded-full bg-emerald-900/60 border border-emerald-700 text-emerald-300 flex items-center justify-center text-[10px] font-bold">
                          2
                        </span>
                        <span>Stage 2: Admin GL Posting</span>
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold font-mono ${
                          selectedPeriod.adminApprovedAt || selectedPeriod.status === 'POSTED'
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {selectedPeriod.status === 'POSTED' ? 'POSTED & LOCKED' : 'PENDING'}
                      </span>
                    </div>
                    <div className="mt-2 text-[11px] text-slate-400 space-y-0.5">
                      <div>
                        Required Permission:{' '}
                        <span className="font-mono text-slate-300">PAYROLL:APPROVE</span>
                      </div>
                      {selectedPeriod.adminApprovedAt || selectedPeriod.status === 'POSTED' ? (
                        <>
                          <div>
                            Approver:{' '}
                            <strong className="text-slate-200">
                              {selectedPeriod.adminApprovedByUserName || 'Admin'}
                            </strong>
                          </div>
                          <div>
                            Timestamp:{' '}
                            <span
                              className="font-mono tabular-nums text-slate-300"
                              title={`UTC: ${formatUtcTimestamp(
                                selectedPeriod.adminApprovedAt || selectedPeriod.postedAt
                              )}`}
                            >
                              {formatDateTimeInTimezone(
                                selectedPeriod.adminApprovedAt || selectedPeriod.postedAt,
                                timezone,
                                { includeZoneAbbr: true }
                              )}
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className="text-slate-500 mt-1">
                          {selectedPeriod.status === 'ACCOUNTS_APPROVED'
                            ? 'Ready for final posting by distinct administrator.'
                            : 'Locked until Stage 1 Accounts Approval completes.'}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Financial Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                  <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Gross Payroll</div>
                  <div className="text-lg font-bold font-mono tabular-nums text-slate-100 mt-1">
                    {formatMoney(selectedPeriod.totalGross || 0, baseCurrency, { decimals: roundingPrecision })}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Basic + Allowances + OT</div>
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                  <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Total Deductions</div>
                  <div className="text-lg font-bold font-mono tabular-nums text-rose-400 mt-1">
                    {formatMoney(selectedPeriod.totalDeductions || 0, baseCurrency, { decimals: roundingPrecision })}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">LOP + Mandatory Deductions</div>
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                  <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Net Disbursement</div>
                  <div className="text-lg font-bold font-mono tabular-nums text-emerald-400 mt-1">
                    {formatMoney(selectedPeriod.totalNet || 0, baseCurrency, { decimals: roundingPrecision })}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Total Company Net Payable</div>
                </div>

                <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
                  <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Processed Employees</div>
                  <div className="text-lg font-bold font-mono tabular-nums text-indigo-400 mt-1">
                    {selectedPeriod.payslipsCount || 0}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Active Payslips on Record</div>
                </div>
              </div>

              {/* Payslips Table */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    Generated Employee Payslips
                  </h3>
                  <span className="text-xs text-slate-500">
                    {periodPayslips.length} calculated payslips in this cycle
                  </span>
                </div>

                {isLoadingPayslips ? (
                  <div className="p-8">
                    <LoadingSpinner message="Loading payslips for this period..." />
                  </div>
                ) : periodPayslips.length === 0 ? (
                  <div className="p-6 bg-slate-950 border border-slate-800 rounded-xl text-center text-xs text-slate-400">
                    {selectedPeriod.status === 'DRAFT'
                      ? 'No payslips generated yet. Click "Process Payroll" above to run the calculation engine for all active employees.'
                      : 'No payslips found for this cycle.'}
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-slate-800 rounded-xl">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-950 text-slate-400 border-b border-slate-800">
                        <tr>
                          <th className="py-2.5 px-3 font-medium">Employee</th>
                          <th className="py-2.5 px-3 font-medium text-right">Basic</th>
                          <th className="py-2.5 px-3 font-medium text-right">Allowances</th>
                          <th className="py-2.5 px-3 font-medium text-right">Overtime</th>
                          <th className="py-2.5 px-3 font-medium text-right">Gross Pay</th>
                          <th className="py-2.5 px-3 font-medium">Policy &amp; Hours</th>
                          <th className="py-2.5 px-3 font-medium text-right">LOP (Incl.)</th>
                          <th className="py-2.5 px-3 font-medium text-right">Total Deductions</th>
                          <th className="py-2.5 px-3 font-medium text-right">Net Salary</th>
                          <th className="py-2.5 px-3 font-medium">Payable Ledger</th>
                          <th className="py-2.5 px-3 font-medium text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60 text-slate-300">
                        {periodPayslips.map((ps) => {
                          const bd = ps.reconciliationBreakdown;
                          const rowCurrency = bd?.currency || baseCurrency;
                          return (
                            <tr key={ps.id} className="hover:bg-slate-800/40 transition-colors">
                              <td className="py-2.5 px-3">
                                <div className="font-medium text-slate-100">{ps.employeeName}</div>
                                <div className="text-[11px] text-slate-500 font-mono">{ps.employeeCode}</div>
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-300">
                                {formatMoney(ps.basicSalary, rowCurrency, { decimals: roundingPrecision })}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-400">
                                {formatMoney(ps.allowances, rowCurrency, { decimals: roundingPrecision })}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-400">
                                {formatMoney(ps.overtimePay, rowCurrency, { decimals: roundingPrecision })}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold text-slate-200">
                                {formatMoney(ps.grossSalary, rowCurrency, { decimals: roundingPrecision })}
                              </td>
                              <td className="py-2.5 px-3 text-[11px] min-w-[200px]">
                                {bd ? (
                                  <div className="space-y-0.5">
                                    <div className="text-slate-300 font-mono">
                                      Allow: <span className="text-indigo-300">{bd.monthlyLeaveAllowance ?? '--'}d</span> • Short:{' '}
                                      <span className={(bd.shortTimeHours ?? 0) > 0 ? 'text-rose-400' : 'text-slate-300'}>
                                        {bd.shortTimeHours ?? 0}h
                                      </span>
                                    </div>
                                    <div className="text-sky-300/90 font-mono text-[10px]">
                                      Extra: {bd.extraTimeHours ?? 0}h (info only)
                                    </div>
                                    <div className="text-slate-500 text-[10px] font-mono">
                                      ExL: {formatMoney(bd.excessLeaveDeduction || 0, rowCurrency, { decimals: roundingPrecision })} · SH:{' '}
                                      {formatMoney(bd.shortHoursDeduction || 0, rowCurrency, { decimals: roundingPrecision })}
                                    </div>
                                    {bd.warnings.length > 0 && (
                                      <div
                                        className="inline-flex items-center gap-1 text-[10px] text-amber-300 bg-amber-950/50 border border-amber-800/60 px-1.5 py-0.5 rounded mt-0.5"
                                        title={bd.warnings.join(' ')}
                                      >
                                        <AlertCircle className="w-3 h-3 text-amber-400 shrink-0" />
                                        <span>{bd.warnings.length} warning{bd.warnings.length === 1 ? '' : 's'}</span>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-slate-500">--</span>
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono tabular-nums text-amber-400">
                                {Number(ps.lossOfPayDeduction) > 0
                                  ? formatMoney(-Math.abs(Number(ps.lossOfPayDeduction)), rowCurrency, { decimals: roundingPrecision })
                                  : formatMoney(0, rowCurrency, { decimals: roundingPrecision })}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono tabular-nums text-rose-400">
                                {Number(ps.deductions) > 0
                                  ? formatMoney(-Math.abs(Number(ps.deductions)), rowCurrency, { decimals: roundingPrecision })
                                  : formatMoney(0, rowCurrency, { decimals: roundingPrecision })}
                              </td>
                              <td className="py-2.5 px-3 text-right font-mono tabular-nums font-bold text-emerald-400">
                                {formatMoney(ps.netSalary, rowCurrency, { decimals: roundingPrecision })}
                              </td>
                              <td className="py-2.5 px-3 text-slate-400 max-w-xs truncate font-mono text-[11px]">
                                {ps.ledgerName || 'General Payroll Payable'}
                              </td>
                              <td className="py-2.5 px-3 text-right">
                                <button
                                  onClick={() => setViewingPayslip(ps)}
                                  className="p-1 text-slate-400 hover:text-indigo-400 transition-colors rounded hover:bg-slate-800"
                                  title="View Itemized Payslip"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: ITEMISED PAYSLIP DETAILS / PRINT VIEW                             */}
      {/* ========================================================================= */}
      {viewingPayslip && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-6 space-y-6 shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-indigo-400" />
                  <span>Official Earnings &amp; Payslip Statement</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5 font-mono">
                  {viewingPayslip.payrollPeriodName || 'Monthly Payroll'}
                </p>
              </div>
              <button
                onClick={() => setViewingPayslip(null)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <PayslipDetailModalContent
              payslip={viewingPayslip}
              baseCurrency={baseCurrency}
              roundingPrecision={roundingPrecision}
              statusTextClass={getStatusTextClass(viewingPayslip.status)}
            />

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => window.print()}
                className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-lg transition flex items-center gap-1.5"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>Print Statement</span>
              </button>
              <button
                type="button"
                onClick={() => setViewingPayslip(null)}
                className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: CREATE PAYROLL PERIOD                                              */}
      {/* ========================================================================= */}
      {isCreatePeriodModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-indigo-400" />
                <span>Establish New Payroll Period</span>
              </h3>
              <button
                onClick={() => setIsCreatePeriodModalOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {createPeriodError && (
              <div className="bg-rose-950/40 border border-rose-900 rounded-lg p-3 text-xs text-rose-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{createPeriodError}</span>
              </div>
            )}

            <form onSubmit={handleCreatePeriod} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Payroll Month *</label>
                  <select
                    value={formMonth}
                    onChange={(e) => {
                      const m = parseInt(e.target.value, 10);
                      setFormMonth(m);
                      updateDatesForMonthYear(m, formYear);
                    }}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    {[
                      { m: 1, name: '01 - January' },
                      { m: 2, name: '02 - February' },
                      { m: 3, name: '03 - March' },
                      { m: 4, name: '04 - April' },
                      { m: 5, name: '05 - May' },
                      { m: 6, name: '06 - June' },
                      { m: 7, name: '07 - July' },
                      { m: 8, name: '08 - August' },
                      { m: 9, name: '09 - September' },
                      { m: 10, name: '10 - October' },
                      { m: 11, name: '11 - November' },
                      { m: 12, name: '12 - December' },
                    ].map((item) => (
                      <option key={item.m} value={item.m}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Payroll Year *</label>
                  <input
                    type="number"
                    min="2000"
                    max="2100"
                    value={formYear}
                    onChange={(e) => {
                      const y = parseInt(e.target.value, 10);
                      setFormYear(y);
                      updateDatesForMonthYear(formMonth, y);
                    }}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Period Display Name</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. May 2026 Regular Cycle"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Start Date *</label>
                  <input
                    type="date"
                    value={formStartDate}
                    onChange={(e) => setFormStartDate(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">End Date *</label>
                  <input
                    type="date"
                    value={formEndDate}
                    onChange={(e) => setFormEndDate(e.target.value)}
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsCreatePeriodModalOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingPeriod}
                  className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition disabled:opacity-50"
                >
                  {isSubmittingPeriod ? 'Creating Period...' : 'Establish Period'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: ACCOUNTS APPROVAL CONFIRMATION                                     */}
      {/* ========================================================================= */}
      {isAccountsApproveModalOpen && selectedPeriod && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-cyan-400 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                <span>Stage 1: Grant Accounts Approval</span>
              </h3>
              <button
                onClick={() => setIsAccountsApproveModalOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-xs text-slate-300 space-y-3">
              <p>
                Grant Accounts approval for period <strong className="text-white">{selectedPeriod.name}</strong>.
                This certifies that earnings, attendance deductions, and net disbursements have been verified by accounting.
              </p>
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5 font-mono text-[11px]">
                <div className="flex justify-between">
                  <span className="text-slate-400">Total Gross Pay:</span>
                  <span className="text-slate-200">
                    {formatMoney(selectedPeriod.totalGross || 0, baseCurrency, { decimals: roundingPrecision })}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Total Deductions:</span>
                  <span className="text-rose-400">
                    {formatMoney(selectedPeriod.totalDeductions || 0, baseCurrency, { decimals: roundingPrecision })}
                  </span>
                </div>
                <div className="flex justify-between font-bold">
                  <span className="text-slate-300">Total Net Payable:</span>
                  <span className="text-emerald-400">
                    {formatMoney(selectedPeriod.totalNet || 0, baseCurrency, { decimals: roundingPrecision })}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Employee Payslips:</span>
                  <span className="text-slate-200">{selectedPeriod.payslipsCount || 0}</span>
                </div>
              </div>

              <div className="p-2.5 bg-amber-950/40 border border-amber-800/80 rounded-lg text-amber-200 text-[11px] flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <span>
                  <strong>Four-Eyes Policy Notice:</strong> Once you grant Accounts approval, you will be recorded as the Stage 1 Approver. Under corporate governance rules, you cannot authorize the Stage 2 General Ledger posting for this period. A distinct administrator must post.
                </span>
              </div>
            </div>

            <form onSubmit={handleConfirmAccountsApprove} className="space-y-4 pt-2 border-t border-slate-800">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Approval Notes / Audit Reference (Optional)
                </label>
                <textarea
                  value={accountsApprovalNotes}
                  onChange={(e) => setAccountsApprovalNotes(e.target.value)}
                  placeholder="e.g., Verified timesheets and absence reconciliations for all engineering and operations staff."
                  rows={3}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 placeholder:text-slate-600"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAccountsApproveModalOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isApprovingAccounts}
                  className="px-4 py-2 text-xs font-medium text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg transition disabled:opacity-50 flex items-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{isApprovingAccounts ? 'Recording Approval...' : 'Confirm Accounts Approval'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: POST TO GENERAL LEDGER CONFIRMATION                                */}
      {/* ========================================================================= */}
      {isPostModalOpen && selectedPeriod && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-emerald-400 flex items-center gap-2">
                <BookOpen className="w-4 h-4" />
                <span>Confirm General Ledger Posting</span>
              </h3>
              <button
                onClick={() => setIsPostModalOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="text-xs text-slate-300 space-y-3">
              <p>
                Posting will lock period <strong className="text-white">{selectedPeriod.name}</strong> as{' '}
                <span className="text-emerald-400 font-semibold">POSTED</span> and generate an atomic double-entry
                General Journal Voucher:
              </p>
              <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg space-y-1.5 font-mono">
                <div className="flex justify-between">
                  <span className="text-slate-400">Debit Gross Expense:</span>
                  <span className="text-slate-200">
                    {formatMoney(selectedPeriod.totalGross || 0, baseCurrency, { decimals: roundingPrecision })}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Credit Net Salaries Payable:</span>
                  <span className="text-emerald-400">
                    {formatMoney(selectedPeriod.totalNet || 0, baseCurrency, { decimals: roundingPrecision })}
                  </span>
                </div>
                {Number(selectedPeriod.totalDeductions) > 0 && (
                  <div className="flex justify-between">
                    <span className="text-slate-400">Credit Payroll Deductions:</span>
                    <span className="text-rose-400">
                      {formatMoney(selectedPeriod.totalDeductions || 0, baseCurrency, { decimals: roundingPrecision })}
                    </span>
                  </div>
                )}
              </div>
              <p className="text-slate-400 text-[11px]">
                Active employee ledgers will be credited individually; remaining balances will credit the company's
                configured Salaries &amp; Wages Payable ledger.
              </p>
            </div>

            <form onSubmit={handleConfirmPost} className="space-y-4 pt-2 border-t border-slate-800">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Salaries Expense Ledger (Optional Override)
                </label>
                <select
                  value={expenseLedgerId}
                  onChange={(e) => setExpenseLedgerId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">Default (Auto-resolve from Chart of Accounts)</option>
                  {ledgers.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code} · {l.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsPostModalOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPosting}
                  className="px-4 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition disabled:opacity-50 flex items-center gap-1.5"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{isPosting ? 'Posting to GL...' : 'Post and Lock Period'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      <ConfirmDialog
        isOpen={Boolean(pendingConfirm)}
        title={
          pendingConfirm?.kind === 'process'
            ? pendingConfirm.isAccountsApproved
              ? 'Recalculate Approved Payroll Period'
              : 'Process Payroll Period'
            : 'Cancel Payroll Period'
        }
        message={
          pendingConfirm?.kind === 'process'
            ? pendingConfirm.promptMsg
            : pendingConfirm?.kind === 'cancel'
            ? `Cancel payroll period ${pendingConfirm.period.name}? This will mark it as CANCELLED.`
            : ''
        }
        confirmLabel={
          pendingConfirm?.kind === 'process'
            ? pendingConfirm.isAccountsApproved
              ? 'Recalculate Payslips'
              : 'Process Payroll'
            : 'Cancel Period'
        }
        confirmBusyLabel={
          pendingConfirm?.kind === 'process' ? 'Processing...' : 'Cancelling...'
        }
        variant={
          pendingConfirm?.kind === 'cancel'
            ? 'danger'
            : pendingConfirm?.kind === 'process' && pendingConfirm.isAccountsApproved
            ? 'warning'
            : 'primary'
        }
        isSubmitting={isProcessing || isCancelling}
        onConfirm={handleConfirmPeriodAction}
        onCancel={() => {
          if (!isProcessing && !isCancelling) {
            setPendingConfirm(null);
          }
        }}
      />
    </div>
  );
};
