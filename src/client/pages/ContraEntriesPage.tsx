import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ArrowLeftRight,
  Plus,
  Search,
  CheckCircle2,
  AlertCircle,
  Clock,
  RotateCcw,
  Send,
  Eye,
  X,
  FileSpreadsheet,
  ArrowRight,
  ShieldCheck,
  Building2,
  Wallet,
  Landmark,
  ArrowDownLeft,
  ArrowUpRight,
  RefreshCw,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import {
  ContraEntryItem,
  ContraTransferType,
  JournalStatus,
  AccountLedgerItem,
  AuthUser,
  CreateContraEntryRequest,
  CompanyProfile,
} from '../../shared/types.ts';
import {
  previewStore,
  PREVIEW_ACCOUNT_LEDGERS,
} from '../services/previewStore.ts';

interface ContraEntriesPageProps {
  currentUser: AuthUser | null;
  companyProfile?: CompanyProfile | null;
  onNavigateToLedger?: (ledgerId: string) => void;
}

export const ContraEntriesPage: React.FC<ContraEntriesPageProps> = ({
  currentUser,
  companyProfile,
}) => {
  const [contraEntries, setContraEntries] = useState<ContraEntryItem[]>([]);
  const [ledgers, setLedgers] = useState<AccountLedgerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<JournalStatus | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Modals
  const [viewingEntry, setViewingEntry] = useState<ContraEntryItem | null>(null);
  const [reversingEntry, setReversingEntry] = useState<ContraEntryItem | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const [isReversing, setIsReversing] = useState(false);

  // Create Contra Modal
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [contraType, setContraType] = useState<ContraTransferType>('CASH_TO_BANK');
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [sourceLedgerId, setSourceLedgerId] = useState('');
  const [destinationLedgerId, setDestinationLedgerId] = useState('');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [narration, setNarration] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const isPreview = Boolean(currentUser?.isPreview);

  // Filter ledgers to Cash & Bank accounts
  const cashAndBankLedgers = useMemo(() => {
    return ledgers.filter((l) => {
      if (l.rootType !== 'ASSET') return false;
      const text = `${l.name} ${l.groupName || ''}`.toLowerCase();
      // Exclude trade receivables and non-liquid assets
      if (
        /\b(receivable|debtor|inventory|stock|equipment|machinery|building|furniture|vehicle|asset\s*clearing|fixed\s*asset)\b/i.test(
          text
        )
      ) {
        return false;
      }
      return true;
    });
  }, [ledgers]);

  // Helper to categorize account as Cash or Bank
  const getAccountCategory = (l: AccountLedgerItem): 'CASH' | 'BANK' => {
    const text = `${l.name} ${l.groupName || ''}`.toLowerCase();
    if (/\b(cash|vault|till|drawer|petty)\b/i.test(text)) {
      return 'CASH';
    }
    return 'BANK';
  };

  const cashAccounts = useMemo(
    () => cashAndBankLedgers.filter((l) => getAccountCategory(l) === 'CASH'),
    [cashAndBankLedgers]
  );
  const bankAccounts = useMemo(
    () => cashAndBankLedgers.filter((l) => getAccountCategory(l) === 'BANK'),
    [cashAndBankLedgers]
  );

  // Pre-select accounts when transfer type preset changes
  const handleTransferTypeChange = (type: ContraTransferType) => {
    setContraType(type);
    if (type === 'CASH_TO_BANK') {
      if (cashAccounts.length > 0) setSourceLedgerId(cashAccounts[0].id);
      if (bankAccounts.length > 0) setDestinationLedgerId(bankAccounts[0].id);
    } else if (type === 'BANK_TO_CASH') {
      if (bankAccounts.length > 0) setSourceLedgerId(bankAccounts[0].id);
      if (cashAccounts.length > 0) setDestinationLedgerId(cashAccounts[0].id);
    } else if (type === 'BANK_TO_BANK') {
      if (bankAccounts.length > 0) setSourceLedgerId(bankAccounts[0].id);
      if (bankAccounts.length > 1) setDestinationLedgerId(bankAccounts[1].id);
      else if (bankAccounts.length > 0) setDestinationLedgerId('');
    } else if (type === 'CASH_TO_CASH') {
      if (cashAccounts.length > 0) setSourceLedgerId(cashAccounts[0].id);
      if (cashAccounts.length > 1) setDestinationLedgerId(cashAccounts[1].id);
      else if (cashAccounts.length > 0) setDestinationLedgerId('');
    }
  };

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    // Preview Mode handling
    if (isPreview) {
      const filtered = previewStore.getContraEntries({
        status: statusFilter,
        search,
        fromDate,
        toDate,
      });
      setContraEntries(filtered);
      setLedgers(PREVIEW_ACCOUNT_LEDGERS);
      setIsLoading(false);
      return;
    }

    try {
      const [entriesData, ledgersData] = await Promise.all([
        api.getContraEntries({
          status: statusFilter === 'ALL' ? undefined : statusFilter,
          search: search.trim() || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        }),
        api.getAccountLedgers({ isActive: true }),
      ]);
      setContraEntries(entriesData);
      setLedgers(ledgersData);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load contra entries.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [isPreview, statusFilter, search, fromDate, toDate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleOpenCreateModal = () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setEntryDate(new Date().toISOString().split('T')[0]);
    setAmount('');
    setReference('');
    setNarration('');
    handleTransferTypeChange('CASH_TO_BANK');
    setIsCreateModalOpen(true);
  };

  const handleSubmitContra = async (autoPost: boolean) => {
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!sourceLedgerId || !destinationLedgerId) {
      setErrorMessage('Please select both a source and destination account.');
      return;
    }

    if (sourceLedgerId === destinationLedgerId) {
      setErrorMessage('Source and destination accounts must be different accounts.');
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setErrorMessage('Please enter a valid transfer amount greater than 0.00.');
      return;
    }

    setIsSubmitting(true);
    const payload: CreateContraEntryRequest = {
      entryDate,
      sourceLedgerId,
      destinationLedgerId,
      amount: amountNum.toFixed(4),
      contraType,
      reference: reference.trim() || null,
      narration: narration.trim() || null,
      autoPost,
    };

    try {
      if (isPreview) {
        const created = previewStore.createContraEntry(payload, currentUser);
        setSuccessMessage(
          `Demo contra voucher ${created.voucherNumber} ${
            autoPost ? 'posted' : 'saved as draft'
          } in preview memory.`
        );
      } else {
        const created = await api.createContraEntry(payload);
        setSuccessMessage(
          `Contra voucher ${created.voucherNumber} ${
            autoPost ? 'posted successfully' : 'saved as draft'
          }.`
        );
      }
      setIsCreateModalOpen(false);
      await loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to create contra voucher.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePostEntry = async (entry: ContraEntryItem) => {
    if (entry.status !== 'DRAFT') return;
    setActionLoadingId(entry.id);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      if (isPreview) {
        previewStore.postContraEntry(entry.id, currentUser);
        setSuccessMessage(`Demo voucher ${entry.voucherNumber} posted in preview memory.`);
      } else {
        await api.postContraEntry(entry.id);
        setSuccessMessage(`Contra voucher ${entry.voucherNumber} posted to General Ledger.`);
      }
      await loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage(`Failed to post voucher ${entry.voucherNumber}.`);
      }
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleConfirmReversal = async () => {
    if (!reversingEntry) return;
    if (!reversalReason.trim()) {
      setErrorMessage('Reason for reversal is required.');
      return;
    }

    setIsReversing(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      if (isPreview) {
        const res = previewStore.reverseContraEntry(
          reversingEntry.id,
          reversalReason.trim(),
          currentUser
        );
        if (res) {
          setSuccessMessage(
            `Demo voucher ${reversingEntry.voucherNumber} reversed. Reversal voucher ${res.reversal.voucherNumber} recorded.`
          );
        }
      } else {
        const res = await api.reverseContraEntry(reversingEntry.id, reversalReason.trim());
        setSuccessMessage(
          `Voucher ${reversingEntry.voucherNumber} reversed. Reversal voucher ${res.reversal.voucherNumber} created.`
        );
      }
      setReversingEntry(null);
      setReversalReason('');
      await loadData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage(`Failed to reverse voucher ${reversingEntry.voucherNumber}.`);
      }
    } finally {
      setIsReversing(false);
    }
  };

  // Selected ledger objects for create modal
  const selectedSource = useMemo(
    () => ledgers.find((l) => l.id === sourceLedgerId),
    [ledgers, sourceLedgerId]
  );
  const selectedDest = useMemo(
    () => ledgers.find((l) => l.id === destinationLedgerId),
    [ledgers, destinationLedgerId]
  );

  const getContraTypeBadge = (type: ContraTransferType) => {
    switch (type) {
      case 'CASH_TO_BANK':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            <ArrowUpRight className="w-3 h-3" /> Cash to Bank
          </span>
        );
      case 'BANK_TO_CASH':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <ArrowDownLeft className="w-3 h-3" /> Bank to Cash
          </span>
        );
      case 'BANK_TO_BANK':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
            <Landmark className="w-3 h-3" /> Bank to Bank
          </span>
        );
      case 'CASH_TO_CASH':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-violet-500/10 text-violet-400 border border-violet-500/20">
            <Wallet className="w-3 h-3" /> Cash to Cash
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-300 border border-slate-700">
            <ArrowLeftRight className="w-3 h-3" /> Internal Transfer
          </span>
        );
    }
  };

  const getStatusBadge = (status: JournalStatus) => {
    switch (status) {
      case 'POSTED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <CheckCircle2 className="w-3.5 h-3.5" /> Posted
          </span>
        );
      case 'DRAFT':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
            <Clock className="w-3.5 h-3.5" /> Draft
          </span>
        );
      case 'REVERSED':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/30">
            <RotateCcw className="w-3.5 h-3.5" /> Reversed
          </span>
        );
      default:
        return null;
    }
  };

  const currencyCode = companyProfile?.currency || 'USD';

  return (
    <div className="space-y-6">
      {/* Top Banner for Preview Exploration Mode */}
      {isPreview && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-4 h-4 shrink-0 text-amber-400" />
            <span>
              <strong>Preview Exploration Mode:</strong> Contra vouchers are tracked in temporary browser memory.
              No unauthenticated live API calls or persistent database changes occur.
            </span>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-950/80 border border-amber-800">
            In-Memory Mock
          </span>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
              <ArrowLeftRight className="w-4 h-4" />
            </div>
            <h1 className="text-xl font-bold text-slate-100">Contra Entries</h1>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Record internal cash and bank transfers (Cash to Bank, Bank to Cash, Bank to Bank, Cash to Cash) with double-entry General Ledger balancing.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => loadData()}
            title="Refresh list"
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>

          <button
            onClick={handleOpenCreateModal}
            className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New Contra Entry</span>
          </button>
        </div>
      </div>

      {/* Notifications */}
      {errorMessage && (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{errorMessage}</span>
          </div>
          <button onClick={() => setErrorMessage(null)} className="cursor-pointer text-rose-400 hover:text-rose-200">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>{successMessage}</span>
          </div>
          <button onClick={() => setSuccessMessage(null)} className="cursor-pointer text-emerald-400 hover:text-emerald-200">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Quick Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-800">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400" /> Cash to Bank
          </div>
          <div className="text-lg font-bold text-slate-100 mt-1 font-mono">
            {contraEntries.filter((c) => c.contraType === 'CASH_TO_BANK').length}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">Cash deposits into bank</div>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-800">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <ArrowDownLeft className="w-3.5 h-3.5 text-amber-400" /> Bank to Cash
          </div>
          <div className="text-lg font-bold text-slate-100 mt-1 font-mono">
            {contraEntries.filter((c) => c.contraType === 'BANK_TO_CASH').length}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">Withdrawals & petty cash</div>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-800">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Landmark className="w-3.5 h-3.5 text-indigo-400" /> Bank to Bank
          </div>
          <div className="text-lg font-bold text-slate-100 mt-1 font-mono">
            {contraEntries.filter((c) => c.contraType === 'BANK_TO_BANK').length}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">Internal account transfers</div>
        </div>

        <div className="p-3.5 rounded-xl bg-slate-900 border border-slate-800">
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Wallet className="w-3.5 h-3.5 text-violet-400" /> Cash to Cash
          </div>
          <div className="text-lg font-bold text-slate-100 mt-1 font-mono">
            {contraEntries.filter((c) => c.contraType === 'CASH_TO_CASH').length}
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">Vault to till replenishment</div>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
        <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
          {/* Status Tabs */}
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
            {(['ALL', 'POSTED', 'DRAFT', 'REVERSED'] as const).map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition cursor-pointer ${
                  statusFilter === st
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                {st === 'ALL' ? 'All Vouchers' : st.charAt(0) + st.slice(1).toLowerCase()}
              </button>
            ))}
          </div>

          {/* Search Input */}
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search by CV- voucher number, reference, or narration..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* Date range inputs */}
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
              title="From Date"
            />
            <span className="text-slate-600 text-xs">to</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
              title="To Date"
            />
            {(fromDate || toDate || search) && (
              <button
                onClick={() => {
                  setFromDate('');
                  setToDate('');
                  setSearch('');
                }}
                className="text-[11px] text-slate-400 hover:text-slate-200 px-2 py-1 cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Contra Entries Table */}
      <div className="border border-slate-800 rounded-xl bg-slate-900 overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="p-12 text-center text-xs text-slate-400">Loading contra entries...</div>
        ) : contraEntries.length === 0 ? (
          <div className="p-12 text-center space-y-2">
            <ArrowLeftRight className="w-8 h-8 text-slate-600 mx-auto" />
            <div className="text-sm font-semibold text-slate-300">No Contra Entries Found</div>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              {statusFilter !== 'ALL' || search || fromDate || toDate
                ? 'No contra vouchers match the current filters.'
                : 'No contra transfers have been recorded yet. Click "New Contra Entry" to create a deposit, withdrawal, or internal account transfer.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-950/70 border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                <tr>
                  <th className="py-3 px-4">Voucher No.</th>
                  <th className="py-3 px-4">Date</th>
                  <th className="py-3 px-4">Type</th>
                  <th className="py-3 px-4">Source Account (Cr)</th>
                  <th className="py-3 px-4"></th>
                  <th className="py-3 px-4">Destination Account (Dr)</th>
                  <th className="py-3 px-4 text-right">Amount</th>
                  <th className="py-3 px-4 text-center">Status</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono text-xs">
                {contraEntries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3 px-4 font-bold text-indigo-400 whitespace-nowrap">
                      {entry.voucherNumber}
                      {entry.reference && (
                        <span className="block text-[10px] font-normal text-slate-500 font-sans">
                          Ref: {entry.reference}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-slate-400 whitespace-nowrap">{entry.entryDate}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{getContraTypeBadge(entry.contraType)}</td>
                    <td className="py-3 px-4 font-sans font-medium text-slate-200">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
                        <span>{entry.sourceLedgerName}</span>
                      </div>
                      {entry.sourceLedgerCode && (
                        <span className="text-[10px] text-slate-500 font-mono">
                          [{entry.sourceLedgerCode}]
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-2 text-slate-500 text-center">
                      <ArrowRight className="w-3.5 h-3.5 text-slate-600 inline" />
                    </td>
                    <td className="py-3 px-4 font-sans font-medium text-slate-200">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        <span>{entry.destinationLedgerName}</span>
                      </div>
                      {entry.destinationLedgerCode && (
                        <span className="text-[10px] text-slate-500 font-mono">
                          [{entry.destinationLedgerCode}]
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-bold text-slate-100 whitespace-nowrap font-mono">
                      {currencyCode} {parseFloat(entry.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-3 px-4 text-center whitespace-nowrap">{getStatusBadge(entry.status)}</td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => setViewingEntry(entry)}
                          title="View Voucher Details"
                          className="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition cursor-pointer"
                        >
                          <Eye className="w-4 h-4" />
                        </button>

                        {entry.status === 'DRAFT' && (
                          <button
                            onClick={() => handlePostEntry(entry)}
                            disabled={actionLoadingId === entry.id}
                            title="Post to General Ledger"
                            className="p-1.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 transition cursor-pointer disabled:opacity-50"
                          >
                            <Send className="w-4 h-4" />
                          </button>
                        )}

                        {entry.status === 'POSTED' && (
                          <button
                            onClick={() => {
                              setReversingEntry(entry);
                              setReversalReason('');
                            }}
                            title="Reverse Contra Voucher"
                            className="p-1.5 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 transition cursor-pointer"
                          >
                            <RotateCcw className="w-4 h-4" />
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

      {/* ======================================================== */}
      {/* CREATE CONTRA ENTRY MODAL */}
      {/* ======================================================== */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden my-8">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-indigo-600/20 text-indigo-400 flex items-center justify-center border border-indigo-500/30">
                  <ArrowLeftRight className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100">Record Internal Contra Transfer</h3>
                  <p className="text-[11px] text-slate-400">
                    Debit destination account &amp; credit source account for identical amounts (CV-YYYY-XXXX).
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSubmitContra(false);
              }}
              className="p-5 space-y-5"
            >
              {/* Transfer Type Preset Selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Transfer Modality Preset
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => handleTransferTypeChange('CASH_TO_BANK')}
                    className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                      contraType === 'CASH_TO_BANK'
                        ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                        : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-bold">
                      <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400" /> Cash to Bank
                    </div>
                    <div className="text-[10px] opacity-75 mt-0.5">Cash Deposit</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleTransferTypeChange('BANK_TO_CASH')}
                    className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                      contraType === 'BANK_TO_CASH'
                        ? 'bg-amber-600/20 border-amber-500 text-amber-300'
                        : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-bold">
                      <ArrowDownLeft className="w-3.5 h-3.5 text-amber-400" /> Bank to Cash
                    </div>
                    <div className="text-[10px] opacity-75 mt-0.5">Withdrawal</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleTransferTypeChange('BANK_TO_BANK')}
                    className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                      contraType === 'BANK_TO_BANK'
                        ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300'
                        : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-bold">
                      <Landmark className="w-3.5 h-3.5 text-indigo-400" /> Bank to Bank
                    </div>
                    <div className="text-[10px] opacity-75 mt-0.5">Account Transfer</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleTransferTypeChange('CASH_TO_CASH')}
                    className={`p-2.5 rounded-xl border text-left transition cursor-pointer ${
                      contraType === 'CASH_TO_CASH'
                        ? 'bg-violet-600/20 border-violet-500 text-violet-300'
                        : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-bold">
                      <Wallet className="w-3.5 h-3.5 text-violet-400" /> Cash to Cash
                    </div>
                    <div className="text-[10px] opacity-75 mt-0.5">Till Replenish</div>
                  </button>
                </div>
              </div>

              {/* Date & Amount */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Posting Date <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={entryDate}
                    onChange={(e) => setEntryDate(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Transfer Amount ({currencyCode}) <span className="text-rose-400">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs font-mono">
                      {currencyCode}
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-14 pr-3 py-2 text-xs text-slate-200 font-mono font-bold focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              </div>

              {/* Account Selection */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Source Account (Credit) */}
                <div>
                  <label className="block text-xs font-medium text-rose-400 mb-1 flex items-center justify-between">
                    <span>Source Account (Credited — Funds Out) *</span>
                    <span className="text-[10px] text-slate-500 font-mono">Cr</span>
                  </label>
                  <select
                    required
                    value={sourceLedgerId}
                    onChange={(e) => setSourceLedgerId(e.target.value)}
                    className="w-full bg-slate-950 border border-rose-500/40 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
                  >
                    <option value="">-- Select Source Cash/Bank Ledger --</option>
                    {cashAndBankLedgers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} [{l.code || 'Ledger'}] ({getAccountCategory(l)})
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px] text-slate-500 mt-1">
                    Funds will be deducted from this active asset ledger.
                  </p>
                </div>

                {/* Destination Account (Debit) */}
                <div>
                  <label className="block text-xs font-medium text-emerald-400 mb-1 flex items-center justify-between">
                    <span>Destination Account (Debited — Funds In) *</span>
                    <span className="text-[10px] text-slate-500 font-mono">Dr</span>
                  </label>
                  <select
                    required
                    value={destinationLedgerId}
                    onChange={(e) => setDestinationLedgerId(e.target.value)}
                    className="w-full bg-slate-950 border border-emerald-500/40 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">-- Select Destination Cash/Bank Ledger --</option>
                    {cashAndBankLedgers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} [{l.code || 'Ledger'}] ({getAccountCategory(l)})
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px] text-slate-500 mt-1">
                    Funds will be deposited into this active asset ledger.
                  </p>
                </div>
              </div>

              {/* Dynamic Double-Entry Flow Visualizer */}
              {selectedSource && selectedDest && (
                <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Double-Entry Flow Verification
                  </div>
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
                    <div className="flex-1 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 w-full sm:w-auto">
                      <div className="text-[10px] text-rose-400 uppercase font-semibold">Credit (Outflow)</div>
                      <div className="font-bold truncate">{selectedSource.name}</div>
                      <div className="text-[10px] font-mono text-slate-400">
                        Amount: {currencyCode} {parseFloat(amount || '0').toFixed(2)}
                      </div>
                    </div>

                    <ArrowRight className="w-4 h-4 text-slate-500 shrink-0 hidden sm:block" />

                    <div className="flex-1 p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 w-full sm:w-auto">
                      <div className="text-[10px] text-emerald-400 uppercase font-semibold">Debit (Inflow)</div>
                      <div className="font-bold truncate">{selectedDest.name}</div>
                      <div className="text-[10px] font-mono text-slate-400">
                        Amount: {currencyCode} {parseFloat(amount || '0').toFixed(2)}
                      </div>
                    </div>
                  </div>
                  {sourceLedgerId === destinationLedgerId && (
                    <div className="text-[11px] text-rose-400 font-medium">
                      ⚠️ Error: Source and destination accounts cannot be identical.
                    </div>
                  )}
                </div>
              )}

              {/* Reference & Narration */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Transaction Reference (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Deposit Slip #1234, Cheque #8891, Wire Ref"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Narration / Notes (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Transfer vault cash to main checking account"
                    value={narration}
                    onChange={(e) => setNarration(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Action Buttons */}
              <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  disabled={isSubmitting}
                  className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition cursor-pointer"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={isSubmitting || sourceLedgerId === destinationLedgerId}
                  className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-indigo-700/50 text-xs font-semibold transition cursor-pointer disabled:opacity-50"
                >
                  Save as Draft
                </button>

                <button
                  type="button"
                  onClick={() => handleSubmitContra(true)}
                  disabled={isSubmitting || sourceLedgerId === destinationLedgerId}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/20 transition cursor-pointer disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{isSubmitting ? 'Posting...' : 'Post Immediately'}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* VIEW VOUCHER MODAL */}
      {/* ======================================================== */}
      {viewingEntry && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-slate-100 font-mono">
                    {viewingEntry.voucherNumber}
                  </h3>
                  {getStatusBadge(viewingEntry.status)}
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  Contra Transfer Voucher • {viewingEntry.entryDate}
                </div>
              </div>
              <button
                onClick={() => setViewingEntry(null)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3 p-3 rounded-xl bg-slate-950 border border-slate-800">
                <div>
                  <div className="text-slate-500 text-[10px] uppercase">Transfer Modality</div>
                  <div className="font-semibold text-slate-200 mt-0.5">
                    {getContraTypeBadge(viewingEntry.contraType)}
                  </div>
                </div>

                <div>
                  <div className="text-slate-500 text-[10px] uppercase">Total Transfer Amount</div>
                  <div className="font-mono font-bold text-slate-100 text-sm mt-0.5">
                    {currencyCode} {parseFloat(viewingEntry.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </div>
                </div>

                {viewingEntry.reference && (
                  <div>
                    <div className="text-slate-500 text-[10px] uppercase">Reference</div>
                    <div className="text-slate-200 font-mono">{viewingEntry.reference}</div>
                  </div>
                )}

                <div>
                  <div className="text-slate-500 text-[10px] uppercase">Audit Trail</div>
                  <div className="text-slate-300 text-[11px]">
                    Created by {viewingEntry.createdByUserName || 'System'}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-1">
                  Narration
                </div>
                <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-slate-300">
                  {viewingEntry.narration}
                </div>
              </div>

              {/* Double-entry posting lines */}
              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold mb-2">
                  Double-Entry Ledger Postings
                </div>
                <div className="border border-slate-800 rounded-xl overflow-hidden">
                  <table className="w-full text-left text-xs text-slate-300">
                    <thead className="bg-slate-950 border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
                      <tr>
                        <th className="py-2 px-3">#</th>
                        <th className="py-2 px-3">Account Ledger</th>
                        <th className="py-2 px-3 text-right">Debit ({currencyCode})</th>
                        <th className="py-2 px-3 text-right">Credit ({currencyCode})</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono text-xs">
                      {viewingEntry.lines.map((l) => (
                        <tr key={l.id || l.lineNumber}>
                          <td className="py-2 px-3 text-slate-500">{l.lineNumber}</td>
                          <td className="py-2 px-3 font-sans">
                            <span className="font-medium text-slate-200">{l.ledgerName}</span>
                            {l.ledgerCode && (
                              <span className="text-[10px] text-slate-500 font-mono ml-1.5">
                                [{l.ledgerCode}]
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right text-emerald-400">
                            {parseFloat(l.debit) > 0 ? parseFloat(l.debit).toFixed(2) : '-'}
                          </td>
                          <td className="py-2 px-3 text-right text-rose-400">
                            {parseFloat(l.credit) > 0 ? parseFloat(l.credit).toFixed(2) : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-slate-950/80 border-t border-slate-800 font-mono font-bold text-xs">
                      <tr>
                        <td colSpan={2} className="py-2 px-3 font-sans text-slate-400">
                          Total Equilibrium
                        </td>
                        <td className="py-2 px-3 text-right text-emerald-400">
                          {parseFloat(viewingEntry.amount).toFixed(2)}
                        </td>
                        <td className="py-2 px-3 text-right text-rose-400">
                          {parseFloat(viewingEntry.amount).toFixed(2)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-slate-800 flex items-center justify-end">
              <button
                onClick={() => setViewingEntry(null)}
                className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* REVERSAL MODAL */}
      {/* ======================================================== */}
      {reversingEntry && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-5 space-y-4">
            <div className="flex items-center gap-2.5 text-rose-400">
              <RotateCcw className="w-5 h-5 shrink-0" />
              <h3 className="text-sm font-bold text-slate-100">
                Reverse Contra Voucher {reversingEntry.voucherNumber}
              </h3>
            </div>

            <p className="text-xs text-slate-400">
              Reversing this voucher will create an inverse double-entry transaction that debits{' '}
              <strong className="text-slate-200">{reversingEntry.sourceLedgerName}</strong> and credits{' '}
              <strong className="text-slate-200">{reversingEntry.destinationLedgerName}</strong> for{' '}
              <strong className="text-slate-200">{currencyCode} {parseFloat(reversingEntry.amount).toFixed(2)}</strong>.
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Reason for Reversal <span className="text-rose-400">*</span>
              </label>
              <textarea
                required
                rows={3}
                placeholder="e.g. Bank wire cancelled, wrong destination account selected, or duplicate entry"
                value={reversalReason}
                onChange={(e) => setReversalReason(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-xs text-slate-200 focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setReversingEntry(null)}
                disabled={isReversing}
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium cursor-pointer"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleConfirmReversal}
                disabled={isReversing || !reversalReason.trim()}
                className="px-4 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold transition cursor-pointer disabled:opacity-50"
              >
                {isReversing ? 'Reversing...' : 'Confirm Reversal'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
