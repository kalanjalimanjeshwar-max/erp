import React, { useState, useEffect, useCallback } from 'react';
import {
  FileText,
  Plus,
  Filter,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  XCircle,
  X,
  Info,
  Calendar,
  Check,
  PowerOff,
  Edit2,
  Clock,
  Layers,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { LoadingSpinner } from '../components/common/LoadingSpinner.tsx';
import { EmptyState } from '../components/common/EmptyState.tsx';
import {
  AuthUser,
  LeaveRequestItem,
  LeaveTypeItem,
  LeaveStatus,
  EmployeeItem,
  CreateLeaveRequestInput,
  CreateLeaveTypeRequest,
  UpdateLeaveTypeRequest,
} from '../../shared/types.ts';

interface LeavePageProps {
  currentUser: AuthUser;
}

export const LeavePage: React.FC<LeavePageProps> = ({ currentUser }) => {
  const isEmployee = currentUser.role === 'EMPLOYEE';
  const [activeTab, setActiveTab] = useState<'requests' | 'types'>('requests');

  // Leave Requests State
  const [requests, setRequests] = useState<LeaveRequestItem[]>([]);
  const [requestsTotal, setRequestsTotal] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [limit] = useState<number>(20);
  const [isLoadingRequests, setIsLoadingRequests] = useState<boolean>(true);
  const [requestsError, setRequestsError] = useState<string | null>(null);

  // Filters
  const [filterEmployeeId, setFilterEmployeeId] = useState<string>('');
  const [filterLeaveTypeId, setFilterLeaveTypeId] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');

  // Leave Types State
  const [leaveTypes, setLeaveTypes] = useState<LeaveTypeItem[]>([]);
  const [isLoadingTypes, setIsLoadingTypes] = useState<boolean>(false);
  const [typesError, setTypesError] = useState<string | null>(null);

  // Employees lookup for manager filtering
  const [employees, setEmployees] = useState<EmployeeItem[]>([]);

  // Modals
  const [isSubmitModalOpen, setIsSubmitModalOpen] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Submit Request Form
  const [formLeaveTypeId, setFormLeaveTypeId] = useState<string>('');
  const [formStartDate, setFormStartDate] = useState<string>('');
  const [formEndDate, setFormEndDate] = useState<string>('');
  const [formReason, setFormReason] = useState<string>('');

  // Manager Reject Modal
  const [rejectingRequestId, setRejectingRequestId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string>('');
  const [rejectionError, setRejectionError] = useState<string | null>(null);
  const [isSubmittingRejection, setIsSubmittingRejection] = useState<boolean>(false);

  // Leave Type Create/Edit Modal
  const [isTypeModalOpen, setIsTypeModalOpen] = useState<boolean>(false);
  const [editingType, setEditingType] = useState<LeaveTypeItem | null>(null);
  const [typeFormError, setTypeFormError] = useState<string | null>(null);
  const [isSubmittingType, setIsSubmittingType] = useState<boolean>(false);

  // Type form fields
  const [typeCode, setTypeCode] = useState<string>('');
  const [typeName, setTypeName] = useState<string>('');
  const [typeDescription, setTypeDescription] = useState<string>('');
  const [typeIsPaid, setTypeIsPaid] = useState<boolean>(true);
  const [typeDefaultAllowance, setTypeDefaultAllowance] = useState<number>(14);

  // Load Leave Types
  const loadLeaveTypes = useCallback(async () => {
    setIsLoadingTypes(true);
    setTypesError(null);
    try {
      const data = await api.getLeaveTypes(true);
      setLeaveTypes(data);
    } catch (err: unknown) {
      setTypesError((err as Error).message || 'Failed to load leave types.');
    } finally {
      setIsLoadingTypes(false);
    }
  }, []);

  // Load Employees for manager view
  const loadEmployees = useCallback(async () => {
    if (isEmployee) return;
    try {
      const res = await api.getEmployees({ limit: 100, status: 'ACTIVE' });
      setEmployees(res.items);
    } catch {
      // Safe fallback
    }
  }, [isEmployee]);

  // Load Requests
  const loadRequests = useCallback(async () => {
    setIsLoadingRequests(true);
    setRequestsError(null);
    try {
      const res = await api.getLeaveRequests({
        employeeId: !isEmployee && filterEmployeeId ? filterEmployeeId : undefined,
        leaveTypeId: filterLeaveTypeId || undefined,
        status: (filterStatus as LeaveStatus) || undefined,
        startDate: filterStartDate || undefined,
        endDate: filterEndDate || undefined,
        page,
        limit,
      });
      setRequests(res.items);
      setRequestsTotal(res.total);
    } catch (err: unknown) {
      setRequestsError((err as Error).message || 'Failed to load leave requests.');
    } finally {
      setIsLoadingRequests(false);
    }
  }, [isEmployee, filterEmployeeId, filterLeaveTypeId, filterStatus, filterStartDate, filterEndDate, page, limit]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  useEffect(() => {
    loadLeaveTypes();
    loadEmployees();
  }, [loadLeaveTypes, loadEmployees]);

  // Calculate day difference between start and end date
  const calculateDays = (start: string, end: string): number => {
    if (!start || !end) return 0;
    const s = new Date(start);
    const e = new Date(end);
    if (isNaN(s.getTime()) || isNaN(e.getTime()) || s > e) return 0;
    const diffTime = e.getTime() - s.getTime();
    return Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;
  };

  // Submit Leave Request
  const handleOpenSubmit = () => {
    const activeTypes = leaveTypes.filter((t) => t.isActive);
    setFormLeaveTypeId(activeTypes.length > 0 ? activeTypes[0].id : '');
    const today = new Date().toISOString().split('T')[0];
    setFormStartDate(today);
    setFormEndDate(today);
    setFormReason('');
    setSubmitError(null);
    setIsSubmitModalOpen(true);
  };

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    if (!formLeaveTypeId) {
      setSubmitError('Please select a leave type.');
      return;
    }
    if (!formStartDate || !formEndDate) {
      setSubmitError('Start date and end date are required.');
      return;
    }
    if (formStartDate > formEndDate) {
      setSubmitError('Start date cannot be after end date.');
      return;
    }

    setIsSubmitting(true);
    try {
      const payload: CreateLeaveRequestInput = {
        leaveTypeId: formLeaveTypeId,
        startDate: formStartDate,
        endDate: formEndDate,
        reason: formReason.trim() || null,
      };
      await api.submitLeaveRequest(payload);
      setIsSubmitModalOpen(false);
      loadRequests();
    } catch (err: unknown) {
      setSubmitError((err as Error).message || 'Failed to submit leave request.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Manager Approve
  const handleApprove = async (request: LeaveRequestItem) => {
    if (!confirm(`Approve leave request for ${request.employeeName} (${request.startDate} to ${request.endDate})?`)) {
      return;
    }
    try {
      await api.approveLeaveRequest(request.id);
      loadRequests();
    } catch (err: unknown) {
      alert((err as Error).message || 'Failed to approve leave request.');
    }
  };

  // Manager Reject
  const handleOpenReject = (request: LeaveRequestItem) => {
    setRejectingRequestId(request.id);
    setRejectionReason('');
    setRejectionError(null);
  };

  const handleConfirmReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectingRequestId) return;
    if (!rejectionReason.trim()) {
      setRejectionError('Rejection reason is mandatory.');
      return;
    }

    setIsSubmittingRejection(true);
    setRejectionError(null);
    try {
      await api.rejectLeaveRequest(rejectingRequestId, {
        rejectionReason: rejectionReason.trim(),
      });
      setRejectingRequestId(null);
      loadRequests();
    } catch (err: unknown) {
      setRejectionError((err as Error).message || 'Failed to reject leave request.');
    } finally {
      setIsSubmittingRejection(false);
    }
  };

  // Leave Type Create/Edit
  const handleOpenCreateType = () => {
    setEditingType(null);
    setTypeCode('');
    setTypeName('');
    setTypeDescription('');
    setTypeIsPaid(true);
    setTypeDefaultAllowance(14);
    setTypeFormError(null);
    setIsTypeModalOpen(true);
  };

  const handleOpenEditType = (type: LeaveTypeItem) => {
    setEditingType(type);
    setTypeCode(type.code);
    setTypeName(type.name);
    setTypeDescription(type.description || '');
    setTypeIsPaid(type.isPaid);
    setTypeDefaultAllowance(type.defaultAllowance);
    setTypeFormError(null);
    setIsTypeModalOpen(true);
  };

  const handleSaveType = async (e: React.FormEvent) => {
    e.preventDefault();
    setTypeFormError(null);
    setIsSubmittingType(true);

    try {
      if (editingType) {
        const updateData: UpdateLeaveTypeRequest = {
          code: typeCode.trim().toUpperCase(),
          name: typeName.trim(),
          description: typeDescription.trim() || null,
          isPaid: typeIsPaid,
          defaultAllowance: Number(typeDefaultAllowance),
        };
        await api.updateLeaveType(editingType.id, updateData);
      } else {
        const createData: CreateLeaveTypeRequest = {
          code: typeCode.trim().toUpperCase(),
          name: typeName.trim(),
          description: typeDescription.trim() || null,
          isPaid: typeIsPaid,
          defaultAllowance: Number(typeDefaultAllowance),
        };
        await api.createLeaveType(createData);
      }

      setIsTypeModalOpen(false);
      loadLeaveTypes();
    } catch (err: unknown) {
      setTypeFormError((err as Error).message || 'Failed to save leave type.');
    } finally {
      setIsSubmittingType(false);
    }
  };

  const handleDeactivateType = async (type: LeaveTypeItem) => {
    if (!confirm(`Are you sure you want to deactivate leave type "${type.name}" (${type.code})? It cannot be selected for future leave applications.`)) {
      return;
    }
    try {
      await api.deactivateLeaveType(type.id);
      loadLeaveTypes();
    } catch (err: unknown) {
      alert((err as Error).message || 'Failed to deactivate leave type.');
    }
  };

  const getStatusTextClass = (status: LeaveStatus) => {
    switch (status) {
      case 'APPROVED':
        return 'text-emerald-400';
      case 'PENDING':
        return 'text-amber-400';
      case 'REJECTED':
        return 'text-rose-400';
      case 'CANCELLED':
        return 'text-slate-500';
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
            <FileText className="w-6 h-6 text-indigo-400" />
            <span>Leave Management</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            {isEmployee
              ? 'Submit and track your formal leave applications and review outcomes.'
              : 'Enterprise leave applications, manager approvals, and company policy types.'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {!isEmployee && (
            <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
              <button
                onClick={() => setActiveTab('requests')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'requests'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Leave Requests
              </button>
              <button
                onClick={() => setActiveTab('types')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === 'types'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Leave Policy Types
              </button>
            </div>
          )}

          {activeTab === 'requests' && (
            <button
              onClick={handleOpenSubmit}
              className="px-3.5 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Apply for Leave</span>
            </button>
          )}

          {activeTab === 'types' && !isEmployee && (
            <button
              onClick={handleOpenCreateType}
              className="px-3.5 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Leave Type</span>
            </button>
          )}
        </div>
      </div>

      {/* Policy Governance Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-start gap-3">
        <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
        <div className="text-xs text-slate-400 space-y-1">
          <p className="font-medium text-slate-200">Company Absence &amp; Leave Accounting Policy</p>
          <p>
            Approved leave requests are synchronized with attendance tracking and payroll deduplication engines.
            Unpaid leaves automatically calculate Loss-of-Pay (LOP) deductions during payroll processing, with strict
            safeguards preventing double deductions against absent punch records.
          </p>
        </div>
      </div>

      {/* Main Tab: Requests */}
      {activeTab === 'requests' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Filter className="w-3.5 h-3.5" />
                <span>Filters:</span>
              </div>

              {!isEmployee && (
                <div className="min-w-[160px]">
                  <select
                    value={filterEmployeeId}
                    onChange={(e) => {
                      setFilterEmployeeId(e.target.value);
                      setPage(1);
                    }}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">All Employees</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.employeeCode} · {emp.fullName}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="min-w-[140px]">
                <select
                  value={filterLeaveTypeId}
                  onChange={(e) => {
                    setFilterLeaveTypeId(e.target.value);
                    setPage(1);
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">All Leave Types</option>
                  {leaveTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.code})
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-[120px]">
                <select
                  value={filterStatus}
                  onChange={(e) => {
                    setFilterStatus(e.target.value);
                    setPage(1);
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">All Statuses</option>
                  <option value="PENDING">Pending Review</option>
                  <option value="APPROVED">Approved</option>
                  <option value="REJECTED">Rejected</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={filterStartDate}
                  onChange={(e) => {
                    setFilterStartDate(e.target.value);
                    setPage(1);
                  }}
                  placeholder="From Date"
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums"
                />
                <span className="text-slate-600 text-xs">to</span>
                <input
                  type="date"
                  value={filterEndDate}
                  onChange={(e) => {
                    setFilterEndDate(e.target.value);
                    setPage(1);
                  }}
                  placeholder="To Date"
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums"
                />
              </div>

              {(filterEmployeeId || filterLeaveTypeId || filterStatus || filterStartDate || filterEndDate) && (
                <button
                  onClick={() => {
                    setFilterEmployeeId('');
                    setFilterLeaveTypeId('');
                    setFilterStatus('');
                    setFilterStartDate('');
                    setFilterEndDate('');
                    setPage(1);
                  }}
                  className="text-xs text-slate-400 hover:text-slate-200 underline transition-colors"
                >
                  Reset
                </button>
              )}
            </div>

            <button
              onClick={loadRequests}
              disabled={isLoadingRequests}
              className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition-colors"
              title="Refresh requests"
            >
              <RefreshCw className={`w-4 h-4 ${isLoadingRequests ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {requestsError && (
            <div className="bg-rose-950/40 border border-rose-900 rounded-xl p-4 text-xs text-rose-300 flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{requestsError}</span>
            </div>
          )}

          {isLoadingRequests ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-12">
              <LoadingSpinner message="Loading leave applications..." />
            </div>
          ) : requests.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-8">
              <EmptyState
                icon={<Calendar className="w-6 h-6" />}
                title="No Leave Requests Found"
                description={
                  isEmployee
                    ? 'You have not submitted any leave requests yet.'
                    : 'No leave applications match the selected filters.'
                }
                action={
                  <button
                    onClick={handleOpenSubmit}
                    className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
                  >
                    Apply for Leave
                  </button>
                }
              />
            </div>
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="py-3 px-4 font-medium">Applied Date</th>
                      {!isEmployee && <th className="py-3 px-4 font-medium">Employee</th>}
                      <th className="py-3 px-4 font-medium">Leave Type</th>
                      <th className="py-3 px-4 font-medium">Dates (Start – End)</th>
                      <th className="py-3 px-4 font-medium">Days</th>
                      <th className="py-3 px-4 font-medium">Status</th>
                      <th className="py-3 px-4 font-medium">Reason</th>
                      <th className="py-3 px-4 font-medium">Review Details</th>
                      {!isEmployee && <th className="py-3 px-4 font-medium text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300">
                    {requests.map((req) => (
                      <tr key={req.id} className="hover:bg-slate-800/40 transition-colors">
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-400">
                          {req.createdAt.split('T')[0]}
                        </td>
                        {!isEmployee && (
                          <td className="py-3 px-4">
                            <div className="font-medium text-slate-200">{req.employeeName || '—'}</div>
                            <div className="text-[11px] text-slate-500 font-mono">{req.employeeCode}</div>
                          </td>
                        )}
                        <td className="py-3 px-4">
                          <span className="font-medium text-slate-200">{req.leaveTypeName || '—'}</span>
                          <span className="text-[11px] text-slate-500 ml-1.5 font-mono">({req.leaveTypeCode})</span>
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                          {req.startDate.split('T')[0]} <span className="text-slate-600">to</span> {req.endDate.split('T')[0]}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums font-semibold text-slate-200">
                          {req.totalDays} {req.totalDays === 1 ? 'day' : 'days'}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`font-semibold ${getStatusTextClass(req.status)}`}>
                            {req.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-400 max-w-xs truncate" title={req.reason || ''}>
                          {req.reason || '—'}
                        </td>
                        <td className="py-3 px-4 text-slate-400">
                          {req.reviewedByUserName ? (
                            <div>
                              <div className="text-slate-300">By {req.reviewedByUserName}</div>
                              {req.rejectionReason && (
                                <div className="text-rose-400 text-[11px] mt-0.5 font-medium truncate max-w-xs" title={req.rejectionReason}>
                                  Note: {req.rejectionReason}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-slate-600">Pending</span>
                          )}
                        </td>
                        {!isEmployee && (
                          <td className="py-3 px-4 text-right">
                            {req.status === 'PENDING' && (
                              <div className="flex items-center justify-end gap-1.5">
                                <button
                                  onClick={() => handleApprove(req)}
                                  className="px-2.5 py-1 text-xs font-medium text-emerald-300 bg-emerald-950/60 border border-emerald-800 rounded hover:bg-emerald-900/80 transition-colors flex items-center gap-1"
                                  title="Approve leave request"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                  <span>Approve</span>
                                </button>
                                <button
                                  onClick={() => handleOpenReject(req)}
                                  className="px-2.5 py-1 text-xs font-medium text-rose-300 bg-rose-950/60 border border-rose-800 rounded hover:bg-rose-900/80 transition-colors flex items-center gap-1"
                                  title="Reject leave request"
                                >
                                  <X className="w-3.5 h-3.5" />
                                  <span>Reject</span>
                                </button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="px-4 py-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
                <span>
                  Showing <span className="font-mono tabular-nums font-medium text-slate-200">{requests.length}</span> of{' '}
                  <span className="font-mono tabular-nums font-medium text-slate-200">{requestsTotal}</span> requests
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    Previous
                  </button>
                  <span className="font-mono tabular-nums">Page {page}</span>
                  <button
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page * limit >= requestsTotal}
                    className="px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Leave Types Management Tab */}
      {activeTab === 'types' && !isEmployee && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
            <div className="text-xs text-slate-400">
              Configure company leave policies. Paid leaves are fully compensated; unpaid leaves trigger Loss-of-Pay (LOP) calculations.
            </div>
            <button
              onClick={loadLeaveTypes}
              disabled={isLoadingTypes}
              className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition-colors"
              title="Refresh leave types"
            >
              <RefreshCw className={`w-4 h-4 ${isLoadingTypes ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {typesError && (
            <div className="bg-rose-950/40 border border-rose-900 rounded-xl p-4 text-xs text-rose-300 flex items-center gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{typesError}</span>
            </div>
          )}

          {isLoadingTypes ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-12">
              <LoadingSpinner message="Loading leave policies..." />
            </div>
          ) : leaveTypes.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-8">
              <EmptyState
                icon={<Layers className="w-6 h-6" />}
                title="No Leave Types Configured"
                description="Establish company leave categories (e.g. Annual, Sick, Unpaid LOP) to allow employees to request time off."
                action={
                  <button
                    onClick={handleOpenCreateType}
                    className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors"
                  >
                    Create Leave Type
                  </button>
                }
              />
            </div>
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4 font-medium">Code</th>
                    <th className="py-3 px-4 font-medium">Leave Policy Name</th>
                    <th className="py-3 px-4 font-medium">Compensation Type</th>
                    <th className="py-3 px-4 font-medium">Default Allowance</th>
                    <th className="py-3 px-4 font-medium">Description</th>
                    <th className="py-3 px-4 font-medium">Status</th>
                    <th className="py-3 px-4 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {leaveTypes.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-3 px-4 font-mono font-semibold text-indigo-300">{t.code}</td>
                      <td className="py-3 px-4 font-medium text-slate-200">{t.name}</td>
                      <td className="py-3 px-4">
                        <span className={`font-semibold ${t.isPaid ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {t.isPaid ? 'Paid Leave' : 'Unpaid (Loss-of-Pay)'}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                        {t.defaultAllowance} days / yr
                      </td>
                      <td className="py-3 px-4 text-slate-400 max-w-sm truncate" title={t.description || ''}>
                        {t.description || '—'}
                      </td>
                      <td className="py-3 px-4">
                        <span className={`font-semibold ${t.isActive ? 'text-emerald-400' : 'text-slate-500'}`}>
                          {t.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleOpenEditType(t)}
                            className="p-1 text-slate-400 hover:text-indigo-400 transition-colors rounded hover:bg-slate-800"
                            title="Edit Leave Type"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          {t.isActive && (
                            <button
                              onClick={() => handleDeactivateType(t)}
                              className="p-1 text-slate-400 hover:text-rose-400 transition-colors rounded hover:bg-slate-800"
                              title="Deactivate Leave Type"
                            >
                              <PowerOff className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Apply Leave Modal */}
      {isSubmitModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-400" />
                <span>Submit Leave Application</span>
              </h3>
              <button
                onClick={() => setIsSubmitModalOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {submitError && (
              <div className="bg-rose-950/40 border border-rose-900 rounded-lg p-3 text-xs text-rose-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{submitError}</span>
              </div>
            )}

            <form onSubmit={handleSubmitRequest} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Leave Policy Type *</label>
                <select
                  value={formLeaveTypeId}
                  onChange={(e) => setFormLeaveTypeId(e.target.value)}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                >
                  <option value="" disabled>
                    Select Leave Type
                  </option>
                  {leaveTypes
                    .filter((t) => t.isActive)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.code}) — {t.isPaid ? 'Paid' : 'Unpaid LOP'}
                      </option>
                    ))}
                </select>
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

              {formStartDate && formEndDate && (
                <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-xs flex items-center justify-between">
                  <span className="text-slate-400">Total requested duration:</span>
                  <span className="font-mono font-bold text-indigo-300 tabular-nums">
                    {calculateDays(formStartDate, formEndDate)} calendar days
                  </span>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Reason for Leave</label>
                <textarea
                  value={formReason}
                  onChange={(e) => setFormReason(e.target.value)}
                  placeholder="Provide brief details regarding this time-off request..."
                  rows={3}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsSubmitModalOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition disabled:opacity-50"
                >
                  {isSubmitting ? 'Submitting...' : 'Submit Application'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {rejectingRequestId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-rose-400 flex items-center gap-2">
                <XCircle className="w-4 h-4" />
                <span>Reject Leave Request</span>
              </h3>
              <button
                onClick={() => setRejectingRequestId(null)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {rejectionError && (
              <div className="bg-rose-950/40 border border-rose-900 rounded-lg p-3 text-xs text-rose-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{rejectionError}</span>
              </div>
            )}

            <form onSubmit={handleConfirmReject} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Reason for Rejection * (Mandatory)
                </label>
                <textarea
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="Explain why this request is rejected..."
                  rows={3}
                  required
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setRejectingRequestId(null)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingRejection}
                  className="px-4 py-2 text-xs font-medium text-white bg-rose-600 hover:bg-rose-500 rounded-lg transition disabled:opacity-50"
                >
                  {isSubmittingRejection ? 'Rejecting...' : 'Confirm Rejection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Leave Type Modal */}
      {isTypeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Layers className="w-4 h-4 text-indigo-400" />
                <span>{editingType ? 'Edit Leave Type' : 'Create Leave Type'}</span>
              </h3>
              <button
                onClick={() => setIsTypeModalOpen(false)}
                className="text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {typeFormError && (
              <div className="bg-rose-950/40 border border-rose-900 rounded-lg p-3 text-xs text-rose-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{typeFormError}</span>
              </div>
            )}

            <form onSubmit={handleSaveType} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Code *</label>
                  <input
                    type="text"
                    value={typeCode}
                    onChange={(e) => setTypeCode(e.target.value)}
                    placeholder="e.g. SICK"
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono uppercase"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Name *</label>
                  <input
                    type="text"
                    value={typeName}
                    onChange={(e) => setTypeName(e.target.value)}
                    placeholder="e.g. Sick Leave"
                    required
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Compensation</label>
                  <div className="flex items-center gap-2 pt-1.5">
                    <input
                      type="checkbox"
                      id="isPaidType"
                      checked={typeIsPaid}
                      onChange={(e) => setTypeIsPaid(e.target.checked)}
                      className="rounded border-slate-800 bg-slate-950 text-indigo-600 focus:ring-0"
                    />
                    <label htmlFor="isPaidType" className="text-xs text-slate-300 cursor-pointer">
                      Paid Leave (no LOP deduction)
                    </label>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Default Allowance (Days)</label>
                  <input
                    type="number"
                    min="0"
                    max="365"
                    value={typeDefaultAllowance}
                    onChange={(e) => setTypeDefaultAllowance(parseInt(e.target.value, 10) || 0)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 font-mono tabular-nums"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Description / Policy Details</label>
                <textarea
                  value={typeDescription}
                  onChange={(e) => setTypeDescription(e.target.value)}
                  placeholder="Optional details on eligibility and submission guidelines..."
                  rows={2}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsTypeModalOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 rounded-lg transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingType}
                  className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition disabled:opacity-50"
                >
                  {isSubmittingType ? 'Saving...' : editingType ? 'Save Policy' : 'Create Policy'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
