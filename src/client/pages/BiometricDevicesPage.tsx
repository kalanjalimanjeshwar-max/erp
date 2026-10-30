import React, { useState, useEffect, useCallback } from 'react';
import {
  Fingerprint,
  RefreshCw,
  Plus,
  Server,
  Filter,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  ShieldAlert,
  Copy,
  Check,
  Search,
  Activity,
  Layers,
  ChevronLeft,
  ChevronRight,
  Info,
  Calendar,
  RotateCw,
  Ban,
  Key,
} from 'lucide-react';
import { api, ApiError } from '../services/api.ts';
import { LoadingSpinner } from '../components/common/LoadingSpinner.tsx';
import { EmptyState } from '../components/common/EmptyState.tsx';
import {
  AuthUser,
  BiometricTerminalItem,
  BiometricTerminalStatus,
  RawPunchLogItem,
  PunchSyncStatus,
  PunchSyncSummaryResponse,
  PunchReconciliationResponse,
  CreateBiometricTerminalRequest,
} from '../../shared/types.ts';

interface BiometricDevicesPageProps {
  currentUser: AuthUser;
}

export const BiometricDevicesPage: React.FC<BiometricDevicesPageProps> = ({ currentUser }) => {
  const [activeTab, setActiveTab] = useState<'terminals' | 'punches' | 'sync'>('terminals');

  // Terminals State
  const [terminals, setTerminals] = useState<BiometricTerminalItem[]>([]);
  const [isLoadingTerminals, setIsLoadingTerminals] = useState<boolean>(true);
  const [terminalsError, setTerminalsError] = useState<string | null>(null);

  // Sync Summary State
  const [syncSummary, setSyncSummary] = useState<PunchSyncSummaryResponse | null>(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState<boolean>(false);

  // Raw Punch Logs State
  const [punches, setPunches] = useState<RawPunchLogItem[]>([]);
  const [punchTotal, setPunchTotal] = useState<number>(0);
  const [punchPage, setPunchPage] = useState<number>(1);
  const [punchLimit] = useState<number>(20);
  const [isLoadingPunches, setIsLoadingPunches] = useState<boolean>(false);
  const [punchesError, setPunchesError] = useState<string | null>(null);

  // Punch Log Filters
  const [filterSyncStatus, setFilterSyncStatus] = useState<string>('');
  const [filterTerminalId, setFilterTerminalId] = useState<string>('');
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');

  // Device Registration Modal State
  const [isRegisterModalOpen, setIsRegisterModalOpen] = useState<boolean>(false);
  const [isSubmittingDevice, setIsSubmittingDevice] = useState<boolean>(false);
  const [registerFormError, setRegisterFormError] = useState<string | null>(null);

  // Registration Form Fields
  const [formDeviceName, setFormDeviceName] = useState<string>('');
  const [formSerialNumber, setFormSerialNumber] = useState<string>('');
  const [formTerminalModel, setFormTerminalModel] = useState<string>('ZKTeco-F22');
  const [formIpAddress, setFormIpAddress] = useState<string>('');
  const [formPort, setFormPort] = useState<number>(4370);
  const [formLocation, setFormLocation] = useState<string>('');
  const [formNotes, setFormNotes] = useState<string>('');

  // One-time Plaintext API Key Display State (Never persisted)
  const [oneTimeApiKey, setOneTimeApiKey] = useState<string | null>(null);
  const [registeredTerminalName, setRegisteredTerminalName] = useState<string>('');
  const [isCopiedKey, setIsCopiedKey] = useState<boolean>(false);

  // Manual Sync Action State
  const [isSyncModalOpen, setIsSyncModalOpen] = useState<boolean>(false);
  const [isTriggeringSync, setIsTriggeringSync] = useState<boolean>(false);
  const [syncBatchSize, setSyncBatchSize] = useState<number>(100);
  const [syncSelectedTerminalId, setSyncSelectedTerminalId] = useState<string>('');
  const [syncRetryErrors, setSyncRetryErrors] = useState<boolean>(false);
  const [syncOutcome, setSyncOutcome] = useState<PunchReconciliationResponse | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Permission feedback
  const [permissionDeniedMessage, setPermissionDeniedMessage] = useState<string | null>(null);

  // Terminal Action States (Deactivation & Key Rotation)
  const [deactivatingTerminal, setDeactivatingTerminal] = useState<BiometricTerminalItem | null>(null);
  const [isDeactivating, setIsDeactivating] = useState<boolean>(false);
  const [rotatingTerminal, setRotatingTerminal] = useState<BiometricTerminalItem | null>(null);
  const [isRotating, setIsRotating] = useState<boolean>(false);
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);

  // Load Terminals
  const loadTerminals = useCallback(async () => {
    setIsLoadingTerminals(true);
    setTerminalsError(null);
    try {
      const data = await api.getBiometricDevices({ includeInactive: true });
      setTerminals(data);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      if (apiErr.statusCode === 403) {
        setPermissionDeniedMessage('Permission denied: Elevated role required to view biometric terminals.');
      } else {
        setTerminalsError(apiErr.message || 'Failed to load biometric terminals.');
      }
    } finally {
      setIsLoadingTerminals(false);
    }
  }, []);

  // Load Sync Summary Telemetry
  const loadSyncSummary = useCallback(async () => {
    setIsLoadingSummary(true);
    try {
      const summary = await api.getBiometricSyncSummary();
      setSyncSummary(summary);
    } catch {
      // Non-fatal telemetry probe
    } finally {
      setIsLoadingSummary(false);
    }
  }, []);

  // Load Raw Punch Logs
  const loadPunches = useCallback(async () => {
    setIsLoadingPunches(true);
    setPunchesError(null);
    try {
      const res = await api.getBiometricPunches({
        syncStatus: (filterSyncStatus as PunchSyncStatus) || undefined,
        terminalId: filterTerminalId || undefined,
        startDate: filterStartDate || undefined,
        endDate: filterEndDate || undefined,
        page: punchPage,
        limit: punchLimit,
      });
      setPunches(res.items);
      setPunchTotal(res.total);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      if (apiErr.statusCode === 403) {
        setPermissionDeniedMessage('Permission denied: Elevated role required to inspect biometric punches.');
      } else {
        setPunchesError(apiErr.message || 'Failed to load biometric punch logs.');
      }
    } finally {
      setIsLoadingPunches(false);
    }
  }, [filterSyncStatus, filterTerminalId, filterStartDate, filterEndDate, punchPage, punchLimit]);

  useEffect(() => {
    loadTerminals();
    loadSyncSummary();
  }, [loadTerminals, loadSyncSummary]);

  useEffect(() => {
    if (activeTab === 'punches') {
      loadPunches();
    }
  }, [activeTab, loadPunches]);

  // Handle Device Registration
  const handleRegisterDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegisterFormError(null);

    const name = formDeviceName.trim();
    const serial = formSerialNumber.trim();
    if (!name || !serial) {
      setRegisterFormError('Device name and serial number are required.');
      return;
    }

    setIsSubmittingDevice(true);
    try {
      const payload: CreateBiometricTerminalRequest = {
        name,
        deviceSerialNumber: serial,
        terminalModel: formTerminalModel.trim() || 'ZKTeco-F22',
        ipAddress: formIpAddress.trim() || null,
        port: formPort || 4370,
        location: formLocation.trim() || null,
        notes: formNotes.trim() || null,
      };

      const res = await api.createBiometricTerminal(payload);

      // Store API key in volatile component state for one-time display (never persisted)
      setRegisteredTerminalName(res.terminal.name);
      setOneTimeApiKey(res.apiKey);
      setIsRegisterModalOpen(false);

      // Reset form fields
      setFormDeviceName('');
      setFormSerialNumber('');
      setFormIpAddress('');
      setFormPort(4370);
      setFormLocation('');
      setFormNotes('');

      // Refresh terminal list
      loadTerminals();
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setRegisterFormError(apiErr.message || 'Failed to register biometric terminal.');
    } finally {
      setIsSubmittingDevice(false);
    }
  };

  // Handle Manual Punch Sync
  const handleTriggerSync = async () => {
    setIsTriggeringSync(true);
    setSyncError(null);
    setSyncOutcome(null);

    try {
      const result = await api.triggerBiometricSync({
        batchSize: Math.max(1, Math.min(500, syncBatchSize)),
        terminalId: syncSelectedTerminalId || undefined,
        retryErrors: syncRetryErrors,
      });

      setSyncOutcome(result);

      // Refresh telemetry and punch log records
      loadSyncSummary();
      loadTerminals();
      if (activeTab === 'punches') {
        loadPunches();
      }
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setSyncError(apiErr.message || 'Punch reconciliation sync failed.');
    } finally {
      setIsTriggeringSync(false);
    }
  };

  // Copy API Key Helper
  const handleCopyKey = () => {
    if (!oneTimeApiKey) return;
    navigator.clipboard.writeText(oneTimeApiKey);
    setIsCopiedKey(true);
    setTimeout(() => setIsCopiedKey(false), 2500);
  };

  // Close One-time Key Modal
  const handleCloseKeyModal = () => {
    setOneTimeApiKey(null);
    setRegisteredTerminalName('');
    setIsCopiedKey(false);
  };

  // Handle Terminal Deactivation
  const handleDeactivate = async () => {
    if (!deactivatingTerminal) return;
    setIsDeactivating(true);
    setActionErrorMessage(null);
    try {
      const res = await api.deactivateBiometricDevice(deactivatingTerminal.id);
      setTerminals((prev) =>
        prev.map((t) => (t.id === deactivatingTerminal.id ? res.terminal : t))
      );
      setActionSuccessMessage(
        `Terminal "${deactivatingTerminal.name}" has been deactivated and its API credentials revoked.`
      );
      setDeactivatingTerminal(null);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setActionErrorMessage(apiErr.message || 'Failed to deactivate biometric terminal.');
    } finally {
      setIsDeactivating(false);
    }
  };

  // Handle Terminal Key Rotation
  const handleRotateKey = async () => {
    if (!rotatingTerminal) return;
    setIsRotating(true);
    setActionErrorMessage(null);
    try {
      const res = await api.rotateBiometricDeviceKey(rotatingTerminal.id);
      setTerminals((prev) =>
        prev.map((t) => (t.id === rotatingTerminal.id ? res.terminal : t))
      );
      // Reveal new plaintext key in the one-time display modal (never persisted)
      setOneTimeApiKey(res.apiKey);
      setRegisteredTerminalName(res.terminal.name);
      setActionSuccessMessage(
        `API key for "${rotatingTerminal.name}" has been rotated successfully.`
      );
      setRotatingTerminal(null);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setActionErrorMessage(apiErr.message || 'Failed to rotate biometric terminal key.');
    } finally {
      setIsRotating(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(punchTotal / punchLimit));

  return (
    <div className="space-y-6">
      {/* Top Bar Header Contract */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-800">
        <div>
          <div className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
            Workforce Management · Hardware Bridge
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 flex items-center gap-2.5 mt-0.5">
            <Fingerprint className="w-5 h-5 text-indigo-400" />
            <span>Biometric Hardware Terminals &amp; Sync</span>
          </h1>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            onClick={() => {
              loadTerminals();
              loadSyncSummary();
              if (activeTab === 'punches') loadPunches();
            }}
            disabled={isLoadingTerminals || isLoadingPunches || isLoadingSummary}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/60 rounded-lg transition cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
            title="Refresh devices and punch records"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${
                isLoadingTerminals || isLoadingPunches || isLoadingSummary ? 'animate-spin' : ''
              }`}
            />
            <span>Refresh</span>
          </button>

          <button
            onClick={() => {
              setSyncOutcome(null);
              setSyncError(null);
              setIsSyncModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-indigo-200 bg-indigo-950/80 hover:bg-indigo-900 border border-indigo-700/60 rounded-lg transition cursor-pointer whitespace-nowrap shrink-0"
          >
            <Activity className="w-3.5 h-3.5 text-indigo-400" />
            <span>Reconcile Punches</span>
          </button>

          <button
            onClick={() => {
              setRegisterFormError(null);
              setIsRegisterModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition shadow-sm cursor-pointer whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Register Terminal</span>
          </button>
        </div>
      </div>

      {/* Permission Denied Banner if backend enforced */}
      {permissionDeniedMessage && (
        <div className="p-3.5 bg-red-950/50 border border-red-800/60 rounded-xl flex items-start gap-3 text-red-200 text-xs">
          <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <span className="font-semibold">Security Access Restriction:</span> {permissionDeniedMessage}
          </div>
          <button
            onClick={() => setPermissionDeniedMessage(null)}
            className="text-red-400 hover:text-red-200 text-xs cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Action Feedback Banners */}
      {actionSuccessMessage && (
        <div className="p-3 bg-emerald-950/50 border border-emerald-800/60 rounded-xl flex items-center justify-between text-emerald-200 text-xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{actionSuccessMessage}</span>
          </div>
          <button
            onClick={() => setActionSuccessMessage(null)}
            className="text-emerald-400 hover:text-emerald-200 text-xs font-semibold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {actionErrorMessage && (
        <div className="p-3 bg-red-950/50 border border-red-800/60 rounded-xl flex items-center justify-between text-red-200 text-xs">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{actionErrorMessage}</span>
          </div>
          <button
            onClick={() => setActionErrorMessage(null)}
            className="text-red-400 hover:text-red-200 text-xs font-semibold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Telemetry KPI Strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="p-3.5 bg-slate-900/60 border border-slate-800 rounded-xl">
          <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Registered Terminals</div>
          <div className="text-xl font-bold text-slate-100 font-mono tabular-nums mt-1">
            {terminals.length}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">
            {terminals.filter((t) => t.status === 'ONLINE').length} online · {terminals.filter((t) => t.status === 'OFFLINE').length} offline
          </div>
        </div>

        <div className="p-3.5 bg-slate-900/60 border border-slate-800 rounded-xl">
          <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Pending Reconciliation</div>
          <div className="text-xl font-bold text-amber-300 font-mono tabular-nums mt-1">
            {syncSummary ? syncSummary.pendingCount : '—'}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">Awaiting shift attribution</div>
        </div>

        <div className="p-3.5 bg-slate-900/60 border border-slate-800 rounded-xl">
          <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Processed &amp; Attributed</div>
          <div className="text-xl font-bold text-emerald-400 font-mono tabular-nums mt-1">
            {syncSummary ? syncSummary.processedCount : '—'}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">Synced to Attendance records</div>
        </div>

        <div className="p-3.5 bg-slate-900/60 border border-slate-800 rounded-xl">
          <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Debounced / Ignored</div>
          <div className="text-xl font-bold text-slate-300 font-mono tabular-nums mt-1">
            {syncSummary ? syncSummary.ignoredCount : '—'}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">Rapid re-taps or on-leave</div>
        </div>

        <div className="p-3.5 bg-slate-900/60 border border-slate-800 rounded-xl">
          <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Unmapped / Errors</div>
          <div className="text-xl font-bold text-rose-400 font-mono tabular-nums mt-1">
            {syncSummary ? syncSummary.errorCount : '—'}
          </div>
          <div className="text-[11px] text-slate-400 mt-0.5">Requires enrollment mapping</div>
        </div>
      </div>

      {/* Segmented Tab Navigation */}
      <div className="flex items-center gap-1 p-1 bg-slate-900/80 border border-slate-800 rounded-xl w-fit">
        <button
          onClick={() => setActiveTab('terminals')}
          className={`flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
            activeTab === 'terminals'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
          }`}
        >
          <Server className="w-3.5 h-3.5" />
          <span>Physical Terminals ({terminals.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('punches')}
          className={`flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
            activeTab === 'punches'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Raw Punch Logs</span>
        </button>

        <button
          onClick={() => setActiveTab('sync')}
          className={`flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${
            activeTab === 'sync'
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span>Reconciliation Engine</span>
        </button>
      </div>

      {/* ==================================================================== */}
      {/* TAB 1: REGISTERED TERMINALS                                          */}
      {/* ==================================================================== */}
      {activeTab === 'terminals' && (
        <div className="space-y-4">
          {isLoadingTerminals ? (
            <div className="py-12 flex justify-center">
              <LoadingSpinner message="Loading registered biometric terminals..." size="md" />
            </div>
          ) : terminalsError ? (
            <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-center space-y-2">
              <div className="text-xs text-red-200">{terminalsError}</div>
              <button
                onClick={loadTerminals}
                className="px-3 py-1 bg-red-900/60 hover:bg-red-800 text-red-100 rounded-lg text-xs font-semibold"
              >
                Retry
              </button>
            </div>
          ) : terminals.length === 0 ? (
            <EmptyState
              icon={<Fingerprint className="w-8 h-8 text-indigo-400" />}
              title="No Biometric Terminals Registered"
              description="Register physical ZKTeco or compatible biometric terminals to enable real-time LAN bridge communication and punch log ingestion."
              action={
                <button
                  onClick={() => setIsRegisterModalOpen(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition shadow-sm cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Register First Terminal</span>
                </button>
              }
            />
          ) : (
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900/90 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                      <th className="py-3 px-4">Terminal Name</th>
                      <th className="py-3 px-4">Serial Number</th>
                      <th className="py-3 px-4">Model &amp; LAN Endpoint</th>
                      <th className="py-3 px-4">Location</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Last Heartbeat</th>
                      <th className="py-3 px-4">Last Sync</th>
                      <th className="py-3 px-4">API Key Prefix</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-xs">
                    {terminals.map((terminal) => {
                      const isOnline = terminal.status === 'ONLINE';
                      const isOffline = terminal.status === 'OFFLINE';
                      const isDeactivated = terminal.status === 'DEACTIVATED';

                      return (
                        <tr key={terminal.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-3 px-4 font-medium text-slate-100">
                            <div className="flex items-center gap-2">
                              <Server className="w-4 h-4 text-indigo-400 shrink-0" />
                              <span>{terminal.name}</span>
                            </div>
                            {terminal.notes && (
                              <div className="text-[11px] text-slate-400 truncate max-w-xs mt-0.5">
                                {terminal.notes}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                            {terminal.deviceSerialNumber}
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-300">
                            <div>{terminal.terminalModel}</div>
                            <div className="text-[11px] text-slate-400">
                              {terminal.ipAddress ? `${terminal.ipAddress}:${terminal.port}` : 'Static IP not configured'}
                            </div>
                          </td>
                          <td className="py-3 px-4 text-slate-300">
                            {terminal.location || '—'}
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={`inline-flex items-center gap-1 font-mono text-[11px] font-semibold ${
                                isOnline
                                  ? 'text-emerald-400'
                                  : isOffline
                                  ? 'text-amber-400'
                                  : isDeactivated
                                  ? 'text-slate-400'
                                  : 'text-rose-400'
                              }`}
                            >
                              {isOnline && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                              {isOffline && <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                              {isDeactivated && <XCircle className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                              {!isOnline && !isOffline && !isDeactivated && (
                                <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                              )}
                              <span>{terminal.status}</span>
                            </span>
                          </td>
                          <td className="py-3 px-4 text-slate-400 font-mono tabular-nums">
                            {terminal.lastHeartbeatAt
                              ? new Date(terminal.lastHeartbeatAt).toLocaleString()
                              : 'Never'}
                          </td>
                          <td className="py-3 px-4 text-slate-400 font-mono tabular-nums">
                            {terminal.lastSyncAt
                              ? new Date(terminal.lastSyncAt).toLocaleString()
                              : 'Never'}
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-400">
                            <code>{terminal.apiKeyPrefix}...</code>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {terminal.isActive ? (
                                <>
                                  <button
                                    onClick={() => {
                                      setActionErrorMessage(null);
                                      setRotatingTerminal(terminal);
                                    }}
                                    title="Rotate Device API Key"
                                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-indigo-300 hover:text-indigo-100 bg-indigo-950/60 hover:bg-indigo-900/80 border border-indigo-800/60 rounded-md transition cursor-pointer"
                                  >
                                    <RotateCw className="w-3 h-3 text-indigo-400" />
                                    <span>Rotate Key</span>
                                  </button>
                                  <button
                                    onClick={() => {
                                      setActionErrorMessage(null);
                                      setDeactivatingTerminal(terminal);
                                    }}
                                    title="Deactivate Terminal"
                                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-rose-300 hover:text-rose-100 bg-rose-950/60 hover:bg-rose-900/80 border border-rose-800/60 rounded-md transition cursor-pointer"
                                  >
                                    <Ban className="w-3 h-3 text-rose-400" />
                                    <span>Deactivate</span>
                                  </button>
                                </>
                              ) : (
                                <span className="text-[11px] text-slate-500 font-mono italic">Deactivated</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 2: RAW PUNCH LOGS                                                */}
      {/* ==================================================================== */}
      {activeTab === 'punches' && (
        <div className="space-y-4">
          {/* Filters Strip */}
          <div className="p-3.5 bg-slate-900/60 border border-slate-800 rounded-xl flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Filter className="w-3.5 h-3.5 text-slate-400" />
              <span>Filters:</span>
            </div>

            {/* Sync Status Filter */}
            <select
              value={filterSyncStatus}
              onChange={(e) => {
                setFilterSyncStatus(e.target.value);
                setPunchPage(1);
              }}
              className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
            >
              <option value="">All Sync States</option>
              <option value="PENDING">PENDING</option>
              <option value="PROCESSED">PROCESSED</option>
              <option value="IGNORED">IGNORED</option>
              <option value="ERROR">ERROR</option>
            </select>

            {/* Terminal Filter */}
            <select
              value={filterTerminalId}
              onChange={(e) => {
                setFilterTerminalId(e.target.value);
                setPunchPage(1);
              }}
              className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
            >
              <option value="">All Terminals</option>
              {terminals.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.deviceSerialNumber})
                </option>
              ))}
            </select>

            {/* Start Date */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-slate-400">From:</span>
              <input
                type="date"
                value={filterStartDate}
                onChange={(e) => {
                  setFilterStartDate(e.target.value);
                  setPunchPage(1);
                }}
                className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* End Date */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-slate-400">To:</span>
              <input
                type="date"
                value={filterEndDate}
                onChange={(e) => {
                  setFilterEndDate(e.target.value);
                  setPunchPage(1);
                }}
                className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {(filterSyncStatus || filterTerminalId || filterStartDate || filterEndDate) && (
              <button
                onClick={() => {
                  setFilterSyncStatus('');
                  setFilterTerminalId('');
                  setFilterStartDate('');
                  setFilterEndDate('');
                  setPunchPage(1);
                }}
                className="text-xs text-indigo-400 hover:text-indigo-300 ml-auto cursor-pointer"
              >
                Clear Filters
              </button>
            )}
          </div>

          {/* Punch Table */}
          {isLoadingPunches ? (
            <div className="py-12 flex justify-center">
              <LoadingSpinner message="Querying raw biometric punches..." size="md" />
            </div>
          ) : punchesError ? (
            <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-center space-y-2">
              <div className="text-xs text-red-200">{punchesError}</div>
              <button
                onClick={loadPunches}
                className="px-3 py-1 bg-red-900/60 hover:bg-red-800 text-red-100 rounded-lg text-xs font-semibold"
              >
                Retry
              </button>
            </div>
          ) : punches.length === 0 ? (
            <EmptyState
              icon={<Layers className="w-8 h-8 text-indigo-400" />}
              title="No Raw Punches Found"
              description="No punch records matched the active filter criteria. Terminals will push new events as employees tap their cards or fingerprints."
            />
          ) : (
            <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900/90 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                      <th className="py-3 px-4">Punch Timestamp</th>
                      <th className="py-3 px-4">Enrollment ID</th>
                      <th className="py-3 px-4">Matched Employee</th>
                      <th className="py-3 px-4">Event Mode</th>
                      <th className="py-3 px-4">Verify Type</th>
                      <th className="py-3 px-4">Terminal</th>
                      <th className="py-3 px-4">Sync Status</th>
                      <th className="py-3 px-4">Reconciliation Outcome / Note</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-xs">
                    {punches.map((p) => {
                      const isProcessed = p.syncStatus === 'PROCESSED';
                      const isIgnored = p.syncStatus === 'IGNORED';
                      const isError = p.syncStatus === 'ERROR';
                      const isPending = p.syncStatus === 'PENDING';

                      return (
                        <tr key={p.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="py-3 px-4 font-mono tabular-nums text-slate-200 whitespace-nowrap">
                            {new Date(p.punchTime).toLocaleString()}
                          </td>
                          <td className="py-3 px-4 font-mono font-medium text-indigo-300">
                            {p.userEnrollmentId}
                          </td>
                          <td className="py-3 px-4 text-slate-200">
                            {p.matchedEmployeeName ? (
                              <div>
                                <span className="font-medium text-slate-100">{p.matchedEmployeeName}</span>
                                {p.matchedEmployeeCode && (
                                  <span className="text-[11px] text-slate-400 font-mono ml-1.5">
                                    ({p.matchedEmployeeCode})
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-rose-400 text-[11px] font-medium">Unmapped</span>
                            )}
                          </td>
                          <td className="py-3 px-4 font-mono text-[11px] text-slate-300">
                            {p.inOutMode}
                          </td>
                          <td className="py-3 px-4 text-slate-400 text-[11px]">
                            {p.verifyType}
                          </td>
                          <td className="py-3 px-4 text-slate-400 text-[11px]">
                            {p.terminalName || 'Bridge LAN'}
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={`font-mono text-[11px] font-semibold ${
                                isProcessed
                                  ? 'text-emerald-400'
                                  : isIgnored
                                  ? 'text-slate-400'
                                  : isError
                                  ? 'text-rose-400'
                                  : 'text-amber-400'
                              }`}
                            >
                              {p.syncStatus}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-slate-400 text-[11px] max-w-sm truncate" title={p.errorMessage || ''}>
                            {p.errorMessage ? (
                              <span className={isError ? 'text-rose-300' : 'text-slate-400'}>
                                {p.errorMessage}
                              </span>
                            ) : isProcessed ? (
                              <span className="text-emerald-400/80">Reconciled successfully</span>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination Controls */}
              <div className="py-3 px-4 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
                <div>
                  Showing {punchTotal === 0 ? 0 : (punchPage - 1) * punchLimit + 1} to{' '}
                  {Math.min(punchPage * punchLimit, punchTotal)} of{' '}
                  <span className="font-mono tabular-nums text-slate-200">{punchTotal}</span> punches
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPunchPage((prev) => Math.max(1, prev - 1))}
                    disabled={punchPage <= 1}
                    className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="font-mono tabular-nums">
                    Page {punchPage} of {totalPages}
                  </span>
                  <button
                    onClick={() => setPunchPage((prev) => Math.min(totalPages, prev + 1))}
                    disabled={punchPage >= totalPages}
                    className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================================================================== */}
      {/* TAB 3: RECONCILIATION ENGINE & MANUAL SYNC                           */}
      {/* ==================================================================== */}
      {activeTab === 'sync' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Reconciliation Config & Trigger Card */}
            <div className="p-5 bg-slate-900/60 border border-slate-800 rounded-xl space-y-4">
              <div className="flex items-center gap-2 pb-2 border-b border-slate-800">
                <Activity className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-slate-100">Manual Punch Reconciliation Action</h3>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">
                Triggers the bounded CoreERP reconciliation engine to match pending raw biometric punches against active
                employee shifts, assign work dates, and record verified attendance logs idempotently.
              </p>

              <div className="space-y-3 pt-1">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Batch Size (Records per execution)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={syncBatchSize}
                    onChange={(e) => setSyncBatchSize(parseInt(e.target.value, 10) || 100)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 font-mono tabular-nums focus:outline-none focus:border-indigo-500"
                  />
                  <span className="text-[11px] text-slate-400 mt-0.5 block">
                    Bounded execution cap: 1 to 500 records to prevent blocking request loops.
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Filter by Hardware Terminal (Optional)
                  </label>
                  <select
                    value={syncSelectedTerminalId}
                    onChange={(e) => setSyncSelectedTerminalId(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">All Company Terminals</option>
                    {terminals.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.deviceSerialNumber})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="pt-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={syncRetryErrors}
                      onChange={(e) => setSyncRetryErrors(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-0"
                    />
                    <span className="text-xs text-slate-300">
                      Retry previous error punches (re-evaluates unmapped employees)
                    </span>
                  </label>
                </div>

                {syncError && (
                  <div className="p-3 bg-red-950/40 border border-red-800/60 rounded-lg text-xs text-red-200">
                    {syncError}
                  </div>
                )}

                <div className="pt-2">
                  <button
                    onClick={handleTriggerSync}
                    disabled={isTriggeringSync}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition cursor-pointer shadow-sm"
                  >
                    {isTriggeringSync ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Reconciling Punches...</span>
                      </>
                    ) : (
                      <>
                        <Activity className="w-3.5 h-3.5" />
                        <span>Run Reconciliation Engine</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Reconciliation Outcome / Rules Card */}
            <div className="p-5 bg-slate-900/60 border border-slate-800 rounded-xl space-y-4">
              <div className="flex items-center gap-2 pb-2 border-b border-slate-800">
                <Info className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-slate-100">
                  {syncOutcome ? 'Sync Execution Summary' : 'Reconciliation Safeguards & Business Rules'}
                </h3>
              </div>

              {syncOutcome ? (
                <div className="space-y-3">
                  <div className="p-3.5 bg-emerald-950/30 border border-emerald-800/50 rounded-xl text-emerald-200 text-xs">
                    <div className="font-semibold text-emerald-100 flex items-center gap-1.5 mb-1">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      <span>Reconciliation Completed</span>
                    </div>
                    <div>Evaluated {syncOutcome.totalEvaluated} raw punch records in company isolation.</div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/60">
                      <div className="text-[11px] text-slate-400 uppercase">Processed</div>
                      <div className="text-lg font-bold text-emerald-400 font-mono tabular-nums mt-0.5">
                        {syncOutcome.processed}
                      </div>
                    </div>
                    <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/60">
                      <div className="text-[11px] text-slate-400 uppercase">Ignored</div>
                      <div className="text-lg font-bold text-slate-300 font-mono tabular-nums mt-0.5">
                        {syncOutcome.ignored}
                      </div>
                    </div>
                    <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/60">
                      <div className="text-[11px] text-slate-400 uppercase">Errors</div>
                      <div className="text-lg font-bold text-rose-400 font-mono tabular-nums mt-0.5">
                        {syncOutcome.errors}
                      </div>
                    </div>
                  </div>

                  {syncOutcome.results.length > 0 && (
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      <div className="text-[11px] font-medium text-slate-400">Sample Results:</div>
                      {syncOutcome.results.slice(0, 5).map((r, i) => (
                        <div
                          key={i}
                          className="p-2 bg-slate-800/40 rounded border border-slate-700/40 text-[11px] flex items-center justify-between"
                        >
                          <span className="font-mono text-slate-300">
                            {r.userEnrollmentId} · {r.workDate || 'Unassigned'}
                          </span>
                          <span
                            className={`font-mono font-semibold ${
                              r.status === 'PROCESSED'
                                ? 'text-emerald-400'
                                : r.status === 'IGNORED'
                                ? 'text-slate-400'
                                : 'text-rose-400'
                            }`}
                          >
                            {r.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2.5 text-xs text-slate-300">
                  <div className="flex items-start gap-2">
                    <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-slate-100">Tenant Isolation:</strong> Punches strictly map to active employees
                      with matching <code className="text-indigo-300 font-mono">biometricDeviceId</code> in the same company.
                    </span>
                  </div>

                  <div className="flex items-start gap-2">
                    <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-slate-100">Payroll Integrity Protection:</strong> Will never modify attendance
                      on dates locked by finalized or posted monthly payroll periods.
                    </span>
                  </div>

                  <div className="flex items-start gap-2">
                    <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-slate-100">Leave Preservation:</strong> Preserves approved ON_LEAVE records
                      without overwriting approved absence.
                    </span>
                  </div>

                  <div className="flex items-start gap-2">
                    <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-slate-100">Overnight Shift Awareness:</strong> Automatically maps punches
                      commencing before midnight to the correct shift start date.
                    </span>
                  </div>

                  <div className="flex items-start gap-2">
                    <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-slate-100">Debouncing &amp; Deduplication:</strong> Repeated taps within 2
                      minutes are safely debounced without duplicate logs.
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL 1: REGISTER BIOMETRIC TERMINAL                                 */}
      {/* ==================================================================== */}
      {isRegisterModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-5 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Server className="w-5 h-5 text-indigo-400" />
                <h3 className="text-sm font-bold text-slate-100">Register Biometric Hardware Terminal</h3>
              </div>
              <button
                onClick={() => setIsRegisterModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 text-xs cursor-pointer"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleRegisterDevice} className="p-5 space-y-4">
              {registerFormError && (
                <div className="p-3 bg-red-950/40 border border-red-800/60 rounded-lg text-xs text-red-200">
                  {registerFormError}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Terminal Display Name <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Main Lobby Gate A"
                    value={formDeviceName}
                    onChange={(e) => setFormDeviceName(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Device Serial Number <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. F22-SN-998822"
                    value={formSerialNumber}
                    onChange={(e) => setFormSerialNumber(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Terminal Model
                  </label>
                  <input
                    type="text"
                    placeholder="ZKTeco-F22"
                    value={formTerminalModel}
                    onChange={(e) => setFormTerminalModel(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    LAN IP Address
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. 192.168.1.201"
                    value={formIpAddress}
                    onChange={(e) => setFormIpAddress(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Hardware Port
                  </label>
                  <input
                    type="number"
                    value={formPort}
                    onChange={(e) => setFormPort(parseInt(e.target.value, 10) || 4370)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 font-mono tabular-nums focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Physical Installation Location
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Building 2, Ground Floor Entrance"
                    value={formLocation}
                    onChange={(e) => setFormLocation(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Notes &amp; Installation Instructions (Optional)
                  </label>
                  <textarea
                    rows={2}
                    placeholder="Hardware firmware version, switch port notes..."
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsRegisterModalOpen(false)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-800/80 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingDevice}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition cursor-pointer shadow-sm"
                >
                  {isSubmittingDevice ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Registering...</span>
                    </>
                  ) : (
                    <>
                      <Plus className="w-3.5 h-3.5" />
                      <span>Create Terminal</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL 2: ONE-TIME API KEY DISPLAY (NEVER PERSISTED)                  */}
      {/* ==================================================================== */}
      {oneTimeApiKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-sm">
          <div className="w-full max-w-md bg-slate-900 border border-indigo-700/60 rounded-2xl shadow-2xl p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="w-12 h-12 rounded-xl bg-indigo-950 border border-indigo-700/60 flex items-center justify-center text-indigo-400 mx-auto">
              <CheckCircle2 className="w-6 h-6" />
            </div>

            <div className="text-center space-y-1">
              <h3 className="text-base font-bold text-slate-100">Terminal Registered Successfully</h3>
              <p className="text-xs text-slate-400">
                Generated credentials for <span className="text-indigo-300 font-semibold">{registeredTerminalName}</span>
              </p>
            </div>

            <div className="p-3.5 bg-amber-950/40 border border-amber-800/60 rounded-xl text-xs text-amber-200/90 leading-relaxed">
              <strong className="text-amber-100 block mb-0.5">Critical Security Notice:</strong>
              Copy this device API key now. For tenant isolation and security, this key is shown <strong>only once</strong> and cannot be retrieved later. It will never be stored in your browser.
            </div>

            <div className="space-y-1.5">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Device Secret API Key
              </label>
              <div className="flex items-center gap-2 p-2.5 bg-slate-950 border border-slate-800 rounded-xl">
                <code className="text-xs font-mono text-indigo-300 break-all select-all flex-1">
                  {oneTimeApiKey}
                </code>
                <button
                  onClick={handleCopyKey}
                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition shrink-0 cursor-pointer"
                  title="Copy API key to clipboard"
                >
                  {isCopiedKey ? (
                    <Check className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <Copy className="w-4 h-4 text-slate-300" />
                  )}
                </button>
              </div>
              {isCopiedKey && (
                <div className="text-[11px] text-emerald-400 font-medium">Copied API key to clipboard!</div>
              )}
            </div>

            <div className="pt-2">
              <button
                onClick={handleCloseKeyModal}
                className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition cursor-pointer border border-slate-700"
              >
                I have saved this key safely
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* MODAL 3: MANUAL RECONCILIATION QUICK TRIGGER                         */}
      {/* ==================================================================== */}
      {isSyncModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-indigo-400" />
                <h3 className="text-sm font-bold text-slate-100">Manual Punch Reconciliation</h3>
              </div>
              <button
                onClick={() => setIsSyncModalOpen(false)}
                className="text-slate-400 hover:text-slate-200 text-xs cursor-pointer"
              >
                ✕
              </button>
            </div>

            {syncOutcome ? (
              <div className="space-y-4">
                <div className="p-3 bg-emerald-950/40 border border-emerald-800/60 rounded-xl text-emerald-200 text-xs">
                  <div className="font-semibold text-emerald-100 flex items-center gap-1.5 mb-1">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>Sync Completed</span>
                  </div>
                  <div>Evaluated {syncOutcome.totalEvaluated} records.</div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="p-2.5 bg-slate-800/60 rounded-lg">
                    <div className="text-[10px] text-slate-400 uppercase">Processed</div>
                    <div className="text-base font-bold text-emerald-400 font-mono tabular-nums">
                      {syncOutcome.processed}
                    </div>
                  </div>
                  <div className="p-2.5 bg-slate-800/60 rounded-lg">
                    <div className="text-[10px] text-slate-400 uppercase">Ignored</div>
                    <div className="text-base font-bold text-slate-300 font-mono tabular-nums">
                      {syncOutcome.ignored}
                    </div>
                  </div>
                  <div className="p-2.5 bg-slate-800/60 rounded-lg">
                    <div className="text-[10px] text-slate-400 uppercase">Errors</div>
                    <div className="text-base font-bold text-rose-400 font-mono tabular-nums">
                      {syncOutcome.errors}
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => setIsSyncModalOpen(false)}
                  className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold cursor-pointer"
                >
                  Close &amp; View Punch Logs
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-slate-400 leading-relaxed">
                  Reconcile pending punches with shift schedules. Safely handles debounces, overnight shifts, and protects locked payroll periods.
                </p>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Batch Size</label>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={syncBatchSize}
                      onChange={(e) => setSyncBatchSize(parseInt(e.target.value, 10) || 100)}
                      className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 font-mono tabular-nums focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">Terminal Filter (Optional)</label>
                    <select
                      value={syncSelectedTerminalId}
                      onChange={(e) => setSyncSelectedTerminalId(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="">All Company Terminals</option>
                      {terminals.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.deviceSerialNumber})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={syncRetryErrors}
                        onChange={(e) => setSyncRetryErrors(e.target.checked)}
                        className="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-0"
                      />
                      <span className="text-xs text-slate-300">Retry previously failed punches</span>
                    </label>
                  </div>

                  {syncError && (
                    <div className="p-2.5 bg-red-950/40 border border-red-800/60 rounded-lg text-xs text-red-200">
                      {syncError}
                    </div>
                  )}
                </div>

                <div className="pt-2 flex items-center justify-end gap-2.5">
                  <button
                    type="button"
                    onClick={() => setIsSyncModalOpen(false)}
                    className="px-3.5 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-800/80 rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleTriggerSync}
                    disabled={isTriggeringSync}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition cursor-pointer shadow-sm"
                  >
                    {isTriggeringSync ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Reconciling...</span>
                      </>
                    ) : (
                      <>
                        <Activity className="w-3.5 h-3.5" />
                        <span>Run Sync</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL 4: DEACTIVATE TERMINAL CONFIRMATION */}
      {deactivatingTerminal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-rose-950/60 border border-rose-800/80 rounded-xl text-rose-400">
                <Ban className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-100">Deactivate Terminal</h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  {deactivatingTerminal.name} ({deactivatingTerminal.deviceSerialNumber})
                </p>
              </div>
            </div>

            <div className="p-3 bg-rose-950/30 border border-rose-900/50 rounded-xl text-xs text-rose-200/90 leading-relaxed">
              <span className="font-semibold text-rose-300">Warning:</span> Deactivating this terminal will immediately revoke its API credentials and take it offline. Existing punch logs will be preserved, but the physical terminal or bridge daemon will no longer be able to ingest new biometric events until re-activated.
            </div>

            <div className="pt-2 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setDeactivatingTerminal(null)}
                disabled={isDeactivating}
                className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg cursor-pointer transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeactivate}
                disabled={isDeactivating}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition cursor-pointer shadow-sm"
              >
                {isDeactivating ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Deactivating...</span>
                  </>
                ) : (
                  <>
                    <Ban className="w-3.5 h-3.5" />
                    <span>Deactivate Terminal</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 5: ROTATE API KEY CONFIRMATION */}
      {rotatingTerminal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-indigo-950/60 border border-indigo-800/80 rounded-xl text-indigo-400">
                <Key className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-100">Rotate Device API Key</h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  {rotatingTerminal.name} ({rotatingTerminal.deviceSerialNumber})
                </p>
              </div>
            </div>

            <div className="p-3 bg-amber-950/30 border border-amber-900/50 rounded-xl text-xs text-amber-200/90 leading-relaxed">
              <span className="font-semibold text-amber-300">Important:</span> Rotating the key will immediately invalidate the current credentials. The physical LAN terminal or daemon must be reconfigured with the new API key to continue transmitting punches and heartbeats.
            </div>

            <p className="text-xs text-slate-400">
              The new high-entropy API key will be displayed exactly once in the next dialog and will never be shown again.
            </p>

            <div className="pt-2 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setRotatingTerminal(null)}
                disabled={isRotating}
                className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg cursor-pointer transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRotateKey}
                disabled={isRotating}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition cursor-pointer shadow-sm"
              >
                {isRotating ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Rotating...</span>
                  </>
                ) : (
                  <>
                    <RotateCw className="w-3.5 h-3.5" />
                    <span>Generate New Key</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
