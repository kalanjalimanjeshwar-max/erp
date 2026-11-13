import React, { useState, useEffect, useCallback, useId } from 'react';
import {
  Receipt,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Clock,
  XCircle,
  X,
  FileText,
  DollarSign,
  Upload,
  ArrowRight,
  Eye,
  Send,
  CornerDownLeft,
  Check,
  Ban,
  Filter,
  Search,
  Calendar,
  Building,
  UserCheck,
  CreditCard,
  Download,
} from 'lucide-react';
import { api, ApiError } from '../../services/api.ts';
import { LoadingSpinner } from '../common/LoadingSpinner.tsx';
import { EmptyState } from '../common/EmptyState.tsx';
import {
  AuthUser,
  ExpenseCategory,
  ExpenseClaimItem,
  ExpenseClaimStatus,
  ExpensePaymentMethod,
  CreateExpenseClaimLineInput,
  ExpenseSummaryReport,
  ExpenseCapabilitiesResponse,
  AccountLedgerItem,
  CompanyBankAccountItem,
  EmployeeItem,
} from '../../../shared/types.ts';

interface ExpenseModuleViewProps {
  currentUser: AuthUser;
}

const CATEGORIES: Array<{ value: ExpenseCategory; label: string }> = [
  { value: 'TRAVEL', label: 'Travel & Transportation' },
  { value: 'MEALS', label: 'Meals & Hospitality' },
  { value: 'LODGING', label: 'Lodging & Hotel' },
  { value: 'OFFICE_SUPPLIES', label: 'Office Supplies & Equipment' },
  { value: 'COMMUNICATION', label: 'Communication & Internet' },
  { value: 'SOFTWARE', label: 'Software & Subscriptions' },
  { value: 'TRAINING', label: 'Professional Training & Certifications' },
  { value: 'OTHER', label: 'Other Operating Expenses' },
];

const DEFAULT_CAPABILITIES: ExpenseCapabilitiesResponse = {
  canManagerApprove: false,
  canAccountsApprove: false,
  canViewAccounting: false,
  canViewCompanyBankAccounts: false,
  canViewEmployees: false,
  currentEmployeeId: null,
};

export const ExpenseModuleView: React.FC<ExpenseModuleViewProps> = ({ currentUser }) => {
  const [capabilities, setCapabilities] = useState<ExpenseCapabilitiesResponse>(DEFAULT_CAPABILITIES);
  const [ledgers, setLedgers] = useState<AccountLedgerItem[]>([]);
  const [bankAccounts, setBankAccounts] = useState<CompanyBankAccountItem[]>([]);
  const [employees, setEmployees] = useState<EmployeeItem[]>([]);

  // Sub-tab queue view: 'my' (My claims), 'manager' (Manager review queue), 'accounts' (Accounts & payout queue)
  const [activeQueue, setActiveQueue] = useState<'my' | 'manager' | 'accounts'>('my');
  const [claims, setClaims] = useState<ExpenseClaimItem[]>([]);
  const [summaryReport, setSummaryReport] = useState<ExpenseSummaryReport | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // New / Edit Claim Modal State
  const [isNewModalOpen, setIsNewModalOpen] = useState<boolean>(false);
  const [editingClaimId, setEditingClaimId] = useState<string | null>(null);
  const [claimTitle, setClaimTitle] = useState<string>('');
  const [claimDescription, setClaimDescription] = useState<string>('');
  const [selectedManagerId, setSelectedManagerId] = useState<string>('');
  const [originalExpenseDate, setOriginalExpenseDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [claimLines, setClaimLines] = useState<
    Array<{
      category: ExpenseCategory;
      description: string;
      expenseDate: string;
      amount: string;
      merchant: string;
      expenseLedgerId?: string;
      attachmentId?: string;
      attachmentFileName?: string;
    }>
  >([
    {
      category: 'TRAVEL',
      description: '',
      expenseDate: new Date().toISOString().slice(0, 10),
      amount: '',
      merchant: '',
    },
  ]);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Detail & Action Modal State
  const [selectedClaim, setSelectedClaim] = useState<ExpenseClaimItem | null>(null);
  const [actionNotes, setActionNotes] = useState<string>('');
  const [selectedExpenseLedgerId, setSelectedExpenseLedgerId] = useState<string>('');
  const [selectedPayableLedgerId, setSelectedPayableLedgerId] = useState<string>('');
  const [selectedBankAccountId, setSelectedBankAccountId] = useState<string>('');
  const [selectedBankLedgerId, setSelectedBankLedgerId] = useState<string>('');
  const [payoutMethod, setPayoutMethod] = useState<ExpensePaymentMethod>('BANK_TRANSFER');
  const [payoutReference, setPayoutReference] = useState<string>('');
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isConfirmingCancel, setIsConfirmingCancel] = useState<boolean>(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null);

  // File upload state for receipt attachments
  const [uploadProgressLineIndex, setUploadProgressLineIndex] = useState<number | null>(null);
  const receiptInputId = useId();
  const isPreview = Boolean(currentUser.isPreview);

  // Load RBAC capabilities and permitted reference data
  useEffect(() => {
    let active = true;
    const loadCapabilitiesAndRefs = async () => {
      if (isPreview) {
        if (active) {
          setCapabilities(DEFAULT_CAPABILITIES);
          setLedgers([]);
          setBankAccounts([]);
          setEmployees([]);
        }
        return;
      }

      try {
        const caps = await api.getExpenseCapabilities();
        if (!active) return;
        setCapabilities(caps);

        const [fetchedLedgers, fetchedBanks, fetchedEmployees] = await Promise.all([
          caps.canViewAccounting ? api.getLedgers({ isActive: true }).catch(() => []) : Promise.resolve([]),
          caps.canViewCompanyBankAccounts ? api.getCompanyBankAccounts(true).catch(() => []) : Promise.resolve([]),
          caps.canViewEmployees ? api.getEmployees({ status: 'ACTIVE', limit: 100 }).catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
        ]);

        if (!active) return;
        setLedgers(fetchedLedgers);
        setBankAccounts(fetchedBanks);
        setEmployees(fetchedEmployees.items || []);
      } catch {
        if (active) setCapabilities(DEFAULT_CAPABILITIES);
      }
    };

    loadCapabilitiesAndRefs();
    return () => {
      active = false;
    };
  }, [isPreview, currentUser.id, currentUser.role]);

  // Ensure activeQueue falls back safely if capabilities change
  useEffect(() => {
    if (activeQueue === 'manager' && !capabilities.canManagerApprove) {
      setActiveQueue('my');
    } else if (activeQueue === 'accounts' && !capabilities.canAccountsApprove) {
      setActiveQueue('my');
    }
  }, [activeQueue, capabilities]);

  // Load claims data
  const loadClaims = useCallback(async () => {
    if (isPreview) {
      setClaims([]);
      setSummaryReport(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    try {
      const queueParam =
        activeQueue === 'my' ? 'self' : activeQueue === 'manager' ? 'manager' : 'accounts';
      const statusParam = statusFilter !== 'ALL' ? (statusFilter as ExpenseClaimStatus) : undefined;

      const [data, summary] = await Promise.all([
        api.getExpenseClaims({
          queue: queueParam,
          status: statusParam,
          search: searchQuery.trim() || undefined,
        }),
        api.getExpenseSummaryReport().catch(() => null),
      ]);

      setClaims(data);
      if (summary) setSummaryReport(summary);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load expense claims.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, [activeQueue, statusFilter, searchQuery, isPreview]);

  useEffect(() => {
    loadClaims();
  }, [loadClaims]);

  // Handle receipt attachment file upload for a specific line item
  const handleFileUpload = async (lineIndex: number, file: File) => {
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      setModalError('File size exceeds maximum allowed 10MB.');
      return;
    }

    setModalError(null);
    setUploadProgressLineIndex(lineIndex);
    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const res = reader.result as string;
          // Strip data:...;base64,
          const base64 = res.split(',')[1] || res;
          resolve(base64);
        };
        reader.onerror = reject;
      });
      reader.readAsDataURL(file);

      const base64 = await base64Promise;

      const attachment = await api.uploadExpenseAttachment(
        {
          fileName: file.name,
          mimeType: file.type || 'application/pdf',
          dataBase64: base64,
        },
        editingClaimId || undefined
      );

      setClaimLines((prev) => {
        const next = [...prev];
        next[lineIndex] = {
          ...next[lineIndex],
          attachmentId: attachment.id,
          attachmentFileName: file.name,
        };
        return next;
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to upload receipt.';
      setModalError(`Receipt upload failed: ${msg}`);
    } finally {
      setUploadProgressLineIndex(null);
    }
  };

  // Add line item to draft
  const addLineItem = () => {
    setClaimLines((prev) => [
      ...prev,
      {
        category: 'TRAVEL',
        description: '',
        expenseDate: originalExpenseDate || new Date().toISOString().slice(0, 10),
        amount: '',
        merchant: '',
      },
    ]);
  };

  // Remove line item
  const removeLineItem = (index: number) => {
    if (claimLines.length === 1) return;
    setClaimLines((prev) => prev.filter((_, i) => i !== index));
  };

  // Calculate total amount in modal
  const computedTotal = claimLines.reduce((acc, curr) => {
    const n = parseFloat(curr.amount);
    return acc + (isNaN(n) ? 0 : n);
  }, 0);

  // Submit or Save Draft
  const handleSaveClaim = async (submitImmediately: boolean) => {
    if (!claimTitle.trim()) {
      setModalError('Claim title is required.');
      return;
    }

    for (let i = 0; i < claimLines.length; i++) {
      const line = claimLines[i];
      if (!line.description.trim()) {
        setModalError(`Line ${i + 1} requires an item description.`);
        return;
      }
      const amt = parseFloat(line.amount);
      if (isNaN(amt) || amt <= 0) {
        setModalError(`Line ${i + 1} requires a valid positive amount.`);
        return;
      }
    }

    setIsSubmitting(true);
    setModalError(null);

    try {
      const formattedLines: CreateExpenseClaimLineInput[] = claimLines.map((l) => ({
        category: l.category,
        description: l.description.trim(),
        expenseDate: l.expenseDate,
        amount: parseFloat(l.amount),
        merchant: l.merchant.trim() || undefined,
        expenseLedgerId: l.expenseLedgerId || undefined,
        attachmentId: l.attachmentId || undefined,
      }));

      if (editingClaimId) {
        await api.updateExpenseClaim(editingClaimId, {
          title: claimTitle.trim(),
          description: claimDescription.trim() || undefined,
          originalExpenseDate,
          managerId: selectedManagerId || null,
          lines: formattedLines,
        });
        if (submitImmediately) {
          await api.submitExpenseClaim(editingClaimId);
        }
      } else {
        await api.createExpenseClaim({
          title: claimTitle.trim(),
          description: claimDescription.trim() || undefined,
          originalExpenseDate,
          currency: 'USD',
          managerId: selectedManagerId || undefined,
          lines: formattedLines,
          submitImmediately,
        });
      }

      setIsNewModalOpen(false);
      resetNewModal();
      await loadClaims();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save expense claim.';
      setModalError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetNewModal = () => {
    setEditingClaimId(null);
    setClaimTitle('');
    setClaimDescription('');
    setSelectedManagerId('');
    setOriginalExpenseDate(new Date().toISOString().slice(0, 10));
    setClaimLines([
      {
        category: 'TRAVEL',
        description: '',
        expenseDate: new Date().toISOString().slice(0, 10),
        amount: '',
        merchant: '',
      },
    ]);
    setModalError(null);
  };

  const openEditModal = (claim: ExpenseClaimItem) => {
    setEditingClaimId(claim.id);
    setClaimTitle(claim.title);
    setClaimDescription(claim.description || '');
    setSelectedManagerId(claim.managerId || '');
    setOriginalExpenseDate(claim.originalExpenseDate);
    setClaimLines(
      claim.lines.length > 0
        ? claim.lines.map((l) => ({
            category: l.category,
            description: l.description,
            expenseDate: l.expenseDate,
            amount: String(l.amount),
            merchant: l.merchant || '',
            expenseLedgerId: l.expenseLedgerId || undefined,
            attachmentId: l.attachmentId || undefined,
            attachmentFileName: l.attachment?.fileName || undefined,
          }))
        : [
            {
              category: 'TRAVEL',
              description: '',
              expenseDate: claim.originalExpenseDate,
              amount: '',
              merchant: '',
            },
          ]
    );
    setModalError(null);
    setSelectedClaim(null);
    setIsNewModalOpen(true);
  };

  // Workflow Action Handlers
  const handleSubmitDraft = async (claimId: string) => {
    setIsActionLoading(true);
    setActionError(null);
    try {
      const updated = await api.submitExpenseClaim(claimId);
      setSelectedClaim(updated);
      await loadClaims();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to submit draft.');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleCancelClaim = async (claimId: string) => {
    setIsActionLoading(true);
    setActionError(null);
    try {
      const updated = await api.cancelExpenseClaim(claimId, actionNotes || undefined);
      setSelectedClaim(updated);
      setIsConfirmingCancel(false);
      await loadClaims();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to cancel claim.');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleManagerReview = async (decision: 'APPROVE' | 'REJECT' | 'RETURN') => {
    if ((decision === 'REJECT' || decision === 'RETURN') && !actionNotes.trim()) {
      setActionError(`Notes are required when performing ${decision.toLowerCase()} action.`);
      return;
    }

    if (!selectedClaim) return;
    setIsActionLoading(true);
    setActionError(null);

    try {
      const updated = await api.reviewExpenseClaimAsManager(selectedClaim.id, {
        decision,
        reason: actionNotes.trim() || undefined,
      });
      setSelectedClaim(updated);
      setActionNotes('');
      await loadClaims();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : `Failed to ${decision.toLowerCase()} claim.`);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleAccountsReview = async (decision: 'APPROVE' | 'REJECT' | 'RETURN') => {
    if ((decision === 'REJECT' || decision === 'RETURN') && !actionNotes.trim()) {
      setActionError(`Notes are required when performing ${decision.toLowerCase()} action.`);
      return;
    }

    if (!selectedClaim) return;
    setIsActionLoading(true);
    setActionError(null);

    try {
      const updated = await api.reviewExpenseClaimAsAccounts(selectedClaim.id, {
        decision,
        reason: actionNotes.trim() || undefined,
        expenseLedgerId: selectedExpenseLedgerId || undefined,
        payableLedgerId: selectedPayableLedgerId || undefined,
      });
      setSelectedClaim(updated);
      setActionNotes('');
      setSelectedExpenseLedgerId('');
      setSelectedPayableLedgerId('');
      await loadClaims();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : `Failed to ${decision.toLowerCase()} claim.`);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleRecordPayment = async () => {
    if (!selectedClaim) return;
    setIsActionLoading(true);
    setActionError(null);

    try {
      const updated = await api.payExpenseClaim(selectedClaim.id, {
        bankAccountId: selectedBankAccountId || undefined,
        bankLedgerId: selectedBankLedgerId || undefined,
        paymentMethod: payoutMethod,
        paymentReference: payoutReference.trim() || undefined,
        paymentDate: new Date().toISOString().slice(0, 10),
      });
      setSelectedClaim(updated);
      setPayoutReference('');
      setSelectedBankAccountId('');
      setSelectedBankLedgerId('');
      await loadClaims();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to record reimbursement payment.');
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDownloadAttachment = async (attachmentId: string, fileName?: string) => {
    setDownloadingAttachmentId(attachmentId);
    setActionError(null);
    try {
      const response = await fetch(`/api/expenses/attachments/${attachmentId}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(`Unable to download receipt (HTTP ${response.status}).`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = fileName || 'expense-receipt';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to download receipt attachment.');
    } finally {
      setDownloadingAttachmentId(null);
    }
  };

  // Render Status Badge
  const renderStatusBadge = (status: ExpenseClaimStatus) => {
    switch (status) {
      case 'DRAFT':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-800 text-slate-300 border border-slate-700">
            <Clock className="w-3 h-3 text-slate-400" /> Draft
          </span>
        );
      case 'SUBMITTED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/30">
            <Clock className="w-3 h-3 text-amber-400" /> Submitted (Manager Review)
          </span>
        );
      case 'MANAGER_APPROVED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/30">
            <Check className="w-3 h-3 text-blue-400" /> Manager Approved (Accounts Review)
          </span>
        );
      case 'ACCOUNTS_APPROVED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/30">
            <CheckCircle2 className="w-3 h-3 text-indigo-400" /> Accounts Approved (Pending Payout)
          </span>
        );
      case 'PAID':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
            <CheckCircle2 className="w-3 h-3 text-emerald-400" /> Reimbursed / Paid
          </span>
        );
      case 'REJECTED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
            <XCircle className="w-3 h-3 text-rose-400" /> Rejected
          </span>
        );
      case 'CANCELLED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-800/80 text-slate-400 border border-slate-700/80">
            <Ban className="w-3 h-3" /> Cancelled
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Metric Cards */}
      {summaryReport && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
            <div>
              <div className="text-xs text-slate-400 uppercase tracking-wider font-semibold">
                Total Claims
              </div>
              <div className="text-2xl font-bold text-white mt-1">
                {summaryReport.totalClaimsCount}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {summaryReport.draftCount} drafts, {summaryReport.submittedCount} submitted
              </div>
            </div>
            <div className="w-10 h-10 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
              <Receipt className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
            <div>
              <div className="text-xs text-amber-400 uppercase tracking-wider font-semibold">
                Pending Reviews
              </div>
              <div className="text-2xl font-bold text-white mt-1">
                ${summaryReport.totalPendingAmount.toFixed(2)}
              </div>
              <div className="text-[11px] text-amber-400/80 mt-0.5">
                {summaryReport.submittedCount + summaryReport.managerApprovedCount} claims in queue
              </div>
            </div>
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center">
              <Clock className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
            <div>
              <div className="text-xs text-indigo-400 uppercase tracking-wider font-semibold">
                Approved Unpaid (AP)
              </div>
              <div className="text-2xl font-bold text-white mt-1">
                ${summaryReport.totalApprovedUnpaidAmount.toFixed(2)}
              </div>
              <div className="text-[11px] text-indigo-400/80 mt-0.5">
                {summaryReport.accountsApprovedCount} awaiting payout
              </div>
            </div>
            <div className="w-10 h-10 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center">
              <DollarSign className="w-5 h-5" />
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl flex items-center justify-between">
            <div>
              <div className="text-xs text-emerald-400 uppercase tracking-wider font-semibold">
                Total Reimbursed
              </div>
              <div className="text-2xl font-bold text-white mt-1">
                ${summaryReport.totalReimbursedAmount.toFixed(2)}
              </div>
              <div className="text-[11px] text-emerald-400/80 mt-0.5">
                {summaryReport.paidCount} claims settled
              </div>
            </div>
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5" />
            </div>
          </div>
        </div>
      )}

      {/* Main Bar: Queue Selection & Action Button */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900 border border-slate-800 p-4 rounded-xl">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveQueue('my')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              activeQueue === 'my'
                ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
            }`}
          >
            My Expense Claims
          </button>

          {capabilities.canManagerApprove && (
            <button
              onClick={() => setActiveQueue('manager')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                activeQueue === 'manager'
                  ? 'bg-amber-600 text-white shadow-sm shadow-amber-600/30'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <span>Manager Approvals</span>
              {summaryReport && summaryReport.submittedCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-amber-950 text-amber-300 font-bold border border-amber-600/40">
                  {summaryReport.submittedCount}
                </span>
              )}
            </button>
          )}

          {capabilities.canAccountsApprove && (
            <button
              onClick={() => setActiveQueue('accounts')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                activeQueue === 'accounts'
                  ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/30'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <span>Accounts & Payout Queue</span>
              {summaryReport && summaryReport.accountsApprovedCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-emerald-950 text-emerald-300 font-bold border border-emerald-600/40">
                  {summaryReport.accountsApprovedCount}
                </span>
              )}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <button
            onClick={() => loadClaims()}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
            title="Refresh claims"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>

          <button
            onClick={() => {
              resetNewModal();
              setIsNewModalOpen(true);
            }}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-4 py-2 rounded-lg shadow-sm transition-all shadow-indigo-600/30"
          >
            <Plus className="w-4 h-4" />
            New Expense Claim
          </button>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="flex flex-wrap items-center gap-3 bg-slate-900/60 border border-slate-800/80 p-3 rounded-xl text-xs">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by claim #, title, employee code or name..."
            className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg pl-8 pr-3 py-1.5 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-slate-400" />
          <span className="text-slate-400 font-medium">Status:</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-slate-950 border border-slate-800 text-slate-200 rounded-lg px-2.5 py-1.5 focus:border-indigo-500 focus:outline-none"
          >
            <option value="ALL">All Statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="SUBMITTED">Submitted</option>
            <option value="MANAGER_APPROVED">Manager Approved</option>
            <option value="ACCOUNTS_APPROVED">Accounts Approved</option>
            <option value="PAID">Paid / Reimbursed</option>
            <option value="REJECTED">Rejected</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
      </div>

      {/* Claims List Table */}
      {isLoading ? (
        <div className="p-12 flex justify-center">
          <LoadingSpinner />
        </div>
      ) : error ? (
        <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-xl text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : claims.length === 0 ? (
        <EmptyState
          title={isPreview ? 'Expense Claims Require Active Backend Session' : 'No Expense Claims Found'}
          description={
            isPreview
              ? 'Expense claims and reimbursements post directly to PostgreSQL ledgers and require a live authenticated database session.'
              : activeQueue === 'my'
              ? 'You have not submitted any expense claims yet. Click "New Expense Claim" to submit out-of-pocket expenses.'
              : 'The selected approval or payment queue is currently clear.'
          }
          icon={<Receipt className="w-6 h-6" />}
        />
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 uppercase tracking-wider text-[11px]">
                <th className="py-3 px-4">Claim #</th>
                <th className="py-3 px-4">Title / Expense Date</th>
                <th className="py-3 px-4">Employee</th>
                <th className="py-3 px-4">Lines & Category</th>
                <th className="py-3 px-4">Total Amount</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {claims.map((claim) => (
                <tr key={claim.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-3 px-4 font-mono font-semibold text-slate-200">
                    <div className="flex items-center gap-1.5">
                      <Receipt className="w-3.5 h-3.5 text-indigo-400" />
                      <span>{claim.claimNumber}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-semibold text-slate-200 line-clamp-1">{claim.title}</div>
                    <div className="text-[11px] text-slate-500 flex items-center gap-1 font-mono mt-0.5">
                      <Calendar className="w-3 h-3 text-slate-500" />
                      <span>{claim.originalExpenseDate}</span>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-semibold text-slate-200">{claim.employeeName}</div>
                    <div className="text-[11px] text-slate-500 font-mono">
                      {claim.employeeCode} {claim.departmentName ? `• ${claim.departmentName}` : ''}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap gap-1">
                      {claim.lines.slice(0, 2).map((l, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700"
                        >
                          {l.category} (${l.amount.toFixed(2)})
                        </span>
                      ))}
                      {claim.lines.length > 2 && (
                        <span className="text-[10px] text-slate-400 self-center">
                          +{claim.lines.length - 2} more
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono font-bold text-emerald-400 text-sm">
                    ${claim.totalAmount.toFixed(2)}
                  </td>
                  <td className="py-3 px-4">{renderStatusBadge(claim.status)}</td>
                  <td className="py-3 px-4 text-right">
                    <button
                      onClick={() => {
                        setSelectedClaim(claim);
                        setActionError(null);
                        setActionNotes('');
                        setIsConfirmingCancel(false);
                        setSelectedExpenseLedgerId('');
                        setSelectedPayableLedgerId(claim.payableLedgerId || '');
                        setSelectedBankAccountId(claim.bankAccountId || '');
                        setSelectedBankLedgerId('');
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold transition-colors border border-slate-700"
                    >
                      <Eye className="w-3.5 h-3.5 text-indigo-400" />
                      <span>View & Review</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 1: CREATE NEW EXPENSE CLAIM                                          */}
      {/* ========================================================================= */}
      {isNewModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 space-y-5 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Receipt className="w-5 h-5 text-indigo-400" />
                <h3 className="text-base font-bold text-white">
                  {editingClaimId ? 'Edit Draft Expense Claim' : 'Create Expense Reimbursement Claim'}
                </h3>
              </div>
              <button
                onClick={() => setIsNewModalOpen(false)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-lg text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{modalError}</span>
              </div>
            )}

            <div className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-300 font-medium mb-1">Claim Title / Purpose *</label>
                  <input
                    type="text"
                    value={claimTitle}
                    onChange={(e) => setClaimTitle(e.target.value)}
                    placeholder="e.g. Client visit travel and meals"
                    className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-slate-300 font-medium mb-1">Original Expense Date *</label>
                  <input
                    type="date"
                    value={originalExpenseDate}
                    onChange={(e) => setOriginalExpenseDate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 font-mono focus:border-indigo-500 focus:outline-none"
                  />
                  <span className="text-[10px] text-slate-500 mt-0.5 block">
                    Attributed to this accounting fiscal period
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-300 font-medium mb-1">Additional Notes / Business Justification</label>
                  <textarea
                    value={claimDescription}
                    onChange={(e) => setClaimDescription(e.target.value)}
                    placeholder="Optional context for management and accounts reviewers..."
                    rows={2}
                    className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                {employees.length > 0 && (
                  <div>
                    <label className="block text-slate-300 font-medium mb-1">Approving Manager (Optional)</label>
                    <select
                      value={selectedManagerId}
                      onChange={(e) => setSelectedManagerId(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 text-slate-200 rounded-lg p-2.5 focus:border-indigo-500 focus:outline-none"
                    >
                      <option value="">Any Authorized Manager</option>
                      {employees
                        .filter((emp) => emp.id !== capabilities.currentEmployeeId)
                        .map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.fullName} ({emp.employeeCode})
                          </option>
                        ))}
                    </select>
                    <span className="text-[10px] text-slate-500 mt-0.5 block">
                      Restricts manager approval to the selected reviewer
                    </span>
                  </div>
                )}
              </div>

              {/* Itemized Lines */}
              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200 uppercase tracking-wider text-[11px]">
                    Itemized Lines & Receipts ({claimLines.length})
                  </span>
                  <button
                    type="button"
                    onClick={addLineItem}
                    className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-semibold"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Line
                  </button>
                </div>

                <div className="space-y-3">
                  {claimLines.map((line, idx) => (
                    <div
                      key={idx}
                      className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3.5 space-y-3"
                    >
                      <div className="flex items-center justify-between text-[11px] text-slate-400 font-semibold border-b border-slate-800/60 pb-2">
                        <span>Line #{idx + 1}</span>
                        {claimLines.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeLineItem(idx)}
                            className="text-rose-400 hover:text-rose-300 text-xs"
                          >
                            Remove
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-slate-400 font-medium mb-1 text-[11px]">Category</label>
                          <select
                            value={line.category}
                            onChange={(e) => {
                              const val = e.target.value as ExpenseCategory;
                              setClaimLines((prev) => {
                                const next = [...prev];
                                next[idx] = { ...next[idx], category: val };
                                return next;
                              });
                            }}
                            className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 focus:border-indigo-500 focus:outline-none"
                          >
                            {CATEGORIES.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="block text-slate-400 font-medium mb-1 text-[11px]">Description *</label>
                          <input
                            type="text"
                            value={line.description}
                            onChange={(e) => {
                              const val = e.target.value;
                              setClaimLines((prev) => {
                                const next = [...prev];
                                next[idx] = { ...next[idx], description: val };
                                return next;
                              });
                            }}
                            placeholder="e.g. Flight ticket NYC to SFO"
                            className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 focus:border-indigo-500 focus:outline-none"
                          />
                        </div>

                        <div>
                          <label className="block text-slate-400 font-medium mb-1 text-[11px]">Amount ($) *</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0.01"
                            value={line.amount}
                            onChange={(e) => {
                              const val = e.target.value;
                              setClaimLines((prev) => {
                                const next = [...prev];
                                next[idx] = { ...next[idx], amount: val };
                                return next;
                              });
                            }}
                            placeholder="0.00"
                            className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 font-mono focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                        <div>
                          <label className="block text-slate-400 font-medium mb-1 text-[11px]">Merchant / Vendor</label>
                          <input
                            type="text"
                            value={line.merchant}
                            onChange={(e) => {
                              const val = e.target.value;
                              setClaimLines((prev) => {
                                const next = [...prev];
                                next[idx] = { ...next[idx], merchant: val };
                                return next;
                              });
                            }}
                            placeholder="e.g. Delta Airlines"
                            className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 focus:border-indigo-500 focus:outline-none"
                          />
                        </div>

                        <div>
                          <label className="block text-slate-400 font-medium mb-1 text-[11px]">
                            Receipt Attachment (PDF, PNG, JPEG, WebP)
                          </label>
                          <div className="flex items-center gap-2">
                            <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 rounded-lg text-xs font-semibold transition-colors">
                              <Upload className="w-3.5 h-3.5 text-indigo-400" />
                              <span>{uploadProgressLineIndex === idx ? 'Uploading...' : 'Choose File'}</span>
                              <input
                                id={`${receiptInputId}-line-${idx}`}
                                type="file"
                                accept=".pdf,image/png,image/jpeg,image/webp"
                                className="hidden"
                                onChange={(e) => {
                                  const f = e.target.files?.[0];
                                  if (f) handleFileUpload(idx, f);
                                }}
                              />
                            </label>
                            {line.attachmentFileName && (
                              <span className="text-[11px] text-emerald-400 font-mono truncate max-w-[180px]">
                                ✓ {line.attachmentFileName}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Total Calculation */}
              <div className="flex items-center justify-between bg-slate-950 p-4 rounded-xl border border-slate-800 font-semibold">
                <span className="text-slate-300">Total Claim Amount:</span>
                <span className="text-emerald-400 text-lg font-mono">
                  ${computedTotal.toFixed(2)} USD
                </span>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setIsNewModalOpen(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleSaveClaim(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-indigo-500/30 rounded-lg text-xs font-semibold"
                disabled={isSubmitting}
              >
                Save as Draft
              </button>
              <button
                type="button"
                onClick={() => handleSaveClaim(true)}
                className="flex items-center gap-1.5 px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-sm shadow-indigo-600/30"
                disabled={isSubmitting}
              >
                <Send className="w-3.5 h-3.5" />
                <span>Submit Immediately</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 2: CLAIM DETAILS, AUDIT TIMELINE & MULTI-LEVEL REVIEW ACTIONS       */}
      {/* ========================================================================= */}
      {selectedClaim && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-3xl w-full p-6 space-y-5 shadow-2xl max-h-[92vh] overflow-y-auto">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center font-bold">
                  <Receipt className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-white">{selectedClaim.claimNumber}</h3>
                    {renderStatusBadge(selectedClaim.status)}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {selectedClaim.title} • Date: <span className="font-mono text-slate-300">{selectedClaim.originalExpenseDate}</span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSelectedClaim(null)}
                className="text-slate-400 hover:text-white p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {actionError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-lg text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{actionError}</span>
              </div>
            )}

            {/* Rejection / Return notices if any */}
            {selectedClaim.rejectionReason && (
              <div className="p-3.5 bg-rose-950/40 border border-rose-800/50 rounded-xl text-xs space-y-1">
                <div className="flex items-center gap-1.5 font-bold text-rose-300">
                  <XCircle className="w-4 h-4 text-rose-400" />
                  <span>Claim Rejection Reason</span>
                </div>
                <p className="text-rose-200/90">{selectedClaim.rejectionReason}</p>
              </div>
            )}

            {selectedClaim.returnReason && (
              <div className="p-3.5 bg-amber-950/40 border border-amber-800/50 rounded-xl text-xs space-y-1">
                <div className="flex items-center gap-1.5 font-bold text-amber-300">
                  <CornerDownLeft className="w-4 h-4 text-amber-400" />
                  <span>Returned for Correction Notes</span>
                </div>
                <p className="text-amber-200/90">{selectedClaim.returnReason}</p>
              </div>
            )}

            {/* Overview Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs bg-slate-950/60 p-4 rounded-xl border border-slate-800">
              <div>
                <span className="text-slate-500 block">Submitted By</span>
                <span className="font-semibold text-slate-200">{selectedClaim.employeeName}</span>
                <span className="text-[11px] text-slate-400 block font-mono">{selectedClaim.employeeCode}</span>
              </div>
              <div>
                <span className="text-slate-500 block">Department</span>
                <span className="font-semibold text-slate-200">{selectedClaim.departmentName || 'General'}</span>
                {selectedClaim.managerName && (
                  <span className="text-[11px] text-slate-400 block">
                    Manager: {selectedClaim.managerName}
                  </span>
                )}
              </div>
              <div>
                <span className="text-slate-500 block">Total Amount</span>
                <span className="font-mono font-bold text-emerald-400 text-sm">
                  ${selectedClaim.totalAmount.toFixed(2)} {selectedClaim.currency}
                </span>
              </div>
              <div>
                <span className="text-slate-500 block">Journal Postings</span>
                {selectedClaim.journalVoucherNumber ? (
                  <span className="font-mono text-indigo-400 block">
                    AP: {selectedClaim.journalVoucherNumber}
                  </span>
                ) : (
                  <span className="text-slate-500">Pending AP</span>
                )}
                {selectedClaim.paymentJournalVoucherNumber && (
                  <span className="font-mono text-emerald-400 block">
                    Paid: {selectedClaim.paymentJournalVoucherNumber}
                  </span>
                )}
              </div>
            </div>

            {/* Itemized Lines */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Itemized Expenses ({selectedClaim.lines.length})
              </h4>
              <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden text-xs">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400 text-[11px] uppercase">
                      <th className="py-2.5 px-3">Category</th>
                      <th className="py-2.5 px-3">Description / Merchant</th>
                      <th className="py-2.5 px-3">Date</th>
                      <th className="py-2.5 px-3">Amount</th>
                      <th className="py-2.5 px-3">Receipt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-slate-300">
                    {selectedClaim.lines.map((l) => (
                      <tr key={l.id}>
                        <td className="py-2.5 px-3">
                          <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                            {l.category}
                          </span>
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="font-medium text-slate-200">{l.description}</div>
                          {l.merchant && <div className="text-[11px] text-slate-500">{l.merchant}</div>}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-slate-400 text-[11px]">
                          {l.expenseDate}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-bold text-emerald-400">
                          ${l.amount.toFixed(2)}
                        </td>
                        <td className="py-2.5 px-3">
                          {l.attachmentId ? (
                            <button
                              type="button"
                              onClick={() =>
                                handleDownloadAttachment(
                                  l.attachmentId!,
                                  l.attachment?.fileName || `receipt-${selectedClaim.claimNumber}`
                                )
                              }
                              disabled={downloadingAttachmentId === l.attachmentId}
                              className="inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 font-mono disabled:opacity-50"
                            >
                              <Download className="w-3 h-3" />
                              <span>
                                {downloadingAttachmentId === l.attachmentId ? 'Downloading...' : 'Download Receipt'}
                              </span>
                            </button>
                          ) : (
                            <span className="text-slate-500 text-[11px]">No receipt</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Workflow Timeline */}
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                Workflow Audit Trail ({selectedClaim.events.length})
              </h4>
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 space-y-2 max-h-40 overflow-y-auto text-xs">
                {selectedClaim.events.map((e) => (
                  <div key={e.id} className="flex items-start gap-2.5 pb-2 border-b border-slate-800/40 last:border-0 last:pb-0">
                    <div className="w-2 h-2 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-200">{e.action}</span>
                        <span className="text-[10px] text-slate-500 font-mono">
                          {new Date(e.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400">
                        By {e.actorName || 'User'} {e.notes ? `• "${e.notes}"` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Review & Action Box */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3 text-xs">
              <span className="font-semibold text-slate-200 block uppercase tracking-wider text-[11px]">
                Available Actions & Governance Controls
              </span>

              {/* Submitter actions */}
              {(selectedClaim.status === 'DRAFT' || selectedClaim.status === 'SUBMITTED') &&
                (!capabilities.currentEmployeeId ||
                  selectedClaim.employeeId === capabilities.currentEmployeeId ||
                  currentUser.role === 'SUPER_ADMIN') && (
                  <div className="flex flex-wrap items-center gap-3">
                    {selectedClaim.status === 'DRAFT' && (
                      <>
                        <button
                          onClick={() => openEditModal(selectedClaim)}
                          disabled={isActionLoading}
                          className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-semibold"
                        >
                          <FileText className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Edit Draft</span>
                        </button>
                        <button
                          onClick={() => handleSubmitDraft(selectedClaim.id)}
                          disabled={isActionLoading}
                          className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-sm"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>Submit Claim for Approval</span>
                        </button>
                      </>
                    )}
                    {!isConfirmingCancel ? (
                      <button
                        onClick={() => setIsConfirmingCancel(true)}
                        disabled={isActionLoading}
                        className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-rose-300 rounded-lg text-xs font-semibold"
                      >
                        Cancel Claim
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 bg-rose-950/40 border border-rose-800/60 px-3 py-1.5 rounded-lg">
                        <span className="text-rose-300 text-[11px] font-medium">Confirm cancel?</span>
                        <button
                          onClick={() => handleCancelClaim(selectedClaim.id)}
                          disabled={isActionLoading}
                          className="px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded text-[11px] font-semibold"
                        >
                          Yes, Cancel
                        </button>
                        <button
                          onClick={() => setIsConfirmingCancel(false)}
                          disabled={isActionLoading}
                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px]"
                        >
                          Keep
                        </button>
                      </div>
                    )}
                  </div>
                )}

              {/* Manager Actions (Status: SUBMITTED, strictly enforcing SoD and manager assignment) */}
              {selectedClaim.status === 'SUBMITTED' &&
                capabilities.canManagerApprove &&
                selectedClaim.employeeId !== capabilities.currentEmployeeId &&
                (!selectedClaim.managerId ||
                  selectedClaim.managerId === capabilities.currentEmployeeId ||
                  currentUser.role === 'SUPER_ADMIN') && (
                  <div className="space-y-3">
                    <input
                      type="text"
                      value={actionNotes}
                      onChange={(e) => setActionNotes(e.target.value)}
                      placeholder="Enter review notes (required for reject or return)..."
                      className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 focus:border-indigo-500 focus:outline-none text-xs"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleManagerReview('APPROVE')}
                        disabled={isActionLoading}
                        className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold shadow-sm"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Manager Approve</span>
                      </button>
                      <button
                        onClick={() => handleManagerReview('RETURN')}
                        disabled={isActionLoading}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-600/30 rounded-lg text-xs font-semibold"
                      >
                        <CornerDownLeft className="w-3.5 h-3.5" />
                        <span>Return for Correction</span>
                      </button>
                      <button
                        onClick={() => handleManagerReview('REJECT')}
                        disabled={isActionLoading}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-600/30 rounded-lg text-xs font-semibold"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Reject Claim</span>
                      </button>
                    </div>
                  </div>
                )}

              {/* Accounts Review Actions (Status: MANAGER_APPROVED, strictly enforcing SoD) */}
              {selectedClaim.status === 'MANAGER_APPROVED' &&
                capabilities.canAccountsApprove &&
                selectedClaim.employeeId !== capabilities.currentEmployeeId &&
                selectedClaim.managerApprovedById !== (currentUser.userId || currentUser.id) && (
                  <div className="space-y-3">
                    <div className="text-[11px] text-slate-400">
                      Accounts approval will automatically post a double-entry Journal Voucher debiting the Expense account(s) and crediting Accounts Payable liability.
                    </div>

                    {ledgers.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-slate-400 mb-1 text-[11px]">
                            Expense Ledger (Fallback for Unassigned Lines)
                          </label>
                          <select
                            value={selectedExpenseLedgerId}
                            onChange={(e) => setSelectedExpenseLedgerId(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 focus:border-indigo-500 focus:outline-none"
                          >
                            <option value="">Default Operating Expense Ledger</option>
                            {ledgers
                              .filter((l) => l.rootType === 'EXPENSE')
                              .map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.code ? `${l.code} - ` : ''}{l.name}
                                </option>
                              ))}
                          </select>
                        </div>

                        <div>
                          <label className="block text-slate-400 mb-1 text-[11px]">
                            Accounts Payable Liability Ledger
                          </label>
                          <select
                            value={selectedPayableLedgerId}
                            onChange={(e) => setSelectedPayableLedgerId(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 focus:border-indigo-500 focus:outline-none"
                          >
                            <option value="">Default Employee Reimbursements Payable</option>
                            {ledgers
                              .filter((l) => l.rootType === 'LIABILITY')
                              .map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.code ? `${l.code} - ` : ''}{l.name}
                                </option>
                              ))}
                          </select>
                        </div>
                      </div>
                    )}

                    <input
                      type="text"
                      value={actionNotes}
                      onChange={(e) => setActionNotes(e.target.value)}
                      placeholder="Review notes or approval reference..."
                      className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 focus:border-indigo-500 focus:outline-none text-xs"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleAccountsReview('APPROVE')}
                        disabled={isActionLoading}
                        className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-sm shadow-indigo-600/30"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Approve & Post to Accounts Payable</span>
                      </button>
                      <button
                        onClick={() => handleAccountsReview('RETURN')}
                        disabled={isActionLoading}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-600/30 rounded-lg text-xs font-semibold"
                      >
                        <CornerDownLeft className="w-3.5 h-3.5" />
                        <span>Return for Correction</span>
                      </button>
                      <button
                        onClick={() => handleAccountsReview('REJECT')}
                        disabled={isActionLoading}
                        className="flex items-center gap-1.5 px-3.5 py-2 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-600/30 rounded-lg text-xs font-semibold"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Reject</span>
                      </button>
                    </div>
                  </div>
                )}

              {/* Reimbursement Disbursement Actions (Status: ACCOUNTS_APPROVED, strictly enforcing SoD) */}
              {selectedClaim.status === 'ACCOUNTS_APPROVED' &&
                capabilities.canAccountsApprove &&
                selectedClaim.employeeId !== capabilities.currentEmployeeId && (
                  <div className="space-y-3">
                    <div className="text-[11px] text-slate-400">
                      Record reimbursement payout. This debits Accounts Payable liability and credits the selected company Cash/Bank asset account.
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {bankAccounts.length > 0 && (
                        <div>
                          <label className="block text-slate-400 mb-1 text-[11px]">Company Bank Account</label>
                          <select
                            value={selectedBankAccountId}
                            onChange={(e) => setSelectedBankAccountId(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 focus:border-emerald-500 focus:outline-none"
                          >
                            <option value="">Default / Unspecified Bank Account</option>
                            {bankAccounts.map((ba) => (
                              <option key={ba.id} value={ba.id}>
                                {ba.bankName} ({ba.accountNumber})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {ledgers.length > 0 && (
                        <div>
                          <label className="block text-slate-400 mb-1 text-[11px]">Bank / Cash Asset Ledger</label>
                          <select
                            value={selectedBankLedgerId}
                            onChange={(e) => setSelectedBankLedgerId(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 focus:border-emerald-500 focus:outline-none"
                          >
                            <option value="">Default Cash / Operating Bank Ledger</option>
                            {ledgers
                              .filter((l) => l.rootType === 'ASSET')
                              .map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.code ? `${l.code} - ` : ''}{l.name}
                                </option>
                              ))}
                          </select>
                        </div>
                      )}

                      <div>
                        <label className="block text-slate-400 mb-1 text-[11px]">Payment Method</label>
                        <select
                          value={payoutMethod}
                          onChange={(e) => setPayoutMethod(e.target.value as ExpensePaymentMethod)}
                          className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 focus:border-emerald-500 focus:outline-none"
                        >
                          <option value="BANK_TRANSFER">Direct Bank Transfer (ACH / Wire / UPI)</option>
                          <option value="CHEQUE">Corporate Cheque</option>
                          <option value="CASH">Petty Cash Disbursement</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-slate-400 mb-1 text-[11px]">Payment Reference / Transaction ID</label>
                        <input
                          type="text"
                          value={payoutReference}
                          onChange={(e) => setPayoutReference(e.target.value)}
                          placeholder="e.g. TXN-998822 or CHQ-00129"
                          className="w-full bg-slate-900 border border-slate-800 text-slate-200 rounded-lg p-2 font-mono focus:border-emerald-500 focus:outline-none"
                        />
                      </div>
                    </div>

                    <button
                      onClick={handleRecordPayment}
                      disabled={isActionLoading}
                      className="flex items-center gap-1.5 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-sm shadow-emerald-600/30"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Disburse Payout & Mark Settled (${selectedClaim.totalAmount.toFixed(2)})</span>
                    </button>
                  </div>
                )}

              {/* Status: PAID display */}
              {selectedClaim.status === 'PAID' && (
                <div className="flex items-center gap-2 text-emerald-400 font-semibold">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    Claim fully reimbursed on {selectedClaim.paidAt?.slice(0, 10)} via {selectedClaim.paymentMethod || 'Bank Transfer'}. Ref: {selectedClaim.paymentReference || 'N/A'}.
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
