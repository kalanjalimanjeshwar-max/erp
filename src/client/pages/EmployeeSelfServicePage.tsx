import React, { useState, useEffect, useCallback } from 'react';
import {
  CalendarCheck,
  DollarSign,
  FileText,
  CreditCard,
  Receipt,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
  X,
  Layers,
  ShieldAlert,
  Printer,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { LoadingSpinner } from '../components/common/LoadingSpinner.tsx';
import { EmptyState } from '../components/common/EmptyState.tsx';
import { ExpenseModuleView } from '../components/expenses/ExpenseModuleView.tsx';
import {
  AuthUser,
  LeaveRequestItem,
  LeaveTypeItem,
  MonthlyLeaveSummary,
  PayslipItem,
} from '../../shared/types.ts';

interface EmployeeSelfServicePageProps {
  currentUser: AuthUser;
}

export interface DemoSalaryAdvance {
  id: string;
  employeeCode: string;
  employeeName: string;
  amount: number;
  reason: string;
  requestedDate: string;
  disbursedDate: string | null;
  repaymentMonths: number;
  monthlyDeduction: number;
  status: 'PENDING_APPROVAL' | 'DISBURSED' | 'REPAID' | 'REJECTED';
  remarks: string | null;
  isSimulated: boolean;
}

export const EmployeeSelfServicePage: React.FC<EmployeeSelfServicePageProps> = ({
  currentUser,
}) => {
  const isPreview = Boolean(currentUser.isPreview);
  const [activeTab, setActiveTab] = useState<'leave' | 'payslips' | 'advances' | 'expenses'>('leave');

  // Filter State
  const currentDate = new Date();
  const [selectedYear, setSelectedYear] = useState<number>(currentDate.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(currentDate.getMonth() + 1);

  // Tab 1: Leave & Balance State
  const [leaveSummary, setLeaveSummary] = useState<MonthlyLeaveSummary | null>(null);
  const [leaveRequests, setRequests] = useState<LeaveRequestItem[]>([]);
  const [leaveTypes, setLeaveTypes] = useState<LeaveTypeItem[]>([]);
  const [isLoadingLeave, setIsLoadingLeave] = useState<boolean>(true);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  // Leave Application Modal State
  const [isApplyModalOpen, setIsApplyModalOpen] = useState<boolean>(false);
  const [applyLeaveTypeId, setApplyLeaveTypeId] = useState<string>('');
  const [applyStartDate, setApplyStartDate] = useState<string>('');
  const [applyEndDate, setApplyEndDate] = useState<string>('');
  const [applyTotalDays, setApplyTotalDays] = useState<number>(1);
  const [applyReason, setApplyReason] = useState<string>('');
  const [isSubmittingLeave, setIsSubmittingLeave] = useState<boolean>(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySuccess, setApplySuccess] = useState<string | null>(null);

  // Tab 2: Payslips State
  const [payslips, setPayslips] = useState<PayslipItem[]>([]);
  const [isLoadingPayslips, setIsLoadingPayslips] = useState<boolean>(false);
  const [payslipsError, setPayslipsError] = useState<string | null>(null);
  const [selectedPayslip, setSelectedPayslip] = useState<PayslipItem | null>(null);

  // Tab 3: Salary Advances (Demo / Preview State)
  const [salaryAdvances, setSalaryAdvances] = useState<DemoSalaryAdvance[]>([]);
  const [isAdvanceModalOpen, setIsAdvanceModalOpen] = useState<boolean>(false);
  const [advanceAmount, setAdvanceAmount] = useState<string>('500.00');
  const [advanceReason, setAdvanceReason] = useState<string>('Emergency home repairs');
  const [advanceMonths, setAdvanceMonths] = useState<number>(2);

  // Load Leave Data
  const loadLeaveData = useCallback(async () => {
    setIsLoadingLeave(true);
    setLeaveError(null);
    try {
      if (isPreview) {
        const mockSummary: MonthlyLeaveSummary = {
          year: selectedYear,
          month: selectedMonth,
          employeeId: 'emp-preview-01',
          employeeName: currentUser.fullName || 'Preview Employee',
          employeeCode: 'EMP-PREVIEW',
          totalRequestedDays: 3,
          approvedDays: 2,
          pendingDays: 1,
          rejectedDays: 0,
          rejectedCount: 0,
          pendingCount: 1,
          approvedCount: 1,
          totalAnnualEntitlement: 24,
          annualUsedDays: 4,
          annualRemainingBalance: 20,
          excessLeaveDays: 0,
          monthlyLeaveAllowance: 4.0,
          monthApprovedDays: 2,
          monthRemainingLeave: 2,
          monthlyExcessLeaveDays: 0,
          monthlySalary: '4500.00',
          dailySalaryRate: '150.00',
          hourlySalaryRate: '20.00',
          configuredDailyWorkingHours: 7.5,
          shiftSchedule: 'General Shift (09:00 – 16:30)',
          deductibleShortHours: 0,
          incompleteAttendanceCount: 0,
          excessLeaveDeduction: '0.00',
          shortHoursDeduction: '0.00',
          totalSalaryDeductions: '0.00',
          byType: [
            {
              leaveTypeId: 'lt-annual',
              leaveTypeCode: 'AL',
              leaveTypeName: 'Annual Paid Leave',
              isPaid: true,
              annualAllowance: 14,
              monthRequestedDays: 2,
              monthApprovedDays: 2,
              monthPendingDays: 0,
              annualUsedDays: 2,
              annualRemainingDays: 12,
            },
            {
              leaveTypeId: 'lt-sick',
              leaveTypeCode: 'SL',
              leaveTypeName: 'Sick / Medical Leave',
              isPaid: true,
              annualAllowance: 7,
              monthRequestedDays: 1,
              monthApprovedDays: 0,
              monthPendingDays: 1,
              annualUsedDays: 1,
              annualRemainingDays: 6,
            },
            {
              leaveTypeId: 'lt-casual',
              leaveTypeCode: 'CL',
              leaveTypeName: 'Casual Leave',
              isPaid: true,
              annualAllowance: 3,
              monthRequestedDays: 0,
              monthApprovedDays: 0,
              monthPendingDays: 0,
              annualUsedDays: 1,
              annualRemainingDays: 2,
            },
          ],
        };
        setLeaveSummary(mockSummary);

        const mockTypes: LeaveTypeItem[] = [
          {
            id: 'lt-annual',
            companyId: 'preview-co',
            code: 'AL',
            name: 'Annual Paid Leave',
            description: 'Standard yearly paid leave',
            isPaid: true,
            defaultAllowance: 14,
            isActive: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'lt-sick',
            companyId: 'preview-co',
            code: 'SL',
            name: 'Sick / Medical Leave',
            description: 'Medical necessity and recovery',
            isPaid: true,
            defaultAllowance: 7,
            isActive: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ];
        setLeaveTypes(mockTypes);

        const mockRequests: LeaveRequestItem[] = [
          {
            id: 'req-01',
            companyId: 'preview-co',
            employeeId: 'emp-preview-01',
            employeeCode: 'EMP-PREVIEW',
            employeeName: currentUser.fullName || 'Preview Employee',
            leaveTypeId: 'lt-annual',
            leaveTypeCode: 'AL',
            leaveTypeName: 'Annual Paid Leave',
            startDate: `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-10`,
            endDate: `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-11`,
            totalDays: 2,
            reason: 'Personal family commitment',
            status: 'APPROVED',
            reviewedByUserId: 'admin-01',
            reviewedByUserName: 'HR Director',
            reviewedAt: `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-05T10:00:00Z`,
            rejectionReason: null,
            createdAt: `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-04T12:00:00Z`,
            updatedAt: `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-05T10:00:00Z`,
          },
          {
            id: 'req-02',
            companyId: 'preview-co',
            employeeId: 'emp-preview-01',
            employeeCode: 'EMP-PREVIEW',
            employeeName: currentUser.fullName || 'Preview Employee',
            leaveTypeId: 'lt-sick',
            leaveTypeCode: 'SL',
            leaveTypeName: 'Sick / Medical Leave',
            startDate: `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-25`,
            endDate: `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-25`,
            totalDays: 1,
            reason: 'Dental checkup and recovery',
            status: 'PENDING',
            reviewedByUserId: null,
            reviewedByUserName: null,
            reviewedAt: null,
            rejectionReason: null,
            createdAt: `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-20T08:30:00Z`,
            updatedAt: `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-20T08:30:00Z`,
          },
        ];
        setRequests(mockRequests);
      } else {
        const [summaryRes, typesRes, requestsRes] = await Promise.all([
          api.getLeaveSummary({ year: selectedYear, month: selectedMonth }),
          api.getLeaveTypes(),
          api.getLeaveRequests({
            startDate: `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`,
            limit: 50,
          }),
        ]);
        setLeaveSummary(summaryRes);
        setLeaveTypes(typesRes.filter((t: LeaveTypeItem) => t.isActive));
        setRequests(requestsRes.items || []);
      }
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setLeaveError(apiErr.message || 'Failed to load leave records.');
    } finally {
      setIsLoadingLeave(false);
    }
  }, [isPreview, selectedYear, selectedMonth, currentUser.fullName]);

  // Load Payslips Data
  const loadPayslips = useCallback(async () => {
    setIsLoadingPayslips(true);
    setPayslipsError(null);
    try {
      if (isPreview) {
        const mockPayslips: PayslipItem[] = [
          {
            id: 'ps-preview-jan',
            companyId: 'preview-co',
            payrollPeriodId: 'pp-preview-jan',
            payrollPeriodName: 'January 2026',
            payrollPeriodMonth: 1,
            payrollPeriodYear: 2026,
            employeeId: 'emp-preview-01',
            employeeCode: 'EMP-PREVIEW',
            employeeName: currentUser.fullName || 'Preview Employee',
            basicSalary: '3500.00',
            allowances: '500.00',
            overtimePay: '120.00',
            grossSalary: '4120.00',
            deductions: '0.00',
            lossOfPayDeduction: '0.00',
            netSalary: '4120.00',
            status: 'APPROVED',
            paymentMethod: 'BANK_TRANSFER',
            paymentDate: '2026-01-31',
            ledgerId: 'led-emp-01',
            ledgerName: 'Employee Payable - John Doe',
            journalEntryId: 'je-01',
            journalVoucherNumber: 'JV-2026-0004',
            notes: 'Processed and settled via regular direct deposit',
            createdAt: '2026-01-31T18:00:00Z',
            updatedAt: '2026-01-31T18:00:00Z',
          },
        ];
        setPayslips(mockPayslips);
      } else {
        const data = await api.getMyPayslips({ year: selectedYear });
        setPayslips(data || []);
      }
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setPayslipsError(apiErr.message || 'Failed to load employee payslips.');
    } finally {
      setIsLoadingPayslips(false);
    }
  }, [isPreview, selectedYear, currentUser.fullName]);

  // Initial Load & Tab Switching
  useEffect(() => {
    if (activeTab === 'leave') {
      loadLeaveData();
    } else if (activeTab === 'payslips') {
      loadPayslips();
    }
  }, [activeTab, loadLeaveData, loadPayslips]);

  // Seed Initial Demo Salary Advances
  useEffect(() => {
    setSalaryAdvances([
      {
        id: 'ADV-2026-001',
        employeeCode: currentUser.fullName ? 'EMP-PREVIEW' : 'EMP-001',
        employeeName: currentUser.fullName || 'John Employee',
        amount: 800.0,
        reason: 'Medical procedure copayment for dependent',
        requestedDate: '2026-01-15',
        disbursedDate: '2026-01-16',
        repaymentMonths: 2,
        monthlyDeduction: 400.0,
        status: 'DISBURSED',
        remarks: 'Approved by Finance Director; deduction scheduled for Jan/Feb payroll',
        isSimulated: true,
      },
      {
        id: 'ADV-2026-002',
        employeeCode: currentUser.fullName ? 'EMP-PREVIEW' : 'EMP-001',
        employeeName: currentUser.fullName || 'John Employee',
        amount: 350.0,
        reason: 'Relocation deposit assistance',
        requestedDate: '2026-02-01',
        disbursedDate: null,
        repaymentMonths: 1,
        monthlyDeduction: 350.0,
        status: 'PENDING_APPROVAL',
        remarks: null,
        isSimulated: true,
      },
    ]);
  }, [currentUser.fullName]);

  // Recalculate Leave Duration when dates change
  useEffect(() => {
    if (applyStartDate && applyEndDate) {
      const s = new Date(applyStartDate);
      const e = new Date(applyEndDate);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e.getTime() >= s.getTime()) {
        const diff = Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
        setApplyTotalDays(Math.max(1, diff));
      }
    }
  }, [applyStartDate, applyEndDate]);

  // Handle Leave Submission
  const handleApplyLeave = async (e: React.FormEvent) => {
    e.preventDefault();
    setApplyError(null);
    setApplySuccess(null);

    if (!applyLeaveTypeId) {
      setApplyError('Please select a leave category.');
      return;
    }
    if (!applyStartDate || !applyEndDate) {
      setApplyError('Please specify both start and end dates.');
      return;
    }
    if (applyEndDate < applyStartDate) {
      setApplyError('End date cannot precede start date.');
      return;
    }

    setIsSubmittingLeave(true);
    try {
      if (isPreview) {
        const selectedType = leaveTypes.find((t) => t.id === applyLeaveTypeId);
        const newReq: LeaveRequestItem = {
          id: `req-sim-${Date.now()}`,
          companyId: 'preview-co',
          employeeId: 'emp-preview-01',
          employeeCode: 'EMP-PREVIEW',
          employeeName: currentUser.fullName || 'Preview Employee',
          leaveTypeId: applyLeaveTypeId,
          leaveTypeCode: selectedType?.code || 'LV',
          leaveTypeName: selectedType?.name || 'General Leave',
          startDate: applyStartDate,
          endDate: applyEndDate,
          totalDays: applyTotalDays,
          reason: applyReason || null,
          status: 'PENDING',
          reviewedByUserId: null,
          reviewedByUserName: null,
          reviewedAt: null,
          rejectionReason: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        setRequests((prev) => [newReq, ...prev]);
        setApplySuccess('Leave application submitted successfully in Preview session (in-memory).');
      } else {
        await api.submitLeaveRequest({
          leaveTypeId: applyLeaveTypeId,
          startDate: applyStartDate,
          endDate: applyEndDate,
          totalDays: applyTotalDays,
          reason: applyReason || null,
        });
        setApplySuccess('Leave request submitted successfully. It has been routed to your manager for review.');
        await loadLeaveData();
      }

      setTimeout(() => {
        setIsApplyModalOpen(false);
        setApplyReason('');
        setApplyStartDate('');
        setApplyEndDate('');
        setApplySuccess(null);
      }, 1500);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setApplyError(apiErr.message || 'Failed to submit leave request.');
    } finally {
      setIsSubmittingLeave(false);
    }
  };

  // Handle Salary Advance Simulation Submission
  const handleApplyAdvance = (e: React.FormEvent) => {
    e.preventDefault();
    const numAmount = parseFloat(advanceAmount);
    if (isNaN(numAmount) || numAmount <= 0) {
      alert('Please provide a valid non-zero advance amount.');
      return;
    }

    const monthly = parseFloat((numAmount / advanceMonths).toFixed(2));
    const newAdv: DemoSalaryAdvance = {
      id: `ADV-${new Date().getFullYear()}-${String(salaryAdvances.length + 1).padStart(3, '0')}`,
      employeeCode: currentUser.fullName ? 'EMP-PREVIEW' : 'EMP-001',
      employeeName: currentUser.fullName || 'John Employee',
      amount: numAmount,
      reason: advanceReason || 'Short-term financial requirement',
      requestedDate: new Date().toISOString().split('T')[0],
      disbursedDate: null,
      repaymentMonths: advanceMonths,
      monthlyDeduction: monthly,
      status: 'PENDING_APPROVAL',
      remarks: null,
      isSimulated: true,
    };

    setSalaryAdvances((prev) => [newAdv, ...prev]);
    setIsAdvanceModalOpen(false);
  };

  const monthsList = [
    { value: 1, label: 'January' },
    { value: 2, label: 'February' },
    { value: 3, label: 'March' },
    { value: 4, label: 'April' },
    { value: 5, label: 'May' },
    { value: 6, label: 'June' },
    { value: 7, label: 'July' },
    { value: 8, label: 'August' },
    { value: 9, label: 'September' },
    { value: 10, label: 'October' },
    { value: 11, label: 'November' },
    { value: 12, label: 'December' },
  ];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-indigo-500/10 border border-indigo-500/20 rounded-lg text-indigo-400">
                <CalendarCheck className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight">
                  Employee Self-Service (ESS)
                </h1>
                <p className="text-sm text-slate-400">
                  Manage your personal leaves, attendance summary, compensation payslips, and workplace requests.
                </p>
              </div>
            </div>
          </div>

          {/* User Profile Badge */}
          <div className="flex items-center gap-3 bg-slate-950/70 border border-slate-800 px-4 py-2 rounded-lg text-xs">
            <div className="w-8 h-8 rounded-full bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center font-bold text-indigo-300">
              {(currentUser.fullName || currentUser.email || 'E').charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="font-semibold text-slate-200">
                {currentUser.fullName || currentUser.email}
              </div>
              <div className="text-slate-500 font-mono text-[11px]">
                Role: {currentUser.role}
              </div>
            </div>
          </div>
        </div>

        {/* Portal Navigation Tabs */}
        <div className="flex flex-wrap gap-2 mt-6 pt-5 border-t border-slate-800">
          <button
            onClick={() => setActiveTab('leave')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'leave'
                ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/30'
                : 'bg-slate-950/60 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800/80'
            }`}
          >
            <CalendarCheck className="w-4 h-4" />
            Leave & Entitlement Summary
          </button>

          <button
            onClick={() => setActiveTab('payslips')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'payslips'
                ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-500/30'
                : 'bg-slate-950/60 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800/80'
            }`}
          >
            <DollarSign className="w-4 h-4" />
            My Payslips & Compensation
          </button>

          <button
            onClick={() => setActiveTab('advances')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'advances'
                ? 'bg-amber-600 text-white shadow-sm shadow-amber-500/30'
                : 'bg-slate-950/60 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800/80'
            }`}
          >
            <CreditCard className="w-4 h-4" />
            Salary Advances
            <span className="text-[10px] px-1.5 py-0.2 bg-amber-500/20 text-amber-300 rounded font-normal">
              Stage 2 Design
            </span>
          </button>

          <button
            onClick={() => setActiveTab('expenses')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
              activeTab === 'expenses'
                ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-500/30'
                : 'bg-slate-950/60 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800/80'
            }`}
          >
            <Receipt className="w-4 h-4" />
            Expense Reimbursements
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: LEAVE & ENTITLEMENT SUMMARY                                        */}
      {/* ========================================================================= */}
      {activeTab === 'leave' && (
        <div className="space-y-6">
          {/* Controls Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900 border border-slate-800 p-4 rounded-xl">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-slate-400">Target Month:</span>
              <select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(Number(e.target.value))}
                className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500"
              >
                {monthsList.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>

              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
                className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500"
              >
                <option value={2025}>2025</option>
                <option value={2026}>2026</option>
                <option value={2027}>2027</option>
              </select>

              <button
                onClick={loadLeaveData}
                disabled={isLoadingLeave}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                title="Refresh summary"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingLeave ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <button
              onClick={() => {
                setIsApplyModalOpen(true);
                if (leaveTypes.length > 0 && !applyLeaveTypeId) {
                  setApplyLeaveTypeId(leaveTypes[0].id);
                }
              }}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-sm transition-all shadow-indigo-600/30"
            >
              <Plus className="w-4 h-4" />
              Apply for Leave
            </button>
          </div>

          {/* Error Message */}
          {leaveError && (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{leaveError}</span>
            </div>
          )}

          {/* Top Monthly Metrics Grid */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {/* Total Annual Entitlement */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
              <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                Total Entitlement
              </div>
              <div className="mt-2 text-2xl font-bold text-white">
                {leaveSummary ? leaveSummary.totalAnnualEntitlement : '--'}
                <span className="text-xs font-normal text-slate-500 ml-1">days/yr</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-400">Company policy quota</div>
            </div>

            {/* Approved Leave Used */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
              <div className="text-[11px] font-medium text-emerald-400 uppercase tracking-wider">
                Approved (Month)
              </div>
              <div className="mt-2 text-2xl font-bold text-emerald-300">
                {leaveSummary ? leaveSummary.approvedDays : '--'}
                <span className="text-xs font-normal text-emerald-500 ml-1">days</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                {leaveSummary?.approvedCount || 0} approved request(s)
              </div>
            </div>

            {/* Pending Approvals */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
              <div className="text-[11px] font-medium text-amber-400 uppercase tracking-wider">
                Pending Review
              </div>
              <div className="mt-2 text-2xl font-bold text-amber-300">
                {leaveSummary ? leaveSummary.pendingDays : '--'}
                <span className="text-xs font-normal text-amber-500 ml-1">days</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                {leaveSummary?.pendingCount || 0} awaiting manager action
              </div>
            </div>

            {/* Remaining Annual Balance */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-sm">
              <div className="text-[11px] font-medium text-indigo-400 uppercase tracking-wider">
                Remaining Balance
              </div>
              <div className="mt-2 text-2xl font-bold text-indigo-300">
                {leaveSummary ? leaveSummary.annualRemainingBalance : '--'}
                <span className="text-xs font-normal text-indigo-500 ml-1">days left</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                Used {leaveSummary?.annualUsedDays || 0} days YTD
              </div>
            </div>

            {/* Excess Leave Days */}
            <div className={`rounded-xl p-4 shadow-sm border ${
              (leaveSummary?.excessLeaveDays || 0) > 0
                ? 'bg-rose-950/40 border-rose-800/80 text-rose-200'
                : 'bg-slate-900 border-slate-800 text-slate-400'
            }`}>
              <div className="text-[11px] font-medium uppercase tracking-wider">
                Excess Leave
              </div>
              <div className={`mt-2 text-2xl font-bold ${
                (leaveSummary?.excessLeaveDays || 0) > 0 ? 'text-rose-400' : 'text-slate-300'
              }`}>
                {leaveSummary ? leaveSummary.excessLeaveDays : '--'}
                <span className="text-xs font-normal text-slate-500 ml-1">days</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {(leaveSummary?.excessLeaveDays || 0) > 0
                  ? 'Subject to Loss of Pay (LOP)'
                  : 'Within approved allowance'}
              </div>
            </div>
          </div>

          {/* Leave Type Breakdown Cards */}
          {leaveSummary?.byType && leaveSummary.byType.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm space-y-4">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
                <Layers className="w-4 h-4 text-indigo-400" />
                Leave Balances by Category ({selectedYear})
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {leaveSummary.byType.map((cat) => {
                  const usedPct = cat.annualAllowance > 0
                    ? Math.min(100, Math.round((cat.annualUsedDays / cat.annualAllowance) * 100))
                    : 0;

                  return (
                    <div
                      key={cat.leaveTypeId}
                      className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-semibold text-slate-200 text-sm">{cat.leaveTypeName}</div>
                          <div className="text-[11px] text-slate-500 font-mono">
                            Code: {cat.leaveTypeCode} • {cat.isPaid ? 'Paid Leave' : 'Unpaid'}
                          </div>
                        </div>
                        <span className="text-xs font-bold text-slate-200 bg-slate-900 px-2 py-1 rounded border border-slate-800">
                          {cat.annualRemainingDays} / {cat.annualAllowance}d
                        </span>
                      </div>

                      {/* Progress bar */}
                      <div className="space-y-1">
                        <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              usedPct >= 90 ? 'bg-rose-500' : usedPct >= 70 ? 'bg-amber-500' : 'bg-indigo-500'
                            }`}
                            style={{ width: `${usedPct}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] text-slate-500">
                          <span>Used: {cat.annualUsedDays}d</span>
                          <span>{usedPct}% utilized</span>
                        </div>
                      </div>

                      <div className="text-[11px] text-slate-400 border-t border-slate-900 pt-2 flex justify-between">
                        <span>This Month:</span>
                        <span className="font-semibold text-indigo-300">
                          {cat.monthApprovedDays}d approved • {cat.monthPendingDays}d pending
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Monthly Working Schedule & Salary Deduction Breakdown */}
          {leaveSummary && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-emerald-400" />
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                    Working Schedule & Salary Deduction Breakdown ({selectedYear}-{String(selectedMonth).padStart(2, '0')})
                  </h2>
                </div>
                <div className="text-xs text-slate-400 font-mono">
                  {leaveSummary.shiftSchedule ? (
                    <span className="text-emerald-400 font-medium">{leaveSummary.shiftSchedule}</span>
                  ) : (
                    <span className="text-amber-400 font-medium">No Official Shift Assigned</span>
                  )}
                </div>
              </div>

              {/* Warnings Banner if any */}
              {leaveSummary.warnings && leaveSummary.warnings.length > 0 && (
                <div className="space-y-2">
                  {leaveSummary.warnings.map((w, idx) => (
                    <div
                      key={idx}
                      className="p-3 bg-amber-950/40 border border-amber-800/80 rounded-lg flex items-start gap-2.5 text-xs text-amber-200"
                    >
                      <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                  <span className="text-[10px] text-slate-500 uppercase font-semibold">Configured Hours</span>
                  <div className="text-sm font-bold text-slate-200 mt-1">
                    {leaveSummary.configuredDailyWorkingHours !== null
                      ? `${leaveSummary.configuredDailyWorkingHours} hrs/day`
                      : 'Unavailable'}
                  </div>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                  <span className="text-[10px] text-slate-500 uppercase font-semibold">Monthly Allowance</span>
                  <div className="text-sm font-bold text-indigo-300 mt-1">
                    {leaveSummary.monthlyLeaveAllowance ?? 4.0} days
                  </div>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                  <span className="text-[10px] text-slate-500 uppercase font-semibold">Monthly Leave Used</span>
                  <div className="text-sm font-bold text-slate-200 mt-1">
                    {leaveSummary.monthApprovedDays ?? leaveSummary.approvedDays} days
                  </div>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                  <span className="text-[10px] text-slate-500 uppercase font-semibold">Remaining Leave</span>
                  <div className="text-sm font-bold text-emerald-400 mt-1">
                    {leaveSummary.monthRemainingLeave ?? 4} days
                  </div>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                  <span className="text-[10px] text-slate-500 uppercase font-semibold">Daily Salary Rate</span>
                  <div className="text-sm font-bold text-slate-200 mt-1">
                    {leaveSummary.dailySalaryRate ? `$${leaveSummary.dailySalaryRate}` : '--'}
                    <span className="text-[10px] text-slate-500 font-normal ml-1">/ 30d</span>
                  </div>
                </div>

                <div className="bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                  <span className="text-[10px] text-slate-500 uppercase font-semibold">Hourly Salary Rate</span>
                  <div className="text-sm font-bold text-slate-200 mt-1">
                    {leaveSummary.hourlySalaryRate ? `$${leaveSummary.hourlySalaryRate}` : '--'}
                    <span className="text-[10px] text-slate-500 font-normal ml-1">/ hr</span>
                  </div>
                </div>
              </div>

              {/* Deductions Breakdown Box */}
              <div className="bg-slate-950 p-4 rounded-lg border border-slate-800 space-y-3">
                <div className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                  <span>Payroll Deductions Computation</span>
                  <span className="text-[11px] text-slate-500">Non-duplication policy enforced</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="p-3 bg-slate-900/60 rounded border border-slate-800/60 flex justify-between items-center">
                    <div>
                      <div className="text-[11px] text-slate-400">Excess Leave Deduction</div>
                      <div className="text-[10px] text-slate-500">
                        {leaveSummary.monthlyExcessLeaveDays ?? 0} excess day(s) × Daily Rate
                      </div>
                    </div>
                    <div className="text-sm font-bold text-rose-400">
                      ${leaveSummary.excessLeaveDeduction || '0.00'}
                    </div>
                  </div>

                  <div className="p-3 bg-slate-900/60 rounded border border-slate-800/60 flex justify-between items-center">
                    <div>
                      <div className="text-[11px] text-slate-400">Short-Hours Deduction</div>
                      <div className="text-[10px] text-slate-500">
                        {leaveSummary.deductibleShortHours ?? 0} hrs × Hourly Rate
                      </div>
                    </div>
                    <div className="text-sm font-bold text-rose-400">
                      ${leaveSummary.shortHoursDeduction || '0.00'}
                    </div>
                  </div>

                  <div className="p-3 bg-slate-900/80 rounded border border-rose-900/40 flex justify-between items-center">
                    <div>
                      <div className="text-[11px] text-slate-300 font-medium">Total Deductions</div>
                      <div className="text-[10px] text-slate-500">Excess Leave + Short Hours</div>
                    </div>
                    <div className="text-base font-extrabold text-rose-400">
                      ${leaveSummary.totalSalaryDeductions || '0.00'}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Leave Requests Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-white">Your Leave Applications</h2>
                <p className="text-xs text-slate-400">
                  Review historical requests, current approvals, and manager feedback.
                </p>
              </div>
              <span className="text-xs text-slate-500 font-mono">
                {leaveRequests.length} record(s)
              </span>
            </div>

            {isLoadingLeave ? (
              <div className="py-12 flex justify-center">
                <LoadingSpinner />
              </div>
            ) : leaveRequests.length === 0 ? (
              <div className="py-10">
                <EmptyState
                  title="No leave applications found"
                  description="You have not submitted any leave requests for this period."
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-950/50 text-slate-400 uppercase tracking-wider text-[11px]">
                      <th className="py-3 px-4">Leave Type</th>
                      <th className="py-3 px-4">Duration</th>
                      <th className="py-3 px-4">Days</th>
                      <th className="py-3 px-4">Reason</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Review Remarks</th>
                      <th className="py-3 px-4">Applied Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300">
                    {leaveRequests.map((req) => (
                      <tr key={req.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-3 px-4">
                          <span className="font-semibold text-slate-200">
                            {req.leaveTypeName || req.leaveTypeCode}
                          </span>
                          <span className="block text-[10px] text-slate-500 font-mono">
                            {req.leaveTypeCode}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-300">
                          {req.startDate} <span className="text-slate-600">to</span> {req.endDate}
                        </td>
                        <td className="py-3 px-4 font-semibold text-slate-200">
                          {req.totalDays} day{req.totalDays > 1 ? 's' : ''}
                        </td>
                        <td className="py-3 px-4 text-slate-400 max-w-xs truncate" title={req.reason || ''}>
                          {req.reason || '--'}
                        </td>
                        <td className="py-3 px-4">
                          {req.status === 'APPROVED' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              <CheckCircle2 className="w-3 h-3" />
                              Approved
                            </span>
                          )}
                          {req.status === 'PENDING' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              <Clock className="w-3 h-3" />
                              Pending Review
                            </span>
                          )}
                          {req.status === 'REJECTED' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">
                              <XCircle className="w-3 h-3" />
                              Rejected
                            </span>
                          )}
                          {req.status === 'CANCELLED' && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-slate-500/10 text-slate-400 border border-slate-500/20">
                              Cancelled
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-400">
                          {req.status === 'REJECTED' ? (
                            <span className="text-rose-300 italic">{req.rejectionReason || 'No remark'}</span>
                          ) : req.reviewedByUserName ? (
                            <span className="text-[11px]">By {req.reviewedByUserName}</span>
                          ) : (
                            '--'
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-500 font-mono text-[11px]">
                          {req.createdAt ? req.createdAt.split('T')[0] : '--'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: MY PAYSLIPS & COMPENSATION                                         */}
      {/* ========================================================================= */}
      {activeTab === 'payslips' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900 border border-slate-800 p-4 rounded-xl">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-slate-400">Filter Year:</span>
              <select
                value={selectedYear}
                onChange={(e) => setSelectedYear(Number(e.target.value))}
                className="bg-slate-950 border border-slate-800 text-slate-200 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500"
              >
                <option value={2025}>2025</option>
                <option value={2026}>2026</option>
                <option value={2027}>2027</option>
              </select>

              <button
                onClick={loadPayslips}
                disabled={isLoadingPayslips}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                title="Refresh payslips"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingPayslips ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="text-xs text-slate-400">
              Official Payroll Records • Backed by General Ledger Journal Entries
            </div>
          </div>

          {payslipsError && (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{payslipsError}</span>
            </div>
          )}

          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-white">Compensation Payslip History</h2>
                <p className="text-xs text-slate-400">
                  Click on any payslip to inspect full line item breakdown and print official voucher.
                </p>
              </div>
              <span className="text-xs text-slate-500 font-mono">
                {payslips.length} payslip(s)
              </span>
            </div>

            {isLoadingPayslips ? (
              <div className="py-12 flex justify-center">
                <LoadingSpinner />
              </div>
            ) : payslips.length === 0 ? (
              <div className="py-10">
                <EmptyState
                  title="No payslips available"
                  description="No approved payslips have been released for this fiscal year yet."
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-950/50 text-slate-400 uppercase tracking-wider text-[11px]">
                      <th className="py-3 px-4">Period</th>
                      <th className="py-3 px-4">Gross Salary</th>
                      <th className="py-3 px-4">Allowances</th>
                      <th className="py-3 px-4">Deductions</th>
                      <th className="py-3 px-4">LOP Deduction</th>
                      <th className="py-3 px-4">Net Payout</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Voucher</th>
                      <th className="py-3 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300">
                    {payslips.map((ps) => (
                      <tr key={ps.id} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-3 px-4 font-semibold text-slate-200">
                          {ps.payrollPeriodName || `${ps.payrollPeriodYear}-${String(ps.payrollPeriodMonth).padStart(2, '0')}`}
                        </td>
                        <td className="py-3 px-4 font-mono">${ps.grossSalary}</td>
                        <td className="py-3 px-4 font-mono text-emerald-400">+${ps.allowances}</td>
                        <td className="py-3 px-4 font-mono text-rose-400">-${ps.deductions}</td>
                        <td className="py-3 px-4 font-mono text-amber-400">
                          {parseFloat(ps.lossOfPayDeduction) > 0 ? `-$${ps.lossOfPayDeduction}` : '$0.00'}
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-white text-sm">
                          ${ps.netSalary}
                        </td>
                        <td className="py-3 px-4">
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            {ps.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-400 font-mono text-[11px]">
                          {ps.journalVoucherNumber || '--'}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <button
                            onClick={() => setSelectedPayslip(ps)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-indigo-300 hover:text-white rounded-lg text-xs font-medium transition-colors"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            View Voucher
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: SALARY ADVANCES (STAGE 2 DESIGN & INTERACTIVE PREVIEW)             */}
      {/* ========================================================================= */}
      {activeTab === 'advances' && (
        <div className="space-y-6">
          {/* Informational Banner */}
          <div className="bg-amber-950/40 border border-amber-600/40 rounded-xl p-5 text-xs text-amber-200 space-y-2">
            <div className="flex items-center gap-2 font-bold text-amber-100 text-sm">
              <ShieldAlert className="w-4 h-4 text-amber-400" />
              Stage 2 Proposed Relational Architecture — Salary Advance Workflow
            </div>
            <p className="text-amber-300/90 leading-relaxed">
              In accordance with ERP accounting integrity standards, salary advances are NOT stored in arbitrary JSON or Payslip text.
              A dedicated relational model (<code className="bg-amber-900/60 px-1 py-0.5 rounded font-mono text-amber-200">SalaryAdvance</code>)
              has been architected for Stage 2 to ensure:
            </p>
            <ul className="list-disc list-inside space-y-1 text-amber-300/80 ml-2">
              <li>Strict status lifecycle: <span className="font-mono text-amber-200">PENDING_APPROVAL → DISBURSED → REPAID</span></li>
              <li>Only <strong>DISBURSED</strong> advances can be scheduled for payroll deduction (prevents premature clawbacks).</li>
              <li>Atomic single-repayment tracking ensures an advance cannot be deducted twice across payroll cycles.</li>
              <li>Integration with double-entry accounting: Debit Employee Advance Asset, Credit Cash/Bank.</li>
            </ul>
          </div>

          <div className="flex items-center justify-between bg-slate-900 border border-slate-800 p-4 rounded-xl">
            <div>
              <h2 className="text-sm font-bold text-white">Salary Advance Requests</h2>
              <p className="text-xs text-slate-400">
                Interactive preview of employee advance application and repayment tracking.
              </p>
            </div>
            <button
              onClick={() => setIsAdvanceModalOpen(true)}
              className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-sm transition-all shadow-amber-600/30"
            >
              <Plus className="w-4 h-4" />
              Request Salary Advance (Demo)
            </button>
          </div>

          {/* Advances Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/50 text-slate-400 uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4">Advance ID</th>
                  <th className="py-3 px-4">Amount</th>
                  <th className="py-3 px-4">Repayment Schedule</th>
                  <th className="py-3 px-4">Reason</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Disbursed Date</th>
                  <th className="py-3 px-4">Accounting Audit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300">
                {salaryAdvances.map((adv) => (
                  <tr key={adv.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 px-4 font-mono font-semibold text-slate-200">
                      {adv.id}
                    </td>
                    <td className="py-3 px-4 font-mono font-bold text-amber-300 text-sm">
                      ${adv.amount.toFixed(2)}
                    </td>
                    <td className="py-3 px-4 text-slate-300">
                      ${adv.monthlyDeduction.toFixed(2)}/mo × {adv.repaymentMonths} mo
                    </td>
                    <td className="py-3 px-4 text-slate-400 max-w-xs truncate" title={adv.reason}>
                      {adv.reason}
                    </td>
                    <td className="py-3 px-4">
                      {adv.status === 'DISBURSED' && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          <CheckCircle2 className="w-3 h-3" />
                          Disbursed (Active)
                        </span>
                      )}
                      {adv.status === 'PENDING_APPROVAL' && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          <Clock className="w-3 h-3" />
                          Pending Review
                        </span>
                      )}
                      {adv.status === 'REPAID' && (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                          Repaid via Payroll
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-400 font-mono text-[11px]">
                      {adv.disbursedDate || 'Awaiting disbursement'}
                    </td>
                    <td className="py-3 px-4">
                      <span className="text-[10px] font-mono px-2 py-0.5 bg-slate-800 text-slate-400 rounded">
                        In-Memory Simulation
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 4: EXPENSE CLAIMS & REIMBURSEMENTS (PRODUCTION DATABASE-BACKED)       */}
      {/* ========================================================================= */}
      {activeTab === 'expenses' && (
        <ExpenseModuleView currentUser={currentUser} />
      )}

      {/* ========================================================================= */}
      {/* MODAL: APPLY FOR LEAVE                                                    */}
      {/* ========================================================================= */}
      {isApplyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <CalendarCheck className="w-5 h-5 text-indigo-400" />
                <h3 className="text-base font-bold text-white">Apply for Leave</h3>
              </div>
              <button
                onClick={() => setIsApplyModalOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {applyError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-lg text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{applyError}</span>
              </div>
            )}

            {applySuccess && (
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 rounded-lg text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{applySuccess}</span>
              </div>
            )}

            <form onSubmit={handleApplyLeave} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1.5">
                  Leave Type Category *
                </label>
                <select
                  value={applyLeaveTypeId}
                  onChange={(e) => setApplyLeaveTypeId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:border-indigo-500 focus:outline-none"
                  required
                >
                  {leaveTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.code}) • {t.isPaid ? 'Paid' : 'Unpaid'} ({t.defaultAllowance} days allowance)
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-300 font-medium mb-1.5">
                    Start Date *
                  </label>
                  <input
                    type="date"
                    value={applyStartDate}
                    onChange={(e) => setApplyStartDate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:border-indigo-500 focus:outline-none"
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-medium mb-1.5">
                    End Date *
                  </label>
                  <input
                    type="date"
                    value={applyEndDate}
                    onChange={(e) => setApplyEndDate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:border-indigo-500 focus:outline-none"
                    required
                  />
                </div>
              </div>

              <div className="p-3 bg-slate-950 border border-slate-800/80 rounded-lg flex items-center justify-between">
                <span className="text-slate-400">Calculated Working Days:</span>
                <span className="text-sm font-bold text-indigo-300 font-mono">
                  {applyTotalDays} Day{applyTotalDays > 1 ? 's' : ''}
                </span>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1.5">
                  Reason for Absence
                </label>
                <textarea
                  value={applyReason}
                  onChange={(e) => setApplyReason(e.target.value)}
                  placeholder="Please state the reason for your leave request..."
                  rows={3}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsApplyModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingLeave}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-all flex items-center gap-1.5"
                >
                  {isSubmittingLeave ? <LoadingSpinner /> : 'Submit Application'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: PAYSLIP VOUCHER DETAIL                                             */}
      {/* ========================================================================= */}
      {selectedPayslip && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 space-y-6 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-indigo-400" />
                <div>
                  <h3 className="text-base font-bold text-white">Employee Compensation Voucher</h3>
                  <p className="text-xs text-slate-400">
                    Period: {selectedPayslip.payrollPeriodName} • Voucher #{selectedPayslip.journalVoucherNumber || 'N/A'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedPayslip(null)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Employee Information Header */}
            <div className="bg-slate-950 border border-slate-800 p-4 rounded-xl grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
              <div>
                <span className="text-slate-500 block text-[10px]">EMPLOYEE NAME</span>
                <span className="font-semibold text-slate-200">{selectedPayslip.employeeName}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px]">EMPLOYEE CODE</span>
                <span className="font-mono text-slate-200">{selectedPayslip.employeeCode}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px]">PAYMENT DATE</span>
                <span className="text-slate-200">{selectedPayslip.paymentDate || 'Processed'}</span>
              </div>
              <div>
                <span className="text-slate-500 block text-[10px]">STATUS</span>
                <span className="text-emerald-400 font-semibold">{selectedPayslip.status}</span>
              </div>
            </div>

            {/* Breakdown Columns */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              {/* Earnings */}
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2.5">
                <h4 className="font-bold text-slate-300 uppercase tracking-wider text-[11px] pb-2 border-b border-slate-800/80">
                  Gross Earnings
                </h4>
                <div className="flex justify-between text-slate-400">
                  <span>Basic Fixed Salary:</span>
                  <span className="font-mono text-slate-200">${selectedPayslip.basicSalary}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Allowances:</span>
                  <span className="font-mono text-emerald-400">+${selectedPayslip.allowances}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Overtime Pay:</span>
                  <span className="font-mono text-emerald-400">+${selectedPayslip.overtimePay}</span>
                </div>
                <div className="pt-2 border-t border-slate-800 flex justify-between font-bold text-slate-200">
                  <span>Total Gross Earnings:</span>
                  <span className="font-mono">${selectedPayslip.grossSalary}</span>
                </div>
              </div>

              {/* Deductions */}
              <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2.5">
                <h4 className="font-bold text-slate-300 uppercase tracking-wider text-[11px] pb-2 border-b border-slate-800/80">
                  Statutory & LOP Deductions
                </h4>
                <div className="flex justify-between text-slate-400">
                  <span>Loss of Pay (LOP):</span>
                  <span className="font-mono text-rose-400">-${selectedPayslip.lossOfPayDeduction}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Other Deductions:</span>
                  <span className="font-mono text-rose-400">-${selectedPayslip.deductions}</span>
                </div>
                <div className="pt-2 border-t border-slate-800 flex justify-between font-bold text-slate-200">
                  <span>Total Deductions:</span>
                  <span className="font-mono text-rose-300">
                    -${(parseFloat(selectedPayslip.deductions) + parseFloat(selectedPayslip.lossOfPayDeduction)).toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            {/* Net Salary Summary */}
            <div className="bg-emerald-950/40 border border-emerald-500/30 rounded-xl p-4 flex items-center justify-between">
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400">
                  Net Disbursed Compensation
                </span>
                <p className="text-xs text-emerald-200/70">Credited to employee bank account / ledger</p>
              </div>
              <div className="text-3xl font-extrabold text-white font-mono">
                ${selectedPayslip.netSalary}
              </div>
            </div>

            <div className="flex justify-between items-center pt-3 border-t border-slate-800">
              <span className="text-[11px] text-slate-500 font-mono">
                Ledger: {selectedPayslip.ledgerName || 'Payroll Payable Clearing'}
              </span>
              <button
                onClick={() => window.print()}
                className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-all"
              >
                <Printer className="w-4 h-4" />
                Print Voucher
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL: REQUEST SALARY ADVANCE (DEMO SIMULATION)                          */}
      {/* ========================================================================= */}
      {isAdvanceModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-amber-400" />
                <h3 className="text-base font-bold text-white">Request Salary Advance</h3>
              </div>
              <button
                onClick={() => setIsAdvanceModalOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-amber-300/80 bg-amber-950/40 p-3 rounded-lg border border-amber-800/40">
              Note: This is an interactive preview demonstration for Stage 2. Submitted requests are in-memory and will not alter production balances.
            </p>

            <form onSubmit={handleApplyAdvance} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-medium mb-1">
                  Requested Advance Amount ($) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="50"
                  max="5000"
                  value={advanceAmount}
                  onChange={(e) => setAdvanceAmount(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 font-mono focus:border-amber-500 focus:outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">
                  Repayment Duration (Months) *
                </label>
                <select
                  value={advanceMonths}
                  onChange={(e) => setAdvanceMonths(Number(e.target.value))}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:border-amber-500 focus:outline-none"
                >
                  <option value={1}>1 Month (Full deduction on next payroll)</option>
                  <option value={2}>2 Months (50% deduction per cycle)</option>
                  <option value={3}>3 Months (Equal monthly installments)</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">
                  Reason for Advance Request *
                </label>
                <textarea
                  value={advanceReason}
                  onChange={(e) => setAdvanceReason(e.target.value)}
                  rows={3}
                  className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:border-amber-500 focus:outline-none"
                  required
                />
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsAdvanceModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-semibold shadow-sm"
                >
                  Submit Demo Request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}


    </div>
  );
};
