import React, { useState, useEffect, useCallback } from 'react';
import {
  BookOpen,
  Plus,
  Search,
  CheckCircle2,
  AlertCircle,
  Clock,
  RotateCcw,
  Send,
  Eye,
  Trash2,
  X,
  FileSpreadsheet,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import {
  JournalEntryItem,
  JournalStatus,
  AccountLedgerItem,
  AuthUser,
  CreateJournalEntryRequest,
} from '../../shared/types.ts';
import {
  PREVIEW_JOURNALS,
  PREVIEW_ACCOUNT_LEDGERS,
  previewStore,
} from '../services/previewStore.ts';

interface JournalEntriesPageProps {
  currentUser: AuthUser;
}

interface JournalLineDraft {
  ledgerId: string;
  debit: string;
  credit: string;
  description: string;
}

export const JournalEntriesPage: React.FC<JournalEntriesPageProps> = ({ currentUser }) => {
  const [journals, setJournals] = useState<JournalEntryItem[]>([]);
  const [ledgers, setLedgers] = useState<AccountLedgerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<JournalStatus | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // View modal
  const [viewingJournal, setViewingJournal] = useState<JournalEntryItem | null>(null);

  // Reversal modal
  const [reversingJournal, setReversingJournal] = useState<JournalEntryItem | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const [isReversing, setIsReversing] = useState(false);

  // Create Voucher Modal
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [reference, setReference] = useState('');
  const [narration, setNarration] = useState('');
  const [draftLines, setDraftLines] = useState<JournalLineDraft[]>([
    { ledgerId: '', debit: '', credit: '', description: '' },
    { ledgerId: '', debit: '', credit: '', description: '' },
  ]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const fetchJournalsAndLedgers = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    // In Preview Mode, use in-memory demo journal data while PostgreSQL is offline
    if (currentUser?.isPreview) {
      const filtered = previewStore.getJournals({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        search: search.trim() || undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
      });
      setJournals(filtered);
      setLedgers(previewStore.getAccountLedgers({ isActive: true }));
      setIsLoading(false);
      return;
    }

    try {
      const [jData, lData] = await Promise.all([
        api.getJournals({
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          search: search.trim() || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        }),
        api.getAccountLedgers({ isActive: true }),
      ]);
      setJournals(jData);
      setLedgers(lData);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load journals.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentUser?.isPreview, statusFilter, search, fromDate, toDate]);

  useEffect(() => {
    fetchJournalsAndLedgers();
  }, [fetchJournalsAndLedgers]);

  // Balance calculation for modal lines
  const totalDebitModal = draftLines.reduce((sum, line) => {
    const val = parseFloat(line.debit) || 0;
    return sum + val;
  }, 0);

  const totalCreditModal = draftLines.reduce((sum, line) => {
    const val = parseFloat(line.credit) || 0;
    return sum + val;
  }, 0);

  const difference = Math.abs(totalDebitModal - totalCreditModal);
  const isBalanced =
    draftLines.length >= 2 &&
    totalDebitModal > 0 &&
    totalCreditModal > 0 &&
    difference < 0.0001;

  const handleAddLine = () => {
    setDraftLines([
      ...draftLines,
      { ledgerId: '', debit: '', credit: '', description: '' },
    ]);
  };

  const handleRemoveLine = (idx: number) => {
    if (draftLines.length <= 2) return;
    setDraftLines(draftLines.filter((_, i) => i !== idx));
  };

  const handleLineChange = (idx: number, field: keyof JournalLineDraft, val: string) => {
    const updated = [...draftLines];
    if (field === 'debit' && val) {
      updated[idx] = { ...updated[idx], debit: val, credit: '' };
    } else if (field === 'credit' && val) {
      updated[idx] = { ...updated[idx], credit: val, debit: '' };
    } else {
      updated[idx] = { ...updated[idx], [field]: val };
    }
    setDraftLines(updated);
  };

  const handleCreateVoucher = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!isBalanced) {
      setErrorMessage('Total debits must equal total credits and be greater than 0.');
      return;
    }

    for (let i = 0; i < draftLines.length; i++) {
      const line = draftLines[i];
      if (!line.ledgerId) {
        setErrorMessage(`Please select a valid ledger on line ${i + 1}.`);
        return;
      }
      const deb = parseFloat(line.debit) || 0;
      const cred = parseFloat(line.credit) || 0;
      if (deb === 0 && cred === 0) {
        setErrorMessage(`Line ${i + 1} must have either a debit or credit amount.`);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const payload: CreateJournalEntryRequest = {
        entryDate,
        reference: reference.trim() || undefined,
        narration: narration.trim(),
        lines: draftLines.map((l) => ({
          ledgerId: l.ledgerId,
          debit: l.debit ? parseFloat(l.debit).toFixed(4) : '0.0000',
          credit: l.credit ? parseFloat(l.credit).toFixed(4) : '0.0000',
          description: l.description.trim() || undefined,
        })),
      };

      if (currentUser?.isPreview) {
        const created = previewStore.createJournal(payload, currentUser);
        setSuccessMessage(
          `[Preview Demo] Journal Voucher ${created.voucherNumber} created as DRAFT in-memory. Not saved to database.`
        );
        setIsCreateModalOpen(false);
        setReference('');
        setNarration('');
        setDraftLines([
          { ledgerId: '', debit: '', credit: '', description: '' },
          { ledgerId: '', debit: '', credit: '', description: '' },
        ]);
        fetchJournalsAndLedgers();
        return;
      }

      const created = await api.createJournal(payload);
      setSuccessMessage(`Journal Voucher ${created.voucherNumber} created as DRAFT.`);
      setIsCreateModalOpen(false);
      // Reset form
      setReference('');
      setNarration('');
      setDraftLines([
        { ledgerId: '', debit: '', credit: '', description: '' },
        { ledgerId: '', debit: '', credit: '', description: '' },
      ]);
      fetchJournalsAndLedgers();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to create journal entry.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePostJournal = async (journal: JournalEntryItem) => {
    setActionLoadingId(journal.id);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      if (currentUser?.isPreview) {
        const posted = previewStore.postJournal(journal.id, currentUser);
        setSuccessMessage(
          `[Preview Demo] Voucher ${posted.voucherNumber} posted in-memory. Financial statements updated.`
        );
        fetchJournalsAndLedgers();
        return;
      }

      const posted = await api.postJournal(journal.id);
      setSuccessMessage(`Voucher ${posted.voucherNumber} posted successfully.`);
      fetchJournalsAndLedgers();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to post journal.');
      }
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleReverseJournal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reversingJournal) return;

    setIsReversing(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      if (currentUser?.isPreview) {
        const res = previewStore.reverseJournal(
          reversingJournal.id,
          reversalReason.trim(),
          currentUser
        );
        setSuccessMessage(
          `[Preview Demo] Voucher ${res.original.voucherNumber} reversed in-memory. Reversal entry created: ${res.reversal.voucherNumber}.`
        );
        setReversingJournal(null);
        setReversalReason('');
        fetchJournalsAndLedgers();
        return;
      }

      const res = await api.reverseJournal(reversingJournal.id, reversalReason.trim());
      setSuccessMessage(
        `Voucher ${res.original.voucherNumber} reversed. Reversal entry created: ${res.reversal.voucherNumber}.`
      );
      setReversingJournal(null);
      setReversalReason('');
      fetchJournalsAndLedgers();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to reverse journal voucher.');
      }
    } finally {
      setIsReversing(false);
    }
  };

  const getStatusBadge = (status: JournalStatus) => {
    switch (status) {
      case 'DRAFT':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-950/60 text-amber-300 border border-amber-800/60">
            <Clock className="w-3 h-3" /> Draft
          </span>
        );
      case 'POSTED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-950/60 text-emerald-300 border border-emerald-800/60">
            <CheckCircle2 className="w-3 h-3" /> Posted
          </span>
        );
      case 'REVERSED':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-purple-950/60 text-purple-300 border border-purple-800/60">
            <RotateCcw className="w-3 h-3" /> Reversed
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <FileSpreadsheet className="w-6 h-6 text-indigo-400" />
            General Journal &amp; Vouchers
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Double-entry journal engine with strict debit/credit equality, sequential numbering, and immutable audit trails
          </p>
        </div>

        <button
          onClick={() => !currentUser?.isPreview && setIsCreateModalOpen(true)}
          disabled={currentUser?.isPreview}
          title={
            currentUser?.isPreview
              ? 'Saving is unavailable in Preview Mode: PostgreSQL is offline in sandbox'
              : 'New Journal Voucher'
          }
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold shadow-md transition ${
            currentUser?.isPreview
              ? 'bg-slate-900/60 text-slate-500 border border-slate-800 cursor-not-allowed opacity-75'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer'
          }`}
        >
          <Plus className="w-4 h-4" />
          <span>New Journal Voucher</span>
          {currentUser?.isPreview && (
            <span className="text-[9px] font-mono uppercase bg-amber-950/80 text-amber-300 px-1.5 py-0.5 rounded border border-amber-800/80 ml-1">
              Disabled
            </span>
          )}
        </button>
      </div>

      {/* Preview Mode Notice */}
      {currentUser?.isPreview && (
        <div className="bg-amber-950/60 border border-amber-800/70 rounded-xl p-4 text-xs text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow">
          <div className="flex items-center gap-2.5">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
            <div>
              <strong className="text-amber-100">Preview Mode — In-Memory General Journal</strong>
              <p className="text-amber-300/80 mt-0.5">
                Voucher drafting, posting, and reversals operate in-memory and update all financial reports with double-entry consistency without persisting to PostgreSQL.
              </p>
            </div>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-900/60 border border-amber-700/60 text-amber-300 self-start sm:self-auto shrink-0">
            In-Memory Simulation
          </span>
        </div>
      )}

      {/* Messages */}
      {errorMessage && (
        <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3.5 text-xs text-red-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="text-red-400 hover:text-red-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="bg-emerald-950/60 border border-emerald-800/60 rounded-xl p-3.5 text-xs text-emerald-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="text-emerald-400 hover:text-emerald-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Controls & Filter Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {(['ALL', 'DRAFT', 'POSTED', 'REVERSED'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                statusFilter === s
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
              }`}
            >
              {s === 'ALL' ? 'All Vouchers' : s}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Search voucher or narration..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-500 w-48 sm:w-56"
            />
          </div>

          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            title="From Date"
          />
          <span className="text-slate-400 text-xs">to</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            title="To Date"
          />
        </div>
      </div>

      {/* Journal Vouchers Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/80 text-[11px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">Voucher No</th>
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Narration</th>
                <th className="py-3 px-4 text-right">Debit</th>
                <th className="py-3 px-4 text-right">Credit</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4">Created By</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-sans">
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    Loading journals...
                  </td>
                </tr>
              ) : journals.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    No journal vouchers found matching current criteria.
                  </td>
                </tr>
              ) : (
                journals.map((j) => (
                  <tr key={j.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3 px-4 font-mono font-medium text-slate-100">
                      {j.voucherNumber}
                      {j.reference && (
                        <div className="text-[10px] text-slate-400 font-sans">Ref: {j.reference}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-300 whitespace-nowrap">{j.entryDate}</td>
                    <td className="py-3 px-4 text-slate-300 max-w-xs truncate" title={j.narration}>
                      {j.narration}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-medium text-emerald-400">
                      ${parseFloat(j.totalDebit).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-3 px-4 text-right font-mono font-medium text-emerald-400">
                      ${parseFloat(j.totalCredit).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">{getStatusBadge(j.status)}</td>
                    <td className="py-3 px-4 text-slate-400 whitespace-nowrap">
                      {j.createdByUserName || 'System'}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          onClick={() => setViewingJournal(j)}
                          className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-medium transition cursor-pointer"
                          title="View Lines"
                        >
                          <Eye className="w-3.5 h-3.5 inline mr-1" />
                          View
                        </button>

                        {j.status === 'DRAFT' && (
                          <button
                            onClick={() => handlePostJournal(j)}
                            disabled={actionLoadingId === j.id}
                            className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[11px] font-medium transition cursor-pointer"
                            title="Post Journal"
                          >
                            <Send className="w-3.5 h-3.5 inline mr-1" />
                            Post
                          </button>
                        )}

                        {j.status === 'POSTED' && (
                          <button
                            onClick={() => {
                              setReversingJournal(j);
                              setReversalReason('');
                            }}
                            className="px-2 py-1 bg-purple-950/80 hover:bg-purple-900 border border-purple-800/80 text-purple-300 rounded text-[11px] font-medium transition cursor-pointer"
                            title="Reverse Voucher"
                          >
                            <RotateCcw className="w-3.5 h-3.5 inline mr-1" />
                            Reverse
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 1. Create Journal Voucher Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl shadow-2xl p-6 space-y-5 my-8">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <Plus className="w-5 h-5 text-indigo-400" />
                  Create Double-Entry Journal Voucher
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Postings are strictly balanced at database level with Decimal(18,4) precision
                </p>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateVoucher} className="space-y-5">
              {/* Header Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Entry Date <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={entryDate}
                    onChange={(e) => setEntryDate(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Reference / Bill No
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. INV-10492"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Narration / Description <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Office supplies purchase"
                    value={narration}
                    onChange={(e) => setNarration(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Posting Lines Table */}
              <div className="border border-slate-800 rounded-xl overflow-hidden">
                <div className="bg-slate-950/70 p-3 flex items-center justify-between border-b border-slate-800">
                  <span className="text-xs font-semibold text-slate-200">
                    Posting Lines (Minimum 2 required)
                  </span>
                  <button
                    type="button"
                    onClick={handleAddLine}
                    className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Add Line</span>
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950 text-slate-400 text-[11px] uppercase tracking-wider border-b border-slate-800">
                      <tr>
                        <th className="py-2.5 px-3 w-10">#</th>
                        <th className="py-2.5 px-3 w-1/3">Account Ledger</th>
                        <th className="py-2.5 px-3">Line Description</th>
                        <th className="py-2.5 px-3 w-32 text-right">Debit ($)</th>
                        <th className="py-2.5 px-3 w-32 text-right">Credit ($)</th>
                        <th className="py-2.5 px-3 w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 bg-slate-900/40">
                      {draftLines.map((line, idx) => (
                        <tr key={idx}>
                          <td className="py-2 px-3 text-slate-400 font-mono text-center">{idx + 1}</td>
                          <td className="py-2 px-3">
                            <select
                              required
                              value={line.ledgerId}
                              onChange={(e) => handleLineChange(idx, 'ledgerId', e.target.value)}
                              className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                            >
                              <option value="">-- Select Ledger --</option>
                              {ledgers.map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.code ? `[${l.code}] ` : ''}
                                  {l.name} ({l.rootType})
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="text"
                              placeholder="Optional item detail"
                              value={line.description}
                              onChange={(e) => handleLineChange(idx, 'description', e.target.value)}
                              className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder-slate-400 focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="number"
                              step="0.0001"
                              min="0"
                              placeholder="0.0000"
                              value={line.debit}
                              onChange={(e) => handleLineChange(idx, 'debit', e.target.value)}
                              className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 text-right font-mono focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="number"
                              step="0.0001"
                              min="0"
                              placeholder="0.0000"
                              value={line.credit}
                              onChange={(e) => handleLineChange(idx, 'credit', e.target.value)}
                              className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 text-right font-mono focus:outline-none focus:border-indigo-500"
                            />
                          </td>
                          <td className="py-2 px-3 text-center">
                            {draftLines.length > 2 && (
                              <button
                                type="button"
                                onClick={() => handleRemoveLine(idx)}
                                className="text-slate-400 hover:text-red-400 cursor-pointer p-1"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-slate-950 font-mono text-xs border-t border-slate-800">
                      <tr>
                        <td colSpan={3} className="py-3 px-3 text-right font-semibold text-slate-300">
                          Total:
                        </td>
                        <td className="py-3 px-3 text-right font-bold text-emerald-400">
                          ${totalDebitModal.toFixed(4)}
                        </td>
                        <td className="py-3 px-3 text-right font-bold text-emerald-400">
                          ${totalCreditModal.toFixed(4)}
                        </td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              {/* Real-time Balanced State Banner */}
              <div
                className={`p-3.5 rounded-xl border flex items-center justify-between text-xs ${
                  isBalanced
                    ? 'bg-emerald-950/60 border-emerald-800/60 text-emerald-200'
                    : 'bg-amber-950/60 border-amber-800/60 text-amber-200'
                }`}
              >
                <div className="flex items-center gap-2">
                  {isBalanced ? (
                    <ShieldCheck className="w-5 h-5 text-emerald-400" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-amber-400" />
                  )}
                  <div>
                    <div className="font-semibold">
                      {isBalanced ? 'Journal Voucher is Balanced' : 'Journal Voucher is Out of Balance'}
                    </div>
                    <div className="text-[11px] opacity-80">
                      {isBalanced
                        ? 'Total debit matches total credit. Ready to save as draft.'
                        : `Difference: $${difference.toFixed(4)}. Debit and Credit totals must be non-zero and equal.`}
                    </div>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !isBalanced}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-xs font-semibold shadow-md transition cursor-pointer"
                >
                  {isSubmitting ? 'Saving Voucher...' : 'Save as Draft Voucher'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. View Journal Voucher Lines Modal */}
      {viewingJournal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-3xl shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-slate-100 font-mono">
                    {viewingJournal.voucherNumber}
                  </h3>
                  {getStatusBadge(viewingJournal.status)}
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  Date: {viewingJournal.entryDate} • Narration: {viewingJournal.narration}
                </p>
              </div>
              <button
                onClick={() => setViewingJournal(null)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="border border-slate-800 rounded-xl overflow-hidden">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-950 text-slate-400 text-[11px] uppercase tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-3 w-10">#</th>
                    <th className="py-2.5 px-3">Ledger Code &amp; Name</th>
                    <th className="py-2.5 px-3">Line Memo</th>
                    <th className="py-2.5 px-3 text-right">Debit</th>
                    <th className="py-2.5 px-3 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 font-sans">
                  {viewingJournal.lines.map((l) => (
                    <tr key={l.id} className="hover:bg-slate-800/40">
                      <td className="py-2.5 px-3 font-mono text-slate-400">{l.lineNumber}</td>
                      <td className="py-2.5 px-3 font-medium text-slate-200">
                        {l.ledgerCode ? `[${l.ledgerCode}] ` : ''}
                        {l.ledgerName}
                      </td>
                      <td className="py-2.5 px-3 text-slate-400">{l.description || '—'}</td>
                      <td className="py-2.5 px-3 text-right font-mono text-emerald-400 font-medium">
                        {parseFloat(l.debit) > 0
                          ? `$${parseFloat(l.debit).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                          : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-emerald-400 font-medium">
                        {parseFloat(l.credit) > 0
                          ? `$${parseFloat(l.credit).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-950 font-mono text-xs border-t border-slate-800">
                  <tr>
                    <td colSpan={3} className="py-3 px-3 text-right font-semibold text-slate-300">
                      Total:
                    </td>
                    <td className="py-3 px-3 text-right font-bold text-emerald-400">
                      ${parseFloat(viewingJournal.totalDebit).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-3 px-3 text-right font-bold text-emerald-400">
                      ${parseFloat(viewingJournal.totalCredit).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="text-[11px] text-slate-400 space-y-1 bg-slate-950/60 p-3 rounded-xl border border-slate-800">
              <div>Created by: <span className="text-slate-300 font-medium">{viewingJournal.createdByUserName || 'System'}</span></div>
              {viewingJournal.postedByUserName && (
                <div>Posted by: <span className="text-slate-300 font-medium">{viewingJournal.postedByUserName}</span> at {viewingJournal.postedAt}</div>
              )}
              {viewingJournal.reversedByUserName && (
                <div>Reversed by: <span className="text-slate-300 font-medium">{viewingJournal.reversedByUserName}</span> at {viewingJournal.reversedAt}</div>
              )}
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => setViewingJournal(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Reversal Reason Modal */}
      {reversingJournal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <RotateCcw className="w-5 h-5 text-purple-400" />
                Reverse Journal Voucher
              </h3>
              <button
                onClick={() => setReversingJournal(null)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleReverseJournal} className="space-y-4">
              <div className="text-xs text-slate-300">
                You are about to reverse voucher{' '}
                <span className="font-mono font-bold text-purple-400">{reversingJournal.voucherNumber}</span>.
                This creates an immutable inverse posting voucher and marks the original as REVERSED.
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Reversal Reason <span className="text-red-400">*</span>
                </label>
                <textarea
                  required
                  rows={3}
                  placeholder="Specify audit reason for reversal..."
                  value={reversalReason}
                  onChange={(e) => setReversalReason(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-slate-200 placeholder-slate-400 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setReversingJournal(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isReversing || !reversalReason.trim()}
                  className="px-5 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-md transition cursor-pointer"
                >
                  {isReversing ? 'Reversing...' : 'Confirm Reversal'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
