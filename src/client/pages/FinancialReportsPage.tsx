import React, { useState, useEffect, useCallback } from 'react';
import {
  PieChart,
  Scale,
  TrendingUp,
  FileText,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  RefreshCw,
  ArrowUpRight,
  ArrowDownRight,
  ArrowDownLeft,
  Wallet,
  Landmark,
  Sparkles,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import {
  TrialBalanceReport,
  ProfitAndLossReport,
  BalanceSheetReport,
  LedgerStatementReport,
  OpeningBalanceValidationResult,
  AccountLedgerItem,
  AuthUser,
  CashBankBookReport,
} from '../../shared/types.ts';
import {
  previewStore,
  PREVIEW_ACCOUNT_LEDGERS,
} from '../services/previewStore.ts';

interface FinancialReportsPageProps {
  currentUser: AuthUser;
  initialLedgerId?: string | null;
}

type ReportTab =
  | 'trial-balance'
  | 'cash-book'
  | 'bank-book'
  | 'pnl'
  | 'balance-sheet'
  | 'ledger-statement'
  | 'opening-balances';

export const FinancialReportsPage: React.FC<FinancialReportsPageProps> = ({
  currentUser,
  initialLedgerId,
}) => {
  const isPreview = Boolean(currentUser?.isPreview);

  const [activeTab, setActiveTab] = useState<ReportTab>(
    initialLedgerId ? 'ledger-statement' : 'trial-balance'
  );

  // Global filters
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().split('T')[0]);

  // Loading & error
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Ledgers list for statement selector
  const [ledgers, setLedgers] = useState<AccountLedgerItem[]>([]);
  const [selectedLedgerId, setSelectedLedgerId] = useState<string>(initialLedgerId || '');

  // Cash & Bank Book specific account selection
  const [cashLedgerId, setCashLedgerId] = useState<string>('');
  const [bankLedgerId, setBankLedgerId] = useState<string>('');

  // Report States
  const [trialBalance, setTrialBalance] = useState<TrialBalanceReport | null>(null);
  const [cashBook, setCashBook] = useState<CashBankBookReport | null>(null);
  const [bankBook, setBankBook] = useState<CashBankBookReport | null>(null);
  const [pnl, setPnl] = useState<ProfitAndLossReport | null>(null);
  const [balanceSheet, setBalanceSheet] = useState<BalanceSheetReport | null>(null);
  const [ledgerStatement, setLedgerStatement] = useState<LedgerStatementReport | null>(null);
  const [openingBalValidation, setOpeningBalValidation] = useState<OpeningBalanceValidationResult | null>(null);

  // Load ledgers for selector
  useEffect(() => {
    if (isPreview) {
      setLedgers(PREVIEW_ACCOUNT_LEDGERS);
      if (!selectedLedgerId && PREVIEW_ACCOUNT_LEDGERS.length > 0) {
        setSelectedLedgerId(PREVIEW_ACCOUNT_LEDGERS[0].id);
      }
      return;
    }

    api
      .getAccountLedgers()
      .then((data) => {
        setLedgers(data);
        if (!selectedLedgerId && data.length > 0) {
          setSelectedLedgerId(data[0].id);
        }
      })
      .catch(() => {});
  }, [isPreview, selectedLedgerId]);

  const loadReport = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    // ==========================================
    // Deterministic Offline In-Memory Preview Mode
    // ==========================================
    if (isPreview) {
      try {
        if (activeTab === 'cash-book') {
          const data = previewStore.getCashBook({
            ledgerId: cashLedgerId || undefined,
            fromDate: fromDate || undefined,
            toDate: toDate || undefined,
          });
          setCashBook(data);
          if (!cashLedgerId && data.ledger?.id) {
            setCashLedgerId(data.ledger.id);
          }
        } else if (activeTab === 'bank-book') {
          const data = previewStore.getBankBook({
            ledgerId: bankLedgerId || undefined,
            fromDate: fromDate || undefined,
            toDate: toDate || undefined,
          });
          setBankBook(data);
          if (!bankLedgerId && data.ledger?.id) {
            setBankLedgerId(data.ledger.id);
          }
        } else if (activeTab === 'trial-balance') {
          const data = previewStore.getTrialBalance({
            fromDate: fromDate || undefined,
            toDate: toDate || undefined,
          });
          setTrialBalance(data);
        } else if (activeTab === 'pnl') {
          const data = previewStore.getProfitAndLoss({
            fromDate: fromDate || undefined,
            toDate: toDate || undefined,
          });
          setPnl(data);
        } else if (activeTab === 'balance-sheet') {
          const data = previewStore.getBalanceSheet({
            asOfDate: asOfDate || undefined,
          });
          setBalanceSheet(data);
        } else if (activeTab === 'ledger-statement') {
          if (selectedLedgerId) {
            const data = previewStore.getLedgerStatement(selectedLedgerId, {
              fromDate: fromDate || undefined,
              toDate: toDate || undefined,
            });
            setLedgerStatement(data);
          }
        } else if (activeTab === 'opening-balances') {
          const data = previewStore.validateOpeningBalances();
          setOpeningBalValidation(data);
        }
      } catch (err: unknown) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to generate preview report.');
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // ==========================================
    // Live Authenticated API Requests
    // ==========================================
    try {
      if (activeTab === 'cash-book') {
        const data = await api.getCashBook({
          ledgerId: cashLedgerId || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        });
        setCashBook(data);
        if (!cashLedgerId && data.ledger?.id) {
          setCashLedgerId(data.ledger.id);
        }
      } else if (activeTab === 'bank-book') {
        const data = await api.getBankBook({
          ledgerId: bankLedgerId || undefined,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        });
        setBankBook(data);
        if (!bankLedgerId && data.ledger?.id) {
          setBankLedgerId(data.ledger.id);
        }
      } else if (activeTab === 'trial-balance') {
        const data = await api.getTrialBalance({
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        });
        setTrialBalance(data);
      } else if (activeTab === 'pnl') {
        const data = await api.getProfitAndLoss({
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
        });
        setPnl(data);
      } else if (activeTab === 'balance-sheet') {
        const data = await api.getBalanceSheet({
          asOfDate: asOfDate || undefined,
        });
        setBalanceSheet(data);
      } else if (activeTab === 'ledger-statement') {
        if (selectedLedgerId) {
          const data = await api.getLedgerStatement(selectedLedgerId, {
            fromDate: fromDate || undefined,
            toDate: toDate || undefined,
          });
          setLedgerStatement(data);
        }
      } else if (activeTab === 'opening-balances') {
        const data = await api.validateOpeningBalances();
        setOpeningBalValidation(data);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to generate report.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [
    isPreview,
    activeTab,
    fromDate,
    toDate,
    asOfDate,
    selectedLedgerId,
    cashLedgerId,
    bankLedgerId,
  ]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const formatCurrency = (val: string | number) => {
    const num = typeof val === 'string' ? parseFloat(val) : val;
    return `$${(num || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="space-y-6">
      {/* Preview Mode Active Banner */}
      {isPreview && (
        <div className="bg-amber-950/40 border border-amber-800/60 rounded-2xl p-3.5 flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-200">
            <span className="font-semibold text-amber-300">Preview Mode Active (Non-Persistent):</span>{' '}
            Financial statements, cash book, and bank book reports are computed using in-memory deterministic simulation data. Real database records remain unaffected.
          </div>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <Scale className="w-6 h-6 text-indigo-400" />
            Financial Statements &amp; Ledger Reports
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Real-time PostgreSQL-computed trial balance, cash &amp; bank books, P&amp;L, balance sheet, and general ledger audit statements
          </p>
        </div>

        <button
          onClick={loadReport}
          disabled={isLoading}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition cursor-pointer border border-slate-700"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-indigo-400 ${isLoading ? 'animate-spin' : ''}`} />
          <span>Refresh Data</span>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-3">
        <button
          onClick={() => setActiveTab('trial-balance')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeTab === 'trial-balance'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <Scale className="w-4 h-4" />
          <span>Trial Balance</span>
        </button>

        <button
          onClick={() => setActiveTab('cash-book')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeTab === 'cash-book'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <Wallet className="w-4 h-4" />
          <span>Cash Book</span>
        </button>

        <button
          onClick={() => setActiveTab('bank-book')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeTab === 'bank-book'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <Landmark className="w-4 h-4" />
          <span>Bank Book</span>
        </button>

        <button
          onClick={() => setActiveTab('pnl')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeTab === 'pnl'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <TrendingUp className="w-4 h-4" />
          <span>Profit &amp; Loss</span>
        </button>

        <button
          onClick={() => setActiveTab('balance-sheet')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeTab === 'balance-sheet'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <PieChart className="w-4 h-4" />
          <span>Balance Sheet</span>
        </button>

        <button
          onClick={() => setActiveTab('ledger-statement')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeTab === 'ledger-statement'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <FileText className="w-4 h-4" />
          <span>General Ledger Statement</span>
        </button>

        <button
          onClick={() => setActiveTab('opening-balances')}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
            activeTab === 'opening-balances'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          <ShieldCheck className="w-4 h-4" />
          <span>Opening Balance Audit</span>
        </button>
      </div>

      {/* Date Filter Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          {activeTab === 'balance-sheet' ? (
            <div className="flex items-center gap-2">
              <span className="text-slate-400">As of Date:</span>
              <input
                type="date"
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
                className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-400">Date Range:</span>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 focus:outline-none focus:border-indigo-500"
                title="From Date"
              />
              <span className="text-slate-400">to</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 focus:outline-none focus:border-indigo-500"
                title="To Date"
              />
            </div>
          )}

          {activeTab === 'cash-book' && (
            <div className="flex items-center gap-2">
              <span className="text-slate-400 font-medium">Cash Account:</span>
              <select
                value={cashLedgerId || cashBook?.ledger?.id || ''}
                onChange={(e) => setCashLedgerId(e.target.value)}
                className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 focus:outline-none focus:border-indigo-500 font-medium"
              >
                {(cashBook?.eligibleLedgers && cashBook.eligibleLedgers.length > 0
                  ? cashBook.eligibleLedgers
                  : ledgers.filter(
                      (l) =>
                        l.rootType === 'ASSET' &&
                        /\b(cash|vault|till|drawer|petty)\b/i.test(l.name + ' ' + (l.groupName || ''))
                    )
                ).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code ? `[${l.code}] ` : ''}
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {activeTab === 'bank-book' && (
            <div className="flex items-center gap-2">
              <span className="text-slate-400 font-medium">Bank Account:</span>
              <select
                value={bankLedgerId || bankBook?.ledger?.id || ''}
                onChange={(e) => setBankLedgerId(e.target.value)}
                className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 focus:outline-none focus:border-indigo-500 font-medium"
              >
                {(bankBook?.eligibleLedgers && bankBook.eligibleLedgers.length > 0
                  ? bankBook.eligibleLedgers
                  : ledgers.filter(
                      (l) =>
                        l.rootType === 'ASSET' &&
                        /\b(bank|checking|savings|deposit|current account|treasury|wire|jpmorgan|chase|bofa|citi|wells|barclays|hsbc|svb)\b/i.test(
                          l.name + ' ' + (l.groupName || '')
                        )
                    )
                ).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code ? `[${l.code}] ` : ''}
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {activeTab === 'ledger-statement' && (
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Target Ledger:</span>
              <select
                value={selectedLedgerId}
                onChange={(e) => setSelectedLedgerId(e.target.value)}
                className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 focus:outline-none focus:border-indigo-500 font-medium"
              >
                {ledgers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.code ? `[${l.code}] ` : ''}
                    {l.name} ({l.rootType})
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="text-[11px] text-slate-400 font-mono">
          Precision: Decimal(18,4) • Exact Accounting Calculation
        </div>
      </div>

      {/* Error Alert */}
      {errorMessage && (
        <div className="bg-red-950/60 border border-red-800/60 rounded-xl p-3.5 text-xs text-red-200 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* ======================================================== */}
      {/* 1. TRIAL BALANCE TAB */}
      {/* ======================================================== */}
      {activeTab === 'trial-balance' && trialBalance && (
        <div className="space-y-4">
          {/* Balance Indicator Status Banner */}
          <div
            className={`p-4 rounded-2xl border flex items-center justify-between text-xs ${
              trialBalance.isBalanced
                ? 'bg-emerald-950/50 border-emerald-800/60 text-emerald-200'
                : 'bg-amber-950/50 border-amber-800/60 text-amber-200'
            }`}
          >
            <div className="flex items-center gap-3">
              {trialBalance.isBalanced ? (
                <ShieldCheck className="w-6 h-6 text-emerald-400" />
              ) : (
                <AlertCircle className="w-6 h-6 text-amber-400" />
              )}
              <div>
                <div className="font-bold text-sm">
                  {trialBalance.isBalanced ? 'Trial Balance is Balanced' : 'Trial Balance Out of Balance'}
                </div>
                <div className="text-[11px] opacity-80 mt-0.5">
                  Closing Debits: {formatCurrency(trialBalance.totalClosingDebit)} | Closing Credits: {formatCurrency(trialBalance.totalClosingCredit)}
                </div>
              </div>
            </div>

            <div className="text-right font-mono">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">Imbalance</div>
              <div className="text-sm font-bold text-slate-100">{formatCurrency(trialBalance.imbalanceAmount)}</div>
            </div>
          </div>

          {/* Trial Balance Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-950 text-slate-400 text-[11px] uppercase tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4 w-28">Code</th>
                    <th className="py-3 px-4">Ledger Name</th>
                    <th className="py-3 px-4">Group</th>
                    <th className="py-3 px-4">Classification</th>
                    <th className="py-3 px-4 text-right">Debit ($)</th>
                    <th className="py-3 px-4 text-right">Credit ($)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {trialBalance.rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-12 text-center text-slate-400">
                        No active ledgers or postings found.
                      </td>
                    </tr>
                  ) : (
                    trialBalance.rows.map((row) => (
                      <tr key={row.ledgerId} className="hover:bg-slate-800/40 transition">
                        <td className="py-2.5 px-4 font-mono text-slate-400">{row.code || '—'}</td>
                        <td className="py-2.5 px-4 font-medium text-slate-100">{row.name}</td>
                        <td className="py-2.5 px-4 text-slate-400">{row.groupName}</td>
                        <td className="py-2.5 px-4">
                          <span className="text-[10px] px-2 py-0.5 rounded font-mono bg-slate-800 text-slate-300 border border-slate-700/60">
                            {row.rootType}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono text-emerald-400">
                          {parseFloat(row.closingDebit) > 0 ? formatCurrency(row.closingDebit) : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono text-emerald-400">
                          {parseFloat(row.closingCredit) > 0 ? formatCurrency(row.closingCredit) : '—'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot className="bg-slate-950 font-mono text-xs border-t-2 border-slate-800">
                  <tr>
                    <td colSpan={4} className="py-3.5 px-4 text-right font-bold text-slate-200">
                      Total Trial Balance:
                    </td>
                    <td className="py-3.5 px-4 text-right font-bold text-emerald-400 text-sm">
                      {formatCurrency(trialBalance.totalClosingDebit)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-bold text-emerald-400 text-sm">
                      {formatCurrency(trialBalance.totalClosingCredit)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 2. CASH BOOK TAB */}
      {/* ======================================================== */}
      {activeTab === 'cash-book' && cashBook && (
        <div className="space-y-4">
          {/* Cash Book Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-xs text-slate-400 font-medium">Opening Balance</div>
              <div className="text-lg font-bold text-slate-100 mt-1 flex items-baseline gap-2">
                <span>{formatCurrency(cashBook.openingBalance)}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                  {cashBook.openingBalanceType}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 truncate">
                {cashBook.ledger?.name || 'Selected Cash Account'}
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-xs text-slate-400 font-medium">Total Receipts (Inflow)</div>
              <div className="text-lg font-bold text-emerald-400 mt-1 flex items-center gap-1.5">
                <ArrowDownLeft className="w-4 h-4 text-emerald-400" />
                <span>{formatCurrency(cashBook.totalDebit)}</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Total debits to cash in period</div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-xs text-slate-400 font-medium">Total Payments (Outflow)</div>
              <div className="text-lg font-bold text-rose-400 mt-1 flex items-center gap-1.5">
                <ArrowDownRight className="w-4 h-4 text-rose-400" />
                <span>{formatCurrency(cashBook.totalCredit)}</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Total credits to cash in period</div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-xs text-slate-400 font-medium">Closing Balance</div>
              <div className="text-lg font-bold text-indigo-400 mt-1 flex items-baseline gap-2">
                <span>{formatCurrency(cashBook.closingBalance)}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 font-mono">
                  {cashBook.closingBalanceType}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Effective liquid cash position</div>
            </div>
          </div>

          {/* Cash Book Transactions Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                  <Wallet className="w-4 h-4 text-emerald-400" />
                  <span>{cashBook.ledger?.name || 'Cash Book'} Register</span>
                </h3>
                <p className="text-xs text-slate-400">
                  Showing posted receipts, disbursements, and contra entries with verified running balance
                </p>
              </div>
              <div className="text-xs text-slate-400 font-mono">
                {cashBook.lines.length} transaction{cashBook.lines.length === 1 ? '' : 's'} recorded
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-950/70 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Voucher No</th>
                    <th className="py-3 px-4">Reference</th>
                    <th className="py-3 px-4">Counterparty Account</th>
                    <th className="py-3 px-4">Narration</th>
                    <th className="py-3 px-4 text-right">Receipts (Dr)</th>
                    <th className="py-3 px-4 text-right">Payments (Cr)</th>
                    <th className="py-3 px-4 text-right">Running Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {/* Opening Balance Row */}
                  <tr className="bg-slate-950/40 text-slate-400">
                    <td className="py-2.5 px-4 font-sans text-slate-400">{cashBook.fromDate}</td>
                    <td className="py-2.5 px-4 text-slate-400">—</td>
                    <td className="py-2.5 px-4 text-slate-400">OPENING</td>
                    <td className="py-2.5 px-4 font-sans font-medium text-slate-300">
                      Balance Brought Forward
                    </td>
                    <td className="py-2.5 px-4 font-sans text-slate-400">
                      Opening balance including transactions prior to {cashBook.fromDate}
                    </td>
                    <td className="py-2.5 px-4 text-right text-slate-400">—</td>
                    <td className="py-2.5 px-4 text-right text-slate-400">—</td>
                    <td className="py-2.5 px-4 text-right font-bold text-slate-200">
                      {formatCurrency(cashBook.openingBalance)}{' '}
                      <span className="text-[10px] text-slate-400">{cashBook.openingBalanceType}</span>
                    </td>
                  </tr>

                  {cashBook.lines.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-400 font-sans">
                        No posted cash transactions recorded for this ledger within the selected date range.
                      </td>
                    </tr>
                  ) : (
                    cashBook.lines.map((l) => (
                      <tr key={l.id || l.journalId} className="hover:bg-slate-800/40 transition">
                        <td className="py-2.5 px-4 whitespace-nowrap text-slate-300 font-sans">{l.entryDate}</td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                              l.voucherNumber.startsWith('CV-')
                                ? 'bg-amber-950/80 text-amber-300 border border-amber-800/60'
                                : 'bg-indigo-950/80 text-indigo-300 border border-indigo-800/60'
                            }`}
                          >
                            {l.voucherNumber}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap text-slate-400">{l.reference || '—'}</td>
                        <td className="py-2.5 px-4 text-slate-200 font-sans font-medium">{l.counterpartyAccount}</td>
                        <td className="py-2.5 px-4 text-slate-400 font-sans max-w-xs truncate" title={l.narration}>
                          {l.narration}
                        </td>
                        <td className="py-2.5 px-4 text-right text-emerald-400 font-semibold">
                          {parseFloat(l.debit) > 0 ? formatCurrency(l.debit) : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right text-rose-400 font-semibold">
                          {parseFloat(l.credit) > 0 ? formatCurrency(l.credit) : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-bold text-slate-100 whitespace-nowrap">
                          {formatCurrency(l.runningBalance)}{' '}
                          <span
                            className={`text-[10px] ${
                              l.runningBalanceType === 'DEBIT' ? 'text-indigo-400' : 'text-amber-400'
                            }`}
                          >
                            {l.runningBalanceType}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot className="bg-slate-950/80 border-t border-slate-800 font-mono font-bold text-slate-200">
                  <tr>
                    <td colSpan={5} className="py-3 px-4 font-sans text-right uppercase text-[11px] text-slate-400">
                      Period Total &amp; Net Closing:
                    </td>
                    <td className="py-3 px-4 text-right text-emerald-400 font-bold">
                      {formatCurrency(cashBook.totalDebit)}
                    </td>
                    <td className="py-3 px-4 text-right text-rose-400 font-bold">
                      {formatCurrency(cashBook.totalCredit)}
                    </td>
                    <td className="py-3 px-4 text-right text-indigo-300 font-bold whitespace-nowrap">
                      {formatCurrency(cashBook.closingBalance)}{' '}
                      <span className="text-[10px] text-indigo-400">{cashBook.closingBalanceType}</span>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 3. BANK BOOK TAB */}
      {/* ======================================================== */}
      {activeTab === 'bank-book' && bankBook && (
        <div className="space-y-4">
          {/* Bank Book Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-xs text-slate-400 font-medium">Opening Balance</div>
              <div className="text-lg font-bold text-slate-100 mt-1 flex items-baseline gap-2">
                <span>{formatCurrency(bankBook.openingBalance)}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                  {bankBook.openingBalanceType}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 truncate">
                {bankBook.ledger?.name || 'Selected Bank Account'}
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-xs text-slate-400 font-medium">Total Deposits (Inflow)</div>
              <div className="text-lg font-bold text-emerald-400 mt-1 flex items-center gap-1.5">
                <ArrowDownLeft className="w-4 h-4 text-emerald-400" />
                <span>{formatCurrency(bankBook.totalDebit)}</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Total deposits credited to bank</div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-xs text-slate-400 font-medium">Total Withdrawals (Outflow)</div>
              <div className="text-lg font-bold text-rose-400 mt-1 flex items-center gap-1.5">
                <ArrowDownRight className="w-4 h-4 text-rose-400" />
                <span>{formatCurrency(bankBook.totalCredit)}</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Total withdrawals &amp; payments</div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-xs text-slate-400 font-medium">Closing Balance</div>
              <div className="text-lg font-bold text-indigo-400 mt-1 flex items-baseline gap-2">
                <span>{formatCurrency(bankBook.closingBalance)}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-800 font-mono">
                  {bankBook.closingBalanceType}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">Verified bank balance position</div>
            </div>
          </div>

          {/* Bank Book Transactions Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                  <Landmark className="w-4 h-4 text-cyan-400" />
                  <span>{bankBook.ledger?.name || 'Bank Book'} Register</span>
                </h3>
                <p className="text-xs text-slate-400">
                  Showing posted bank deposits, transfers, withdrawals, and contra vouchers with running balance
                </p>
              </div>
              <div className="text-xs text-slate-400 font-mono">
                {bankBook.lines.length} transaction{bankBook.lines.length === 1 ? '' : 's'} recorded
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-950/70 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Voucher No</th>
                    <th className="py-3 px-4">Bank Ref / Memo</th>
                    <th className="py-3 px-4">Counterparty Account</th>
                    <th className="py-3 px-4">Narration</th>
                    <th className="py-3 px-4 text-right">Deposits (Dr)</th>
                    <th className="py-3 px-4 text-right">Withdrawals (Cr)</th>
                    <th className="py-3 px-4 text-right">Running Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {/* Opening Balance Row */}
                  <tr className="bg-slate-950/40 text-slate-400">
                    <td className="py-2.5 px-4 font-sans text-slate-400">{bankBook.fromDate}</td>
                    <td className="py-2.5 px-4 text-slate-400">—</td>
                    <td className="py-2.5 px-4 text-slate-400">OPENING</td>
                    <td className="py-2.5 px-4 font-sans font-medium text-slate-300">
                      Balance Brought Forward
                    </td>
                    <td className="py-2.5 px-4 font-sans text-slate-400">
                      Opening balance including transactions prior to {bankBook.fromDate}
                    </td>
                    <td className="py-2.5 px-4 text-right text-slate-400">—</td>
                    <td className="py-2.5 px-4 text-right text-slate-400">—</td>
                    <td className="py-2.5 px-4 text-right font-bold text-slate-200">
                      {formatCurrency(bankBook.openingBalance)}{' '}
                      <span className="text-[10px] text-slate-400">{bankBook.openingBalanceType}</span>
                    </td>
                  </tr>

                  {bankBook.lines.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-400 font-sans">
                        No posted bank transactions recorded for this account within the selected date range.
                      </td>
                    </tr>
                  ) : (
                    bankBook.lines.map((l) => (
                      <tr key={l.id || l.journalId} className="hover:bg-slate-800/40 transition">
                        <td className="py-2.5 px-4 whitespace-nowrap text-slate-300 font-sans">{l.entryDate}</td>
                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                              l.voucherNumber.startsWith('CV-')
                                ? 'bg-amber-950/80 text-amber-300 border border-amber-800/60'
                                : 'bg-indigo-950/80 text-indigo-300 border border-indigo-800/60'
                            }`}
                          >
                            {l.voucherNumber}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 whitespace-nowrap text-slate-400">{l.reference || '—'}</td>
                        <td className="py-2.5 px-4 text-slate-200 font-sans font-medium">{l.counterpartyAccount}</td>
                        <td className="py-2.5 px-4 text-slate-400 font-sans max-w-xs truncate" title={l.narration}>
                          {l.narration}
                        </td>
                        <td className="py-2.5 px-4 text-right text-emerald-400 font-semibold">
                          {parseFloat(l.debit) > 0 ? formatCurrency(l.debit) : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right text-rose-400 font-semibold">
                          {parseFloat(l.credit) > 0 ? formatCurrency(l.credit) : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-bold text-slate-100 whitespace-nowrap">
                          {formatCurrency(l.runningBalance)}{' '}
                          <span
                            className={`text-[10px] ${
                              l.runningBalanceType === 'DEBIT' ? 'text-indigo-400' : 'text-amber-400'
                            }`}
                          >
                            {l.runningBalanceType}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot className="bg-slate-950/80 border-t border-slate-800 font-mono font-bold text-slate-200">
                  <tr>
                    <td colSpan={5} className="py-3 px-4 font-sans text-right uppercase text-[11px] text-slate-400">
                      Period Total &amp; Net Closing:
                    </td>
                    <td className="py-3 px-4 text-right text-emerald-400 font-bold">
                      {formatCurrency(bankBook.totalDebit)}
                    </td>
                    <td className="py-3 px-4 text-right text-rose-400 font-bold">
                      {formatCurrency(bankBook.totalCredit)}
                    </td>
                    <td className="py-3 px-4 text-right text-indigo-300 font-bold whitespace-nowrap">
                      {formatCurrency(bankBook.closingBalance)}{' '}
                      <span className="text-[10px] text-indigo-400">{bankBook.closingBalanceType}</span>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 4. PROFIT & LOSS TAB */}
      {/* ======================================================== */}
      {activeTab === 'pnl' && pnl && (
        <div className="space-y-6">
          {/* Summary KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Total Operating Revenue</div>
              <div className="text-xl font-bold font-mono text-indigo-400 mt-1">{formatCurrency(pnl.totalIncome)}</div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Total Operating Expenses</div>
              <div className="text-xl font-bold font-mono text-rose-400 mt-1">{formatCurrency(pnl.totalExpense)}</div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Net Operating {pnl.isProfitable ? 'Profit' : 'Loss'}</div>
              <div className={`text-xl font-bold font-mono mt-1 ${pnl.isProfitable ? 'text-emerald-400' : 'text-amber-400'}`}>
                {formatCurrency(pnl.netProfit)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Income Groups */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h3 className="text-sm font-bold text-indigo-400 flex items-center gap-2">
                  <ArrowUpRight className="w-4 h-4" />
                  Revenue &amp; Income Accounts
                </h3>
                <span className="font-mono text-xs font-bold text-slate-200">{formatCurrency(pnl.totalIncome)}</span>
              </div>

              <div className="space-y-4">
                {pnl.incomeGroups.length === 0 ? (
                  <div className="text-xs text-slate-400 text-center py-6">No income postings for this period.</div>
                ) : (
                  pnl.incomeGroups.map((group, gIdx) => (
                    <div key={gIdx} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs font-semibold text-slate-300 bg-slate-950/60 px-3 py-1.5 rounded-lg border border-slate-800">
                        <span>{group.groupName}</span>
                        <span className="font-mono text-indigo-400">{formatCurrency(group.subtotal)}</span>
                      </div>
                      <div className="pl-3 space-y-1">
                        {group.ledgers.map((l, lIdx) => (
                          <div key={lIdx} className="flex items-center justify-between py-1 text-xs text-slate-400">
                            <span>{l.code ? `[${l.code}] ` : ''}{l.name}</span>
                            <span className="font-mono text-slate-200">{formatCurrency(l.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Expense Groups */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h3 className="text-sm font-bold text-rose-400 flex items-center gap-2">
                  <ArrowDownRight className="w-4 h-4" />
                  Operating Expenses
                </h3>
                <span className="font-mono text-xs font-bold text-slate-200">{formatCurrency(pnl.totalExpense)}</span>
              </div>

              <div className="space-y-4">
                {pnl.expenseGroups.length === 0 ? (
                  <div className="text-xs text-slate-400 text-center py-6">No expense postings for this period.</div>
                ) : (
                  pnl.expenseGroups.map((group, gIdx) => (
                    <div key={gIdx} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs font-semibold text-slate-300 bg-slate-950/60 px-3 py-1.5 rounded-lg border border-slate-800">
                        <span>{group.groupName}</span>
                        <span className="font-mono text-rose-400">{formatCurrency(group.subtotal)}</span>
                      </div>
                      <div className="pl-3 space-y-1">
                        {group.ledgers.map((l, lIdx) => (
                          <div key={lIdx} className="flex items-center justify-between py-1 text-xs text-slate-400">
                            <span>{l.code ? `[${l.code}] ` : ''}{l.name}</span>
                            <span className="font-mono text-slate-200">{formatCurrency(l.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 3. BALANCE SHEET TAB */}
      {/* ======================================================== */}
      {activeTab === 'balance-sheet' && balanceSheet && (
        <div className="space-y-4">
          {/* Equation Check */}
          <div
            className={`p-4 rounded-2xl border flex items-center justify-between text-xs ${
              balanceSheet.isBalanced
                ? 'bg-emerald-950/50 border-emerald-800/60 text-emerald-200'
                : 'bg-amber-950/50 border-amber-800/60 text-amber-200'
            }`}
          >
            <div className="flex items-center gap-3">
              {balanceSheet.isBalanced ? (
                <ShieldCheck className="w-6 h-6 text-emerald-400" />
              ) : (
                <AlertCircle className="w-6 h-6 text-amber-400" />
              )}
              <div>
                <div className="font-bold text-sm">
                  {balanceSheet.isBalanced
                    ? 'Fundamental Accounting Equation Holds (Assets = Liabilities + Equity)'
                    : 'Balance Sheet Out of Balance'}
                </div>
                <div className="text-[11px] opacity-80 mt-0.5">
                  Assets: {formatCurrency(balanceSheet.totalAssets)} = Liabilities ({formatCurrency(balanceSheet.totalLiabilities)}) + Equity ({formatCurrency(balanceSheet.totalEquity)})
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Assets */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h3 className="text-sm font-bold text-emerald-400">Total Assets</h3>
                <span className="font-mono text-xs font-bold text-slate-100">{formatCurrency(balanceSheet.totalAssets)}</span>
              </div>
              <div className="space-y-4">
                {balanceSheet.assetGroups.map((group, gIdx) => (
                  <div key={gIdx} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-300 bg-slate-950/60 px-3 py-1.5 rounded-lg border border-slate-800">
                      <span>{group.groupName}</span>
                      <span className="font-mono text-emerald-400">{formatCurrency(group.subtotal)}</span>
                    </div>
                    <div className="pl-3 space-y-1">
                      {group.ledgers.map((l, lIdx) => (
                        <div key={lIdx} className="flex items-center justify-between py-1 text-xs text-slate-400">
                          <span>{l.code ? `[${l.code}] ` : ''}{l.name}</span>
                          <span className="font-mono text-slate-200">{formatCurrency(l.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Liabilities & Equity */}
            <div className="space-y-6">
              {/* Liabilities */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <h3 className="text-sm font-bold text-amber-400">Liabilities</h3>
                  <span className="font-mono text-xs font-bold text-slate-100">{formatCurrency(balanceSheet.totalLiabilities)}</span>
                </div>
                <div className="space-y-4">
                  {balanceSheet.liabilityGroups.map((group, gIdx) => (
                    <div key={gIdx} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs font-semibold text-slate-300 bg-slate-950/60 px-3 py-1.5 rounded-lg border border-slate-800">
                        <span>{group.groupName}</span>
                        <span className="font-mono text-amber-400">{formatCurrency(group.subtotal)}</span>
                      </div>
                      <div className="pl-3 space-y-1">
                        {group.ledgers.map((l, lIdx) => (
                          <div key={lIdx} className="flex items-center justify-between py-1 text-xs text-slate-400">
                            <span>{l.code ? `[${l.code}] ` : ''}{l.name}</span>
                            <span className="font-mono text-slate-200">{formatCurrency(l.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Equity */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <h3 className="text-sm font-bold text-sky-400">Equity &amp; Retained Earnings</h3>
                  <span className="font-mono text-xs font-bold text-slate-100">{formatCurrency(balanceSheet.totalEquity)}</span>
                </div>
                <div className="space-y-4">
                  {balanceSheet.equityGroups.map((group, gIdx) => (
                    <div key={gIdx} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs font-semibold text-slate-300 bg-slate-950/60 px-3 py-1.5 rounded-lg border border-slate-800">
                        <span>{group.groupName}</span>
                        <span className="font-mono text-sky-400">{formatCurrency(group.subtotal)}</span>
                      </div>
                      <div className="pl-3 space-y-1">
                        {group.ledgers.map((l, lIdx) => (
                          <div key={lIdx} className="flex items-center justify-between py-1 text-xs text-slate-400">
                            <span>{l.code ? `[${l.code}] ` : ''}{l.name}</span>
                            <span className="font-mono text-slate-200">{formatCurrency(l.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}

                  {/* Current period retained earnings */}
                  <div className="flex items-center justify-between py-2 border-t border-slate-700/60 text-xs font-semibold">
                    <span className="text-slate-300">Net Profit / Current Period Earnings:</span>
                    <span className="font-mono text-emerald-400">{formatCurrency(balanceSheet.currentPeriodProfit)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 4. GENERAL LEDGER STATEMENT TAB */}
      {/* ======================================================== */}
      {activeTab === 'ledger-statement' && ledgerStatement && (
        <div className="space-y-4">
          {/* Ledger Statement Header Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-slate-100">
                  {ledgerStatement.ledger.code ? `[${ledgerStatement.ledger.code}] ` : ''}
                  {ledgerStatement.ledger.name}
                </h3>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                  {ledgerStatement.ledger.rootType}
                </span>
              </div>
              <div className="text-xs text-slate-400 mt-1">
                Parent Group: {ledgerStatement.ledger.groupName} • Currency: {ledgerStatement.ledger.currency}
              </div>
            </div>

            <div className="flex items-center gap-6 font-mono text-xs">
              <div>
                <div className="text-[10px] text-slate-400 uppercase">Opening Balance</div>
                <div className="text-sm font-bold text-slate-200">
                  {formatCurrency(ledgerStatement.openingBalance)} ({ledgerStatement.openingBalanceType})
                </div>
              </div>
              <div>
                <div className="text-[10px] text-slate-400 uppercase">Closing Balance</div>
                <div className="text-sm font-bold text-indigo-400">
                  {formatCurrency(ledgerStatement.closingBalance)} ({ledgerStatement.closingBalanceType})
                </div>
              </div>
            </div>
          </div>

          {/* Statement Lines Table */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-950 text-slate-400 text-[11px] uppercase tracking-wider border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Voucher No</th>
                    <th className="py-3 px-4">Particulars / Narration</th>
                    <th className="py-3 px-4 text-right">Debit ($)</th>
                    <th className="py-3 px-4 text-right">Credit ($)</th>
                    <th className="py-3 px-4 text-right">Running Balance ($)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-sans">
                  {/* Opening line */}
                  <tr className="bg-slate-950/40 italic text-slate-400 font-mono">
                    <td className="py-2.5 px-4">{ledgerStatement.fromDate || 'Beginning'}</td>
                    <td className="py-2.5 px-4">—</td>
                    <td className="py-2.5 px-4">Opening Balance Brought Forward</td>
                    <td className="py-2.5 px-4 text-right">
                      {ledgerStatement.openingBalanceType === 'DEBIT' ? formatCurrency(ledgerStatement.openingBalance) : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      {ledgerStatement.openingBalanceType === 'CREDIT' ? formatCurrency(ledgerStatement.openingBalance) : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right font-bold text-slate-200">
                      {formatCurrency(ledgerStatement.openingBalance)}
                    </td>
                  </tr>

                  {ledgerStatement.lines.map((line) => (
                    <tr key={line.journalId} className="hover:bg-slate-800/40 transition">
                      <td className="py-2.5 px-4 text-slate-300">{line.entryDate}</td>
                      <td className="py-2.5 px-4 font-mono font-medium text-slate-100">{line.voucherNumber}</td>
                      <td className="py-2.5 px-4 text-slate-300">{line.narration}</td>
                      <td className="py-2.5 px-4 text-right font-mono text-emerald-400">
                        {parseFloat(line.debit) > 0 ? formatCurrency(line.debit) : '—'}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-emerald-400">
                        {parseFloat(line.credit) > 0 ? formatCurrency(line.credit) : '—'}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono font-medium text-slate-100">
                        {formatCurrency(line.runningBalance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-slate-950 font-mono text-xs border-t-2 border-slate-800">
                  <tr>
                    <td colSpan={3} className="py-3.5 px-4 text-right font-bold text-slate-200">
                      Total Activity / Closing Balance:
                    </td>
                    <td className="py-3.5 px-4 text-right font-bold text-emerald-400">
                      {formatCurrency(ledgerStatement.totalDebit)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-bold text-emerald-400">
                      {formatCurrency(ledgerStatement.totalCredit)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-bold text-indigo-400 text-sm">
                      {formatCurrency(ledgerStatement.closingBalance)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 5. OPENING BALANCE INTEGRITY TAB */}
      {/* ======================================================== */}
      {activeTab === 'opening-balances' && openingBalValidation && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-indigo-400" />
                Chart of Accounts Opening Balance Verification
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Audits all configured opening balances to ensure double-entry equilibrium across initial ledger balances
              </p>
            </div>

            <span
              className={`px-3 py-1 rounded-full text-xs font-semibold ${
                openingBalValidation.isBalanced
                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                  : 'bg-amber-950 text-amber-300 border border-amber-800'
              }`}
            >
              {openingBalValidation.isBalanced ? 'Equilibrium Verified' : 'Discrepancy Detected'}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 font-mono">
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <div className="text-[11px] text-slate-400 uppercase font-sans">Total Opening Debits</div>
              <div className="text-lg font-bold text-emerald-400 mt-1">
                {formatCurrency(openingBalValidation.totalOpeningDebit)}
              </div>
            </div>

            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <div className="text-[11px] text-slate-400 uppercase font-sans">Total Opening Credits</div>
              <div className="text-lg font-bold text-emerald-400 mt-1">
                {formatCurrency(openingBalValidation.totalOpeningCredit)}
              </div>
            </div>

            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <div className="text-[11px] text-slate-400 uppercase font-sans">Discrepancy</div>
              <div className={`text-lg font-bold mt-1 ${openingBalValidation.isBalanced ? 'text-slate-200' : 'text-red-400'}`}>
                {formatCurrency(openingBalValidation.discrepancy)}
              </div>
            </div>
          </div>

          <div className="text-xs text-slate-300 bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
            {openingBalValidation.isBalanced ? (
              <div className="flex items-center gap-2 text-emerald-300">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>
                  All initial ledger balances are in perfect double-entry equilibrium. No adjustments required.
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-amber-300">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>
                  Opening balances are out of balance by {formatCurrency(openingBalValidation.discrepancy)}.
                  Check ledger opening debit and credit assignments under Chart of Accounts.
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
