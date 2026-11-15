import React, { useState, useEffect, useCallback } from 'react';
import {
  FolderTree,
  Plus,
  Search,
  BookOpen,
  Filter,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  FolderPlus,
  X,
  FileText,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import {
  AccountGroupItem,
  AccountLedgerItem,
  AccountRootType,
  BalanceType,
  AuthUser,
} from '../../shared/types.ts';
import {
  PREVIEW_ACCOUNT_GROUPS,
  PREVIEW_ACCOUNT_LEDGERS,
  previewStore,
} from '../services/previewStore.ts';
import {
  formatAccountNatureDisplay,
  getDefaultAccountNature,
} from '../../shared/account-nature.ts';
import {
  getAllowedCodeRangeLabel,
  suggestNextLedgerCode,
  validateLedgerCodeForGroup,
} from '../../shared/account-code.ts';

interface ChartOfAccountsPageProps {
  currentUser: AuthUser;
  onViewStatement?: (ledgerId: string) => void;
}

const ROOT_TYPES: Array<{ id: AccountRootType; label: string; color: string; badge: string }> = [
  { id: 'ASSET', label: 'Assets (1000)', color: 'text-emerald-400', badge: 'bg-emerald-950/60 text-emerald-300 border-emerald-800/50' },
  { id: 'LIABILITY', label: 'Liabilities (2000)', color: 'text-amber-400', badge: 'bg-amber-950/60 text-amber-300 border-amber-800/50' },
  { id: 'EQUITY', label: 'Equity (3000)', color: 'text-sky-400', badge: 'bg-sky-950/60 text-sky-300 border-sky-800/50' },
  { id: 'INCOME', label: 'Income (4000)', color: 'text-indigo-400', badge: 'bg-indigo-950/60 text-indigo-300 border-indigo-800/50' },
  { id: 'EXPENSE', label: 'Expenses (5000)', color: 'text-rose-400', badge: 'bg-rose-950/60 text-rose-300 border-rose-800/50' },
];

export const ChartOfAccountsPage: React.FC<ChartOfAccountsPageProps> = ({
  currentUser,
  onViewStatement,
}) => {
  const [groups, setGroups] = useState<AccountGroupItem[]>([]);
  const [ledgers, setLedgers] = useState<AccountLedgerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Filters
  const [selectedRootType, setSelectedRootType] = useState<AccountRootType | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  // Modals
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [isLedgerModalOpen, setIsLedgerModalOpen] = useState(false);

  // Group Form
  const [groupCode, setGroupCode] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupRootType, setGroupRootType] = useState<AccountRootType>('ASSET');
  const [groupParentId, setGroupParentId] = useState<string>('');
  const [isSubmittingGroup, setIsSubmittingGroup] = useState(false);

  // Ledger Form
  const [ledgerGroupId, setLedgerGroupId] = useState('');
  const [ledgerCode, setLedgerCode] = useState('');
  const [isManualCode, setIsManualCode] = useState(false);
  const [suggestedCode, setSuggestedCode] = useState('');
  const [allowedRangeLabel, setAllowedRangeLabel] = useState('');
  const [isLoadingSuggestedCode, setIsLoadingSuggestedCode] = useState(false);
  const [ledgerName, setLedgerName] = useState('');
  const [ledgerDesc, setLedgerDesc] = useState('');
  const [ledgerOpeningBal, setLedgerOpeningBal] = useState('0.0000');
  const [isSubmittingLedger, setIsSubmittingLedger] = useState(false);
  const [modalLedgerError, setModalLedgerError] = useState<string | null>(null);

  const selectedLedgerGroup = groups.find((g) => g.id === ledgerGroupId) || groups[0] || null;
  const derivedLedgerNature: BalanceType | null = selectedLedgerGroup
    ? getDefaultAccountNature(selectedLedgerGroup)
    : null;

  const ledgerCodeValidationError: string | null = (() => {
    if (!isLedgerModalOpen || !selectedLedgerGroup) return null;
    const trimmed = ledgerCode.trim();
    if (!trimmed) {
      return isManualCode ? 'Ledger code is required.' : null;
    }
    const groupCheck = validateLedgerCodeForGroup({
      code: trimmed,
      targetGroup: selectedLedgerGroup,
      allGroups: groups,
    });
    if (!groupCheck.valid) {
      return groupCheck.error || 'Invalid ledger code for selected Account Group.';
    }
    const duplicate = ledgers.find(
      (l) => l.code && l.code.trim().toUpperCase() === groupCheck.normalizedCode.toUpperCase()
    );
    if (duplicate && isManualCode) {
      return `Ledger code "${groupCheck.normalizedCode}" already exists (${duplicate.name}).`;
    }
    return null;
  })();

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    // In Preview Mode, load stateful demo data
    if (currentUser?.isPreview) {
      const gData = previewStore.getAccountGroups();
      const lData = previewStore.getAccountLedgers({
        isActive: showInactive ? undefined : true,
        search: search.trim() || undefined,
      });
      setGroups(gData);
      setLedgers(lData);
      if (gData.length > 0 && !ledgerGroupId) {
        setLedgerGroupId(gData[0].id);
      }
      setIsLoading(false);
      return;
    }

    try {
      const [gData, lData] = await Promise.all([
        api.getAccountGroups(),
        api.getAccountLedgers({
          isActive: showInactive ? undefined : true,
          search: search.trim() || undefined,
        }),
      ]);
      setGroups(gData);
      setLedgers(lData);
      if (gData.length > 0 && !ledgerGroupId) {
        setLedgerGroupId(gData[0].id);
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load chart of accounts.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [currentUser?.isPreview, showInactive, search, ledgerGroupId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const isManualCodeRef = React.useRef(isManualCode);
  useEffect(() => {
    isManualCodeRef.current = isManualCode;
  }, [isManualCode]);

  useEffect(() => {
    if (!isLedgerModalOpen || !selectedLedgerGroup) return;

    let cancelled = false;

    if (currentUser?.isPreview) {
      const suggestion = previewStore.suggestAccountLedgerCode(selectedLedgerGroup.id);
      setSuggestedCode(suggestion.suggestedCode);
      setAllowedRangeLabel(suggestion.allowedRangeLabel);
      if (!isManualCodeRef.current) {
        setLedgerCode(suggestion.suggestedCode);
      }
      return;
    }

    const localSuggestion = suggestNextLedgerCode({
      targetGroup: selectedLedgerGroup,
      allGroups: groups,
      existingLedgerCodes: ledgers.map((l) => l.code),
    });
    const localRange = getAllowedCodeRangeLabel(selectedLedgerGroup, groups);
    setSuggestedCode(localSuggestion);
    setAllowedRangeLabel(localRange);
    if (!isManualCodeRef.current) {
      setLedgerCode(localSuggestion);
    }

    setIsLoadingSuggestedCode(true);
    api
      .suggestAccountLedgerCode(selectedLedgerGroup.id)
      .then((res) => {
        if (cancelled) return;
        setSuggestedCode(res.suggestedCode);
        setAllowedRangeLabel(res.allowedRangeLabel);
        if (!isManualCodeRef.current) {
          setLedgerCode(res.suggestedCode);
        }
      })
      .catch(() => {
        // Keep local fallback suggestion if suggest-code call fails
      })
      .finally(() => {
        if (!cancelled) setIsLoadingSuggestedCode(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLedgerModalOpen, selectedLedgerGroup?.id, currentUser?.isPreview]);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (currentUser?.isPreview) {
      previewStore.createAccountGroup({
        code: groupCode.trim(),
        name: groupName.trim(),
        rootType: groupRootType,
        parentGroupId: groupParentId || null,
      });
      setSuccessMessage(
        `[Preview Demo] Account group "${groupName}" created in-memory. Not saved to database.`
      );
      setIsGroupModalOpen(false);
      setGroupCode('');
      setGroupName('');
      setGroupParentId('');
      fetchData();
      return;
    }
    setIsSubmittingGroup(true);
    setErrorMessage(null);

    try {
      await api.createAccountGroup({
        code: groupCode.trim(),
        name: groupName.trim(),
        rootType: groupRootType,
        parentGroupId: groupParentId || null,
      });

      setSuccessMessage(`Account group "${groupName}" created successfully.`);
      setIsGroupModalOpen(false);
      setGroupCode('');
      setGroupName('');
      setGroupParentId('');
      fetchData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to create account group.');
      }
    } finally {
      setIsSubmittingGroup(false);
    }
  };

  const openCreateLedgerModal = () => {
    setModalLedgerError(null);
    setIsManualCode(false);
    setLedgerName('');
    setLedgerDesc('');
    setLedgerOpeningBal('0.0000');
    if (!ledgerGroupId && groups.length > 0) {
      setLedgerGroupId(groups[0].id);
    }
    setIsLedgerModalOpen(true);
  };

  const handleCreateLedger = async (e: React.FormEvent) => {
    e.preventDefault();
    const effectiveGroupId = ledgerGroupId || selectedLedgerGroup?.id || '';
    if (!effectiveGroupId) {
      setModalLedgerError('Please select an Account Group.');
      return;
    }
    if (ledgerCodeValidationError) {
      setModalLedgerError(ledgerCodeValidationError);
      return;
    }
    setModalLedgerError(null);

    if (currentUser?.isPreview) {
      try {
        const created = previewStore.createAccountLedger({
          groupId: effectiveGroupId,
          code: ledgerCode.trim() || null,
          codeSource: isManualCode ? 'MANUAL' : 'AUTO',
          name: ledgerName.trim(),
          description: ledgerDesc.trim() || null,
          openingBalance: ledgerOpeningBal,
        });
        setSuccessMessage(
          `[Preview Demo] Ledger "${created.name}" (${created.code}) created in-memory. Not saved to database.`
        );
        setIsLedgerModalOpen(false);
        setIsManualCode(false);
        setLedgerCode('');
        setLedgerName('');
        setLedgerDesc('');
        setLedgerOpeningBal('0.0000');
        fetchData();
      } catch (err: unknown) {
        setModalLedgerError(err instanceof Error ? err.message : 'Failed to create ledger.');
      }
      return;
    }
    setIsSubmittingLedger(true);
    setErrorMessage(null);

    try {
      const created = await api.createAccountLedger({
        groupId: effectiveGroupId,
        code: ledgerCode.trim() || null,
        codeSource: isManualCode ? 'MANUAL' : 'AUTO',
        name: ledgerName.trim(),
        description: ledgerDesc.trim() || null,
        openingBalance: ledgerOpeningBal,
      });

      setSuccessMessage(`Ledger "${created.name}" (${created.code}) created successfully.`);
      setIsLedgerModalOpen(false);
      setIsManualCode(false);
      setLedgerCode('');
      setLedgerName('');
      setLedgerDesc('');
      setLedgerOpeningBal('0.0000');
      fetchData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setModalLedgerError(err.message);
      } else {
        setModalLedgerError('Failed to create ledger.');
      }
    } finally {
      setIsSubmittingLedger(false);
    }
  };

  const handleToggleStatus = async (ledger: AccountLedgerItem) => {
    if (currentUser?.isPreview) {
      setErrorMessage('Ledger status modifications are unavailable in Preview Mode.');
      return;
    }
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await api.toggleAccountLedgerStatus(ledger.id, !ledger.isActive);
      setSuccessMessage(`Ledger "${ledger.name}" ${!ledger.isActive ? 'activated' : 'deactivated'}.`);
      fetchData();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to update ledger status.');
      }
    }
  };

  const filteredLedgers = ledgers.filter((l) => {
    if (selectedRootType !== 'ALL' && l.rootType !== selectedRootType) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2">
            <FolderTree className="w-6 h-6 text-indigo-400" />
            Chart of Accounts (COA)
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            Hierarchical account groups, general ledgers, opening balances, and employee account preparation
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsGroupModalOpen(true)}
            title="New Group"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition border bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700 cursor-pointer"
          >
            <FolderPlus className="w-4 h-4 text-indigo-400" />
            <span>New Group</span>
            {currentUser?.isPreview && (
              <span className="text-[9px] font-mono uppercase bg-amber-950/80 text-amber-300 px-1.5 py-0.5 rounded border border-amber-800/80 ml-1">
                Demo
              </span>
            )}
          </button>

          <button
            onClick={openCreateLedgerModal}
            title="New Ledger"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold shadow-md transition bg-indigo-600 hover:bg-indigo-500 text-white cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New Ledger</span>
            {currentUser?.isPreview && (
              <span className="text-[9px] font-mono uppercase bg-amber-950/80 text-amber-300 px-1.5 py-0.5 rounded border border-amber-800/80 ml-1">
                Demo
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Preview Mode Notice */}
      {currentUser?.isPreview && (
        <div className="bg-amber-950/60 border border-amber-800/70 rounded-xl p-4 text-xs text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow">
          <div className="flex items-center gap-2.5">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
            <div>
              <strong className="text-amber-100">Preview Mode — In-Memory Chart of Accounts</strong>
              <p className="text-amber-300/80 mt-0.5">
                Displaying sample general ledgers across Assets (1000), Liabilities (2000), Equity (3000), Income (4000), and Expenses (5000). Adding groups or ledgers operates in-memory and updates report calculations without persisting to PostgreSQL.
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

      {/* Root Type Filter Pills */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setSelectedRootType('ALL')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
            selectedRootType === 'ALL'
              ? 'bg-indigo-600 text-white'
              : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
          }`}
        >
          All Classifications
        </button>
        {ROOT_TYPES.map((rt) => (
          <button
            key={rt.id}
            onClick={() => setSelectedRootType(rt.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1.5 ${
              selectedRootType === rt.id
                ? 'bg-slate-800 text-white border border-indigo-500/60 shadow'
                : 'bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800'
            }`}
          >
            <span className={rt.color}>●</span>
            <span>{rt.label}</span>
          </button>
        ))}
      </div>

      {/* Search & Toggle Bar */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-3.5 flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative flex-1 w-full sm:w-auto">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search ledgers by code or name..."
            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div className="flex items-center gap-4 text-xs text-slate-400">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded bg-slate-950 border-slate-800 text-indigo-600 focus:ring-0"
            />
            <span>Include Inactive Ledgers</span>
          </label>

          <button
            onClick={fetchData}
            className="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition cursor-pointer"
            title="Refresh accounts"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Ledgers Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">
                <th className="px-5 py-3">Code &amp; Name</th>
                <th className="px-4 py-3">Account Group</th>
                <th className="px-4 py-3">Classification</th>
                <th className="px-4 py-3 text-right">Opening Balance</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-slate-300">
              {filteredLedgers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-slate-400">
                    {isLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                        Loading chart of accounts...
                      </span>
                    ) : (
                      'No ledgers found matching criteria. Click "New Ledger" to create an account.'
                    )}
                  </td>
                </tr>
              ) : (
                filteredLedgers.map((l) => {
                  const rootBadge = ROOT_TYPES.find((rt) => rt.id === l.rootType)?.badge || 'bg-slate-800 text-slate-300';
                  return (
                    <tr key={l.id} className="hover:bg-slate-800/40 transition">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <BookOpen className="w-4 h-4 text-indigo-400 shrink-0" />
                          <div>
                            <div className="font-semibold text-slate-100 flex items-center gap-1.5">
                              {l.code && <span className="font-mono text-indigo-300">[{l.code}]</span>}
                              <span>{l.name}</span>
                            </div>
                            {l.description && (
                              <div className="text-[11px] text-slate-400 truncate max-w-sm">
                                {l.description}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-3.5 text-slate-300 font-medium">
                        {l.groupName}
                      </td>

                      <td className="px-4 py-3.5">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-mono border font-medium ${rootBadge}`}>
                          {l.rootType}
                        </span>
                      </td>

                      <td className="px-4 py-3.5 text-right font-mono">
                        <span className="text-slate-200">{l.openingBalance}</span>
                        <span className="text-[10px] ml-1 text-slate-400 font-semibold">
                          {l.openingBalanceType === 'DEBIT' ? 'Dr' : 'Cr'}
                        </span>
                      </td>

                      <td className="px-4 py-3.5 text-center">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                            l.isActive
                              ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800/50'
                              : 'bg-slate-800 text-slate-400 border border-slate-700'
                          }`}
                        >
                          {l.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>

                      <td className="px-4 py-3.5 text-right space-x-2">
                        {onViewStatement && (
                          <button
                            onClick={() => onViewStatement(l.id)}
                            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-indigo-300 rounded text-[11px] font-medium transition cursor-pointer border border-slate-700"
                            title="View statement drilldown"
                          >
                            <FileText className="w-3.5 h-3.5 inline mr-1" />
                            Statement
                          </button>
                        )}

                        <button
                          onClick={() => handleToggleStatus(l)}
                          className={`px-2.5 py-1 rounded text-[11px] font-medium transition cursor-pointer border ${
                            l.isActive
                              ? 'bg-red-950/40 hover:bg-red-900/60 text-red-300 border-red-800/40'
                              : 'bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 border-emerald-800/40'
                          }`}
                          title={l.isActive ? 'Deactivate ledger' : 'Reactivate ledger'}
                        >
                          {l.isActive ? 'Deactivate' : 'Restore'}
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal 1: Add Account Group */}
      {isGroupModalOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <FolderPlus className="w-5 h-5 text-indigo-400" />
                Create Account Group
              </h3>
              <button
                onClick={() => setIsGroupModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateGroup} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Root Classification <span className="text-red-400">*</span>
                </label>
                <select
                  value={groupRootType}
                  onChange={(e) => setGroupRootType(e.target.value as AccountRootType)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500 font-mono"
                >
                  <option value="ASSET">ASSET</option>
                  <option value="LIABILITY">LIABILITY</option>
                  <option value="EQUITY">EQUITY</option>
                  <option value="INCOME">INCOME</option>
                  <option value="EXPENSE">EXPENSE</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Parent Group (Optional Sub-group)
                </label>
                <select
                  value={groupParentId}
                  onChange={(e) => setGroupParentId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                >
                  <option value="">None (Top-level group under {groupRootType})</option>
                  {groups
                    .filter((g) => g.rootType === groupRootType)
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.code} - {g.name}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Group Code <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={groupCode}
                  onChange={(e) => setGroupCode(e.target.value)}
                  placeholder="e.g. 1100"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Group Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="e.g. Current Assets, Bank Accounts"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {currentUser?.isPreview && (
                <div className="p-3 bg-amber-950/70 border border-amber-800/70 rounded-lg text-xs text-amber-300">
                  Saving is unavailable in Preview Mode: PostgreSQL is offline in sandbox.
                </div>
              )}

              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setIsGroupModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={currentUser?.isPreview || isSubmittingGroup}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow transition cursor-pointer disabled:opacity-50"
                >
                  {isSubmittingGroup ? 'Saving...' : 'Create Group'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 2: Add Account Ledger */}
      {isLedgerModalOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-indigo-400" />
                Create General Ledger
              </h3>
              <button
                onClick={() => setIsLedgerModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateLedger} className="space-y-3.5">
              {modalLedgerError && (
                <div className="bg-red-950/70 border border-red-800/70 rounded-lg p-3 text-xs text-red-200 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <span>{modalLedgerError}</span>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Account Group <span className="text-red-400">*</span>
                </label>
                <select
                  required
                  value={ledgerGroupId}
                  onChange={(e) => {
                    setLedgerGroupId(e.target.value);
                    setModalLedgerError(null);
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                >
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      [{g.rootType}] {g.code} - {g.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-slate-300">
                      Ledger Code <span className="text-red-400">*</span>
                    </label>
                    {isManualCode && suggestedCode ? (
                      <button
                        type="button"
                        onClick={() => {
                          setIsManualCode(false);
                          setLedgerCode(suggestedCode);
                          setModalLedgerError(null);
                        }}
                        className="text-[10px] text-indigo-400 hover:text-indigo-300 underline cursor-pointer"
                      >
                        Use {suggestedCode}
                      </button>
                    ) : (
                      <span className="text-[10px] font-mono text-indigo-300">
                        {isLoadingSuggestedCode ? 'Checking...' : 'Auto'}
                      </span>
                    )}
                  </div>
                  <input
                    type="text"
                    required
                    value={ledgerCode}
                    onChange={(e) => {
                      setIsManualCode(true);
                      setLedgerCode(e.target.value);
                      setModalLedgerError(null);
                    }}
                    placeholder={suggestedCode || 'e.g. 1001'}
                    className={`w-full bg-slate-950 border rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none font-mono ${
                      ledgerCodeValidationError
                        ? 'border-red-500/80 focus:border-red-400'
                        : 'border-slate-800 focus:border-indigo-500'
                    }`}
                  />
                  {ledgerCodeValidationError ? (
                    <p className="mt-1 text-[11px] text-red-400 leading-tight">
                      {ledgerCodeValidationError}
                    </p>
                  ) : (
                    allowedRangeLabel && (
                      <p className="mt-1 text-[10px] text-slate-400 font-mono">
                        Group range: {allowedRangeLabel}
                      </p>
                    )
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Ledger Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={ledgerName}
                    onChange={(e) => {
                      setLedgerName(e.target.value);
                      setModalLedgerError(null);
                    }}
                    placeholder="e.g. Main Operating Bank"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Description
                </label>
                <input
                  type="text"
                  value={ledgerDesc}
                  onChange={(e) => setLedgerDesc(e.target.value)}
                  placeholder="Primary checking account for operating expenses"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Opening Balance
                  </label>
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    value={ledgerOpeningBal}
                    onChange={(e) => setLedgerOpeningBal(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>

                <div>
                  <span className="block text-xs font-medium text-slate-300 mb-1">
                    Account Nature
                  </span>
                  <div
                    data-testid="default-account-nature"
                    aria-live="polite"
                    className={`w-full rounded-lg px-3 py-2 text-xs font-mono border flex items-center justify-between ${
                      derivedLedgerNature === 'CREDIT'
                        ? 'bg-amber-950/30 border-amber-800/50 text-amber-200'
                        : 'bg-emerald-950/30 border-emerald-800/50 text-emerald-200'
                    }`}
                  >
                    <span>
                      Default Nature:{' '}
                      <strong>
                        {derivedLedgerNature ? formatAccountNatureDisplay(derivedLedgerNature) : '—'}
                      </strong>
                    </span>
                  </div>
                </div>
              </div>

              {currentUser?.isPreview && (
                <div className="p-3 bg-amber-950/70 border border-amber-800/70 rounded-lg text-xs text-amber-300">
                  Saving is unavailable in Preview Mode: PostgreSQL is offline in sandbox.
                </div>
              )}

              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setIsLedgerModalOpen(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    currentUser?.isPreview ||
                    isSubmittingLedger ||
                    Boolean(ledgerCodeValidationError)
                  }
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow transition cursor-pointer disabled:opacity-50"
                >
                  {isSubmittingLedger ? 'Saving...' : 'Create Ledger'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
