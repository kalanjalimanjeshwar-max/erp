import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  Wifi,
  WifiOff,
  PlugZap,
  Terminal,
  BookOpen,
  Play,
  Users,
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
  PunchReconciliationOptions,
  PunchReconciliationResponse,
  CreateBiometricTerminalRequest,
  CompanyProfile,
  DeviceEnrolledUserItem,
  EmployeeItem,
} from '../../shared/types.ts';
import {
  BIOMETRIC_MODEL_PRESETS,
  ESSL_X2008_HARDWARE_PROFILE,
} from '../../shared/biometric.ts';
import {
  formatDateTimeInTimezone,
  formatUtcTimestamp,
  getEffectiveTimeZone,
  localDateTimeToUtcIso,
} from '../../shared/timezone.ts';

const DATE_ONLY_INPUT_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME_INPUT_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_DATETIME_TZ_INPUT_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;
export const TERMINAL_STATUS_REFRESH_INTERVAL_MS = 15000;

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Converts an optional administrator-supplied "From Punch Date/Time" input into
 * an API-compatible cutoff string (`YYYY-MM-DD` or UTC ISO-8601), or `undefined`
 * when blank so normal company-local today-only sync cutoff is preserved.
 */
export function parseLocalHistoricalCutoffInput(
  input: string,
  timezone: string
): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const dateOnlyMatch = DATE_ONLY_INPUT_REGEX.exec(trimmed);
  if (dateOnlyMatch) {
    const [, y, m, d] = dateOnlyMatch;
    if (!isValidCalendarDate(Number(y), Number(m), Number(d))) {
      throw new Error(`Invalid From Punch Date '${trimmed}'. Please choose a valid calendar date.`);
    }
    return trimmed;
  }

  const localDtMatch = LOCAL_DATETIME_INPUT_REGEX.exec(trimmed);
  if (localDtMatch) {
    const [, y, m, d, hh, mm, ss] = localDtMatch;
    const hour = Number(hh);
    const minute = Number(mm);
    const second = ss !== undefined ? Number(ss) : 0;
    if (
      !isValidCalendarDate(Number(y), Number(m), Number(d)) ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    ) {
      throw new Error(`Invalid From Punch Date/Time '${trimmed}'.`);
    }
    const datePart = `${y}-${m}-${d}`;
    const timePart = `${hh}:${mm}:${ss ?? '00'}`;
    return localDateTimeToUtcIso(datePart, timePart, timezone);
  }

  const isoMatch = ISO_DATETIME_TZ_INPUT_REGEX.exec(trimmed);
  if (isoMatch) {
    const [, y, m, d, hh, mm, ss] = isoMatch;
    const hour = Number(hh);
    const minute = Number(mm);
    const second = ss !== undefined ? Number(ss) : 0;
    if (
      !isValidCalendarDate(Number(y), Number(m), Number(d)) ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      Number.isNaN(new Date(trimmed).getTime())
    ) {
      throw new Error(`Invalid From Punch Date/Time '${trimmed}'.`);
    }
    return trimmed;
  }

  throw new Error(
    "Invalid From Punch Date/Time. Leave blank for today-only sync or enter a valid date/time."
  );
}

export interface BuildBiometricSyncPayloadInput {
  batchSize: number;
  retryErrors: boolean;
  terminalId?: string;
  userEnrollmentId?: string;
  employeeId?: string;
  punchId?: string;
  fromPunchDateTime?: string;
  timezone: string;
}

export function buildBiometricSyncPayload(
  params: BuildBiometricSyncPayloadInput
): PunchReconciliationOptions {
  const trimmedEnrollmentId = (params.userEnrollmentId || '').trim();
  const parsedFromPunchTime = parseLocalHistoricalCutoffInput(
    params.fromPunchDateTime || '',
    params.timezone
  );

  return {
    batchSize: params.punchId ? 1 : Math.max(1, Math.min(500, params.batchSize)),
    retryErrors: params.retryErrors,
    ...(params.terminalId ? { terminalId: params.terminalId } : {}),
    ...(trimmedEnrollmentId ? { userEnrollmentId: trimmedEnrollmentId } : {}),
    ...(params.employeeId ? { employeeId: params.employeeId } : {}),
    ...(params.punchId ? { punchId: params.punchId } : {}),
    ...(parsedFromPunchTime !== undefined ? { fromPunchTime: parsedFromPunchTime } : {}),
  };
}

export interface BiometricHistoricalCutoffNoticeProps {
  timezone: string;
  compact?: boolean;
}

export const BiometricHistoricalCutoffNotice: React.FC<BiometricHistoricalCutoffNoticeProps> = ({
  timezone,
  compact = false,
}) => (
  <div
    className={`${
      compact ? 'p-3' : 'p-3.5'
    } bg-amber-950/30 border border-amber-700/50 rounded-xl flex items-start gap-2.5 text-amber-100 text-xs`}
  >
    <Clock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
    <div className="space-y-1 leading-relaxed">
      <div className="font-semibold text-amber-200">
        Normal Sync Today-Only Cutoff ({timezone})
      </div>
      <p className="text-[11px] text-amber-200/90">
        Normal biometric sync processes only punches from the beginning of the current company-local
        day (00:00 in <span className="font-mono text-amber-100">{timezone}</span>). Historical{' '}
        <span className="font-mono font-semibold text-amber-100">PENDING</span> punches from prior
        days are never processed automatically by normal sync.
      </p>
      {!compact && (
        <p className="text-[11px] text-amber-300/80">
          To intentionally reconcile historical pending punches, open Manual Punch Reconciliation or
          the Reconciliation Engine tab and explicitly set a{' '}
          <span className="font-semibold text-amber-100">From Punch Date/Time</span> cutoff.
        </p>
      )}
    </div>
  </div>
);

export interface BiometricHistoricalConfirmationBannerProps {
  fromPunchDateTime: string;
  resolvedCutoffIso: string;
  timezone: string;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const BiometricHistoricalConfirmationBanner: React.FC<
  BiometricHistoricalConfirmationBannerProps
> = ({ fromPunchDateTime, resolvedCutoffIso, timezone, isSubmitting, onCancel, onConfirm }) => {
  const formattedLocalCutoff = DATE_ONLY_INPUT_REGEX.test(resolvedCutoffIso)
    ? `${resolvedCutoffIso} 00:00 (${timezone})`
    : `${formatDateTimeInTimezone(resolvedCutoffIso, timezone, { includeSeconds: true })} (${timezone})`;

  return (
    <div className="p-3.5 bg-amber-950/50 border border-amber-600/70 rounded-xl space-y-2.5 text-xs text-amber-100">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div className="font-semibold text-amber-200">
            Confirm Historical Punch Reconciliation
          </div>
          <p className="text-[11px] text-amber-100/90 leading-relaxed">
            You have explicitly specified a historical cutoff (
            <span className="font-mono font-semibold text-amber-50">{formattedLocalCutoff}</span>
            {fromPunchDateTime.trim() !== resolvedCutoffIso && (
              <span className="text-amber-300/90"> · UTC {resolvedCutoffIso}</span>
            )}
            ). Historical <span className="font-mono">PENDING</span> punches from this timestamp
            onward will be evaluated and reconciled against historical shift and work-policy rules.
            Locked payroll periods and approved leave records remain protected.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          className="px-3 py-1.5 text-[11px] font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition cursor-pointer disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isSubmitting}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[11px] font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition cursor-pointer disabled:opacity-50"
        >
          {isSubmitting ? (
            <>
              <RefreshCw className="w-3 h-3 animate-spin" />
              <span>Reconciling Historical Punches...</span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-3 h-3" />
              <span>Confirm Historical Reconciliation</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};

interface BiometricDevicesPageProps {
  currentUser: AuthUser;
  companyProfile?: CompanyProfile | null;
}

export const BiometricDevicesPage: React.FC<BiometricDevicesPageProps> = ({
  currentUser,
  companyProfile,
}) => {
  const timezone = getEffectiveTimeZone(companyProfile?.timezone);
  const [activeTab, setActiveTab] = useState<'terminals' | 'punches' | 'sync'>('terminals');

  // Terminals State
  const [terminals, setTerminals] = useState<BiometricTerminalItem[]>([]);
  const [isLoadingTerminals, setIsLoadingTerminals] = useState<boolean>(true);
  const [terminalsError, setTerminalsError] = useState<string | null>(null);
  const isTerminalsRequestInFlightRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);

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
  const [filterEnrollmentId, setFilterEnrollmentId] = useState<string>('');
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');

  // Device Registration Modal State
  const [isRegisterModalOpen, setIsRegisterModalOpen] = useState<boolean>(false);
  const [isSubmittingDevice, setIsSubmittingDevice] = useState<boolean>(false);
  const [registerFormError, setRegisterFormError] = useState<string | null>(null);

  // Registration Form Fields (Defaulting to eSSL X2008 profile)
  const [formPresetId, setFormPresetId] = useState<string>('essl-x2008');
  const [formDeviceName, setFormDeviceName] = useState<string>('');
  const [formSerialNumber, setFormSerialNumber] = useState<string>('');
  const [formTerminalModel, setFormTerminalModel] = useState<string>(ESSL_X2008_HARDWARE_PROFILE.terminalModel);
  const [formIpAddress, setFormIpAddress] = useState<string>('');
  const [formPort, setFormPort] = useState<number>(ESSL_X2008_HARDWARE_PROFILE.defaultPort);
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
  const [syncEnrollmentId, setSyncEnrollmentId] = useState<string>('');
  const [syncSelectedEmployeeId, setSyncSelectedEmployeeId] = useState<string>('');
  const [syncSelectedPunchId, setSyncSelectedPunchId] = useState<string>('');
  const [syncRetryErrors, setSyncRetryErrors] = useState<boolean>(false);
  const [syncFromPunchTime, setSyncFromPunchTime] = useState<string>('');
  const [isConfirmingHistoricalSync, setIsConfirmingHistoricalSync] = useState<boolean>(false);
  const [syncOutcome, setSyncOutcome] = useState<PunchReconciliationResponse | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [reconcileEmployees, setReconcileEmployees] = useState<EmployeeItem[]>([]);
  const [pendingPunchOptions, setPendingPunchOptions] = useState<RawPunchLogItem[]>([]);
  const [isLoadingPendingPunchOptions, setIsLoadingPendingPunchOptions] = useState<boolean>(false);

  // Permission feedback
  const [permissionDeniedMessage, setPermissionDeniedMessage] = useState<string | null>(null);

  // Terminal Action States (Deactivation, Key Rotation, Connection Probe, Per-Terminal Sync, Setup Guide)
  const [deactivatingTerminal, setDeactivatingTerminal] = useState<BiometricTerminalItem | null>(null);
  const [isDeactivating, setIsDeactivating] = useState<boolean>(false);
  const [rotatingTerminal, setRotatingTerminal] = useState<BiometricTerminalItem | null>(null);
  const [isRotating, setIsRotating] = useState<boolean>(false);
  const [testingTerminalId, setTestingTerminalId] = useState<string | null>(null);
  const [syncingTerminalId, setSyncingTerminalId] = useState<string | null>(null);
  const [selectedUserSyncTerminalId, setSelectedUserSyncTerminalId] = useState<string>('');
  const [syncingUsersTerminalId, setSyncingUsersTerminalId] = useState<string | null>(null);
  const [pollingUserSyncTerminalId, setPollingUserSyncTerminalId] = useState<string | null>(null);
  const [selectedTerminalDeviceUsers, setSelectedTerminalDeviceUsers] = useState<DeviceEnrolledUserItem[]>([]);
  const [isLoadingDeviceUsers, setIsLoadingDeviceUsers] = useState<boolean>(false);
  const [showBridgeGuide, setShowBridgeGuide] = useState<boolean>(false);
  const [actionSuccessMessage, setActionSuccessMessage] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);

  // Load Terminals (supports silent background refresh without full-page spinner or overlapping requests)
  const loadTerminals = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (isTerminalsRequestInFlightRef.current) {
      return;
    }

    isTerminalsRequestInFlightRef.current = true;
    if (!silent) {
      setIsLoadingTerminals(true);
      setTerminalsError(null);
    }
    try {
      const data = await api.getBiometricDevices({ includeInactive: true });
      if (!isMountedRef.current) return;
      setTerminals(data);
      setTerminalsError(null);
    } catch (err: unknown) {
      if (!isMountedRef.current) return;
      const apiErr = err as ApiError;
      if (apiErr.statusCode === 403) {
        setPermissionDeniedMessage('Permission denied: Elevated role required to view biometric terminals.');
      } else if (!silent) {
        setTerminalsError(apiErr.message || 'Failed to load biometric terminals.');
      }
    } finally {
      isTerminalsRequestInFlightRef.current = false;
      if (!silent && isMountedRef.current) {
        setIsLoadingTerminals(false);
      }
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
        userEnrollmentId: filterEnrollmentId.trim() || undefined,
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
  }, [filterSyncStatus, filterTerminalId, filterEnrollmentId, filterStartDate, filterEndDate, punchPage, punchLimit]);

  // Load Eligible Pending Punches & Employees for Targeted Reconciliation
  const loadReconciliationTargets = useCallback(async (includeErrorPunches: boolean) => {
    setIsLoadingPendingPunchOptions(true);
    try {
      const [pendingRes, errorRes, employeesRes] = await Promise.all([
        api.getBiometricPunches({ syncStatus: 'PENDING', page: 1, limit: 100 }),
        includeErrorPunches
          ? api.getBiometricPunches({ syncStatus: 'ERROR', page: 1, limit: 100 })
          : Promise.resolve({ items: [] as RawPunchLogItem[], total: 0, page: 1, limit: 100 }),
        api.getEmployees({ limit: 500 }).catch(() => ({ items: [] as EmployeeItem[], total: 0, page: 1, limit: 500 })),
      ]);

      const mergedMap = new Map<string, RawPunchLogItem>();
      for (const item of [...pendingRes.items, ...errorRes.items]) {
        mergedMap.set(item.id, item);
      }
      const sorted = Array.from(mergedMap.values()).sort(
        (a, b) => new Date(a.punchTime).getTime() - new Date(b.punchTime).getTime()
      );
      setPendingPunchOptions(sorted);
      if (employeesRes.items.length > 0) {
        setReconcileEmployees(employeesRes.items);
      }
    } catch {
      // Non-fatal: manual text entry for Enrollment ID remains available
    } finally {
      setIsLoadingPendingPunchOptions(false);
    }
  }, []);

  const loadSelectedTerminalDeviceUsers = useCallback(async (terminalId: string) => {
    if (!terminalId) {
      setSelectedTerminalDeviceUsers([]);
      return;
    }
    setIsLoadingDeviceUsers(true);
    try {
      const users = await api.getBiometricTerminalDeviceUsers(terminalId);
      setSelectedTerminalDeviceUsers(users);
    } catch {
      setSelectedTerminalDeviceUsers([]);
    } finally {
      setIsLoadingDeviceUsers(false);
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    loadTerminals();
    loadSyncSummary();
  }, [loadTerminals, loadSyncSummary]);

  // Silent 15-second auto-refresh of terminal Bridge & physical Device connection status
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadTerminals({ silent: true });
    }, TERMINAL_STATUS_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [loadTerminals]);

  useEffect(() => {
    if (terminals.length === 0) {
      setSelectedUserSyncTerminalId('');
      setSelectedTerminalDeviceUsers([]);
      return;
    }
    const existingStillExists = terminals.some((t) => t.id === selectedUserSyncTerminalId);
    if (!existingStillExists) {
      const preferred = terminals.find((t) => t.isActive) || terminals[0];
      setSelectedUserSyncTerminalId(preferred.id);
    }
  }, [terminals, selectedUserSyncTerminalId]);

  useEffect(() => {
    if (selectedUserSyncTerminalId) {
      loadSelectedTerminalDeviceUsers(selectedUserSyncTerminalId);
    }
  }, [selectedUserSyncTerminalId, loadSelectedTerminalDeviceUsers]);

  // Automatic polling while any terminal has an active QUEUED/RUNNING user-sync job
  useEffect(() => {
    const activeTerminal =
      terminals.find(
        (t) =>
          t.id === pollingUserSyncTerminalId &&
          (t.userSyncStatus === 'QUEUED' || t.userSyncStatus === 'RUNNING')
      ) ||
      terminals.find((t) => t.userSyncStatus === 'QUEUED' || t.userSyncStatus === 'RUNNING') ||
      null;

    if (!activeTerminal) {
      if (pollingUserSyncTerminalId !== null) {
        setPollingUserSyncTerminalId(null);
      }
      return;
    }

    let cancelled = false;
    const pollTargetId = activeTerminal.id;

    const timer = window.setInterval(async () => {
      if (cancelled) return;
      try {
        const statusRes = await api.getBiometricUserSyncStatus(pollTargetId);
        if (cancelled) return;

        setTerminals((prev) =>
          prev.map((t) => (t.id === pollTargetId ? statusRes.terminal : t))
        );
        if (pollTargetId === selectedUserSyncTerminalId) {
          setSelectedTerminalDeviceUsers(statusRes.deviceUsers || []);
        }

        if (statusRes.userSyncStatus === 'SUCCESS') {
          setPollingUserSyncTerminalId(null);
          const count = statusRes.job?.syncedCount ?? statusRes.deviceUsers.length;
          setActionErrorMessage(null);
          setActionSuccessMessage(
            `${statusRes.terminal.name}: Hardware user sync completed successfully (${count} enrolled user${count === 1 ? '' : 's'} synchronized).`
          );
        } else if (statusRes.userSyncStatus === 'FAILED') {
          setPollingUserSyncTerminalId(null);
          setActionSuccessMessage(null);
          setActionErrorMessage(
            `${statusRes.terminal.name}: Hardware user sync failed — ${
              statusRes.job?.error || statusRes.terminal.lastUserSyncError || 'Check bridge connectivity.'
            }`
          );
        }
      } catch {
        // Transient poll error; keep polling until next interval
      }
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [terminals, pollingUserSyncTerminalId, selectedUserSyncTerminalId]);

  useEffect(() => {
    if (activeTab === 'punches') {
      loadPunches();
    }
  }, [activeTab, loadPunches]);

  useEffect(() => {
    if (activeTab === 'sync' || isSyncModalOpen) {
      loadReconciliationTargets(syncRetryErrors);
    }
  }, [activeTab, isSyncModalOpen, syncRetryErrors, loadReconciliationTargets]);

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
        terminalModel: formTerminalModel.trim() || ESSL_X2008_HARDWARE_PROFILE.terminalModel,
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
      setFormPresetId('essl-x2008');
      setFormTerminalModel(ESSL_X2008_HARDWARE_PROFILE.terminalModel);
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

  // Execute Manual Punch Sync (Default Today-Only Batch, Targeted Filter, or Confirmed Historical Cutoff)
  const executeTriggerSync = async () => {
    setIsTriggeringSync(true);
    setSyncError(null);
    setSyncOutcome(null);

    try {
      const payload = buildBiometricSyncPayload({
        batchSize: syncBatchSize,
        retryErrors: syncRetryErrors,
        terminalId: syncSelectedTerminalId || undefined,
        userEnrollmentId: syncEnrollmentId || undefined,
        employeeId: syncSelectedEmployeeId || undefined,
        punchId: syncSelectedPunchId || undefined,
        fromPunchDateTime: syncFromPunchTime,
        timezone,
      });

      const result = await api.triggerBiometricSync(payload);

      setIsConfirmingHistoricalSync(false);
      setSyncOutcome(result);

      // Refresh telemetry and punch log records
      loadSyncSummary();
      loadTerminals();
      loadReconciliationTargets(syncRetryErrors);
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

  // Handle Manual Punch Sync Click (Requires Explicit Confirmation When Historical Cutoff Is Set)
  const handleTriggerSync = async () => {
    setSyncError(null);
    const trimmedHistoricalCutoff = syncFromPunchTime.trim();

    if (trimmedHistoricalCutoff) {
      try {
        parseLocalHistoricalCutoffInput(trimmedHistoricalCutoff, timezone);
      } catch (err: unknown) {
        setSyncError((err as Error).message || 'Invalid From Punch Date/Time.');
        return;
      }

      if (!isConfirmingHistoricalSync) {
        setIsConfirmingHistoricalSync(true);
        return;
      }
    }

    await executeTriggerSync();
  };

  const handleOpenTargetedPunchReconcile = (punch: RawPunchLogItem) => {
    setSyncOutcome(null);
    setSyncError(null);
    setSyncSelectedTerminalId('');
    setSyncEnrollmentId('');
    setSyncSelectedEmployeeId('');
    setSyncSelectedPunchId(punch.id);
    setSyncFromPunchTime('');
    setIsConfirmingHistoricalSync(false);
    setSyncRetryErrors(punch.syncStatus === 'ERROR');
    setPendingPunchOptions((prev) =>
      prev.some((item) => item.id === punch.id) ? prev : [punch, ...prev]
    );
    setIsSyncModalOpen(true);
  };

  const clearSyncFilters = () => {
    setSyncSelectedTerminalId('');
    setSyncEnrollmentId('');
    setSyncSelectedEmployeeId('');
    setSyncSelectedPunchId('');
    setSyncFromPunchTime('');
    setIsConfirmingHistoricalSync(false);
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

  // Handle Per-Terminal Connection Probe
  const handleTestConnection = async (terminal: BiometricTerminalItem) => {
    setTestingTerminalId(terminal.id);
    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    try {
      const res = await api.testBiometricDeviceConnection(terminal.id);
      setTerminals((prev) => prev.map((t) => (t.id === terminal.id ? res.terminal : t)));
      if (res.success) {
        setActionSuccessMessage(`${terminal.name}: ${res.message}`);
      } else {
        setActionErrorMessage(`${terminal.name}: ${res.message}`);
      }
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setActionErrorMessage(apiErr.message || 'Failed to test terminal connectivity.');
    } finally {
      setTestingTerminalId(null);
    }
  };

  // Handle Per-Terminal Sync & Reconciliation Trigger
  const handleSyncTerminal = async (terminal: BiometricTerminalItem) => {
    setSyncingTerminalId(terminal.id);
    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    try {
      const res = await api.triggerBiometricDeviceSync(terminal.id, { batchSize: 100 });
      setTerminals((prev) => prev.map((t) => (t.id === terminal.id ? res.terminal : t)));
      setActionSuccessMessage(`${terminal.name}: ${res.message}`);
      loadSyncSummary();
      if (activeTab === 'punches') loadPunches();
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setActionErrorMessage(apiErr.message || 'Failed to queue terminal sync.');
    } finally {
      setSyncingTerminalId(null);
    }
  };

  // Handle Explicit Hardware User Sync Trigger (never runs PunchReconciliationService)
  const handleSyncDeviceUsers = async (terminal: BiometricTerminalItem) => {
    setSelectedUserSyncTerminalId(terminal.id);
    setSyncingUsersTerminalId(terminal.id);
    setActionErrorMessage(null);
    setActionSuccessMessage(null);
    try {
      const res = await api.syncBiometricTerminalUsers(terminal.id);
      setTerminals((prev) => prev.map((t) => (t.id === terminal.id ? res.terminal : t)));
      setSelectedTerminalDeviceUsers(res.deviceUsers || []);
      setPollingUserSyncTerminalId(terminal.id);
      setActionSuccessMessage(`${terminal.name}: ${res.message}`);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      setActionErrorMessage(apiErr.message || 'Failed to queue hardware user sync.');
    } finally {
      setSyncingUsersTerminalId(null);
    }
  };

  const selectedUserSyncTerminal =
    terminals.find((t) => t.id === selectedUserSyncTerminalId) || null;
  const totalPages = Math.max(1, Math.ceil(punchTotal / punchLimit));

  const selectedSyncEmployee =
    reconcileEmployees.find((emp) => emp.id === syncSelectedEmployeeId) || null;
  const trimmedSyncEnrollmentId = syncEnrollmentId.trim();
  const isTargetedReconciliation = Boolean(
    syncSelectedPunchId || trimmedSyncEnrollmentId || syncSelectedEmployeeId || syncSelectedTerminalId
  );

  const filteredPendingPunchOptions = pendingPunchOptions.filter((item) => {
    if (syncSelectedPunchId && item.id === syncSelectedPunchId) return true;
    if (syncSelectedTerminalId && item.terminalId !== syncSelectedTerminalId) return false;
    if (trimmedSyncEnrollmentId && item.userEnrollmentId !== trimmedSyncEnrollmentId) return false;
    if (selectedSyncEmployee) {
      const activeMaps = (selectedSyncEmployee.biometricMappings || []).filter((m) => m.isActive);
      const matchesExplicitMapping = activeMaps.some(
        (m) => m.terminalId === item.terminalId && m.enrollmentId === item.userEnrollmentId
      );
      const matchesLegacy =
        activeMaps.length === 0 &&
        Boolean(selectedSyncEmployee.biometricDeviceId) &&
        selectedSyncEmployee.biometricDeviceId === item.userEnrollmentId;
      const matchesEmployeeId = item.matchedEmployeeId === selectedSyncEmployee.id;
      if (!matchesExplicitMapping && !matchesLegacy && !matchesEmployeeId) return false;
    }
    return true;
  });

  const enrollmentSuggestions = Array.from(
    new Set([
      ...pendingPunchOptions.map((p) => p.userEnrollmentId),
      ...selectedTerminalDeviceUsers.map((u) => u.enrollmentId),
      ...reconcileEmployees.flatMap((emp) => [
        ...(emp.biometricMappings || []).filter((m) => m.isActive).map((m) => m.enrollmentId),
        ...(emp.biometricDeviceId ? [emp.biometricDeviceId] : []),
      ]),
    ].filter(Boolean))
  ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const selectedPunchOption =
    pendingPunchOptions.find((p) => p.id === syncSelectedPunchId) ||
    punches.find((p) => p.id === syncSelectedPunchId) ||
    null;

  const hasHistoricalCutoff = Boolean(syncFromPunchTime.trim());
  let resolvedHistoricalCutoffPreview: string | null = null;
  if (hasHistoricalCutoff) {
    try {
      resolvedHistoricalCutoffPreview =
        parseLocalHistoricalCutoffInput(syncFromPunchTime, timezone) || null;
    } catch {
      resolvedHistoricalCutoffPreview = null;
    }
  }

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

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={() => setShowBridgeGuide((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition cursor-pointer whitespace-nowrap shrink-0 ${
              showBridgeGuide
                ? 'bg-indigo-950/90 text-indigo-200 border-indigo-700/70'
                : 'bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 border-slate-700/60'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5 text-indigo-400" />
            <span>eSSL X2008 Setup Guide</span>
          </button>

          <button
            onClick={() => {
              loadTerminals();
              loadSyncSummary();
              if (selectedUserSyncTerminalId) loadSelectedTerminalDeviceUsers(selectedUserSyncTerminalId);
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
              setIsConfirmingHistoricalSync(false);
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
            {
              terminals.filter(
                (t) =>
                  (t.deviceConnectionStatus || (t.status === 'ONLINE' ? 'CONNECTED' : 'DISCONNECTED')) ===
                  'CONNECTED'
              ).length
            }{' '}
            connected ·{' '}
            {
              terminals.filter(
                (t) =>
                  t.isActive &&
                  t.status !== 'DEACTIVATED' &&
                  (t.deviceConnectionStatus || (t.status === 'ONLINE' ? 'CONNECTED' : 'DISCONNECTED')) !==
                    'CONNECTED'
              ).length
            }{' '}
            disconnected
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

      {/* Historical Cutoff Policy Notice */}
      <BiometricHistoricalCutoffNotice timezone={timezone} />

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
          {showBridgeGuide && (
            <div className="p-5 bg-slate-900/70 border border-slate-800 rounded-xl space-y-4">
              <div className="flex items-start justify-between gap-4 pb-3 border-b border-slate-800">
                <div className="flex items-center gap-2.5">
                  <Terminal className="w-4 h-4 text-indigo-400 shrink-0" />
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      eSSL X2008 Windows LAN Bridge Deployment Guide
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Platform <span className="font-mono text-slate-300">ZLM60_TFT</span> · Algorithm{' '}
                      <span className="font-mono text-slate-300">VX10.0</span> · Read-only TCP{' '}
                      <span className="font-mono text-slate-300">4370</span> polling (never deletes device logs)
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowBridgeGuide(false)}
                  className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
                >
                  Close
                </button>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-xs text-slate-300">
                <div className="space-y-1.5">
                  <div className="font-semibold text-slate-100">1. Register Terminal &amp; Save One-Time Key</div>
                  <p className="text-slate-400 leading-relaxed">
                    Register the X2008 serial number (e.g. <code className="font-mono text-indigo-300">NFZ8252800275</code>) and LAN endpoint{' '}
                    <code className="font-mono text-indigo-300">192.168.1.201:4370</code>. Copy the <code className="font-mono text-indigo-300">bio_live_...</code> key once—CoreERP stores only its SHA-256 hash.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="font-semibold text-slate-100">2. Configure Windows Bridge PC (192.168.1.16)</div>
                  <p className="text-slate-400 leading-relaxed">
                    On the Windows host inside <code className="font-mono text-slate-300">bridges/essl-x2008-bridge</code>, run{' '}
                    <code className="font-mono text-indigo-300">npm run build</code>, configure <code className="font-mono text-slate-300">bridge.config.json</code> with timezone{' '}
                    <code className="font-mono text-slate-300">{timezone}</code>, and encrypt the API key using Windows DPAPI (<code className="font-mono text-slate-300">scripts/protect-credentials.ps1</code>).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="font-semibold text-slate-100">3. Verify &amp; Enable Windows Auto-Start</div>
                  <p className="text-slate-400 leading-relaxed">
                    Run <code className="font-mono text-indigo-300">npm run test-connection</code> to verify TCP 4370 handshake + serial match, then register continuous user-logon auto-start (preserving DPAPI <code className="font-mono text-slate-300">CurrentUser</code>) with{' '}
                    <code className="font-mono text-slate-300">scripts/install-task-scheduler.ps1</code>. Local diagnostics run on <code className="font-mono text-slate-300">127.0.0.1:4379/health</code>.
                  </p>
                </div>
              </div>
            </div>
          )}

          {terminals.length > 0 && (
            <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
                <div className="flex items-start gap-2.5">
                  <Users className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      Hardware User Synchronization
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Reads enrolled employee IDs, names, UIDs, and card numbers directly from hardware without triggering attendance punch reconciliation.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <select
                    value={selectedUserSyncTerminalId}
                    onChange={(e) => setSelectedUserSyncTerminalId(e.target.value)}
                    aria-label="Select terminal for hardware user synchronization"
                    className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
                  >
                    {terminals.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.deviceSerialNumber})
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    disabled={
                      !selectedUserSyncTerminal ||
                      !selectedUserSyncTerminal.isActive ||
                      syncingUsersTerminalId === selectedUserSyncTerminal?.id ||
                      selectedUserSyncTerminal.userSyncStatus === 'QUEUED' ||
                      selectedUserSyncTerminal.userSyncStatus === 'RUNNING'
                    }
                    onClick={() =>
                      selectedUserSyncTerminal && handleSyncDeviceUsers(selectedUserSyncTerminal)
                    }
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg transition cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${
                        syncingUsersTerminalId === selectedUserSyncTerminal?.id ||
                        selectedUserSyncTerminal?.userSyncStatus === 'QUEUED' ||
                        selectedUserSyncTerminal?.userSyncStatus === 'RUNNING'
                          ? 'animate-spin'
                          : ''
                      }`}
                    />
                    <span>
                      {syncingUsersTerminalId === selectedUserSyncTerminal?.id
                        ? 'Queueing User Sync...'
                        : selectedUserSyncTerminal?.userSyncStatus === 'RUNNING'
                        ? 'Syncing Users...'
                        : selectedUserSyncTerminal?.userSyncStatus === 'QUEUED'
                        ? 'User Sync Queued...'
                        : 'Sync Device Users'}
                    </span>
                  </button>
                </div>
              </div>

              {selectedUserSyncTerminal && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 text-xs">
                    <div className="p-2.5 rounded-lg bg-slate-950/50 border border-slate-800/80">
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                        Selected terminal
                      </div>
                      <div className="text-slate-100 font-medium mt-1 truncate">
                        {selectedUserSyncTerminal.name}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 truncate">
                        {selectedUserSyncTerminal.terminalModel} · {selectedUserSyncTerminal.deviceSerialNumber}
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-slate-950/50 border border-slate-800/80">
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                        User Sync Job
                      </div>
                      <div
                        className={`font-mono font-semibold mt-1 ${
                          selectedUserSyncTerminal.userSyncStatus === 'SUCCESS'
                            ? 'text-emerald-400'
                            : selectedUserSyncTerminal.userSyncStatus === 'RUNNING' ||
                              selectedUserSyncTerminal.userSyncStatus === 'QUEUED'
                            ? 'text-indigo-300'
                            : selectedUserSyncTerminal.userSyncStatus === 'FAILED'
                            ? 'text-rose-400'
                            : 'text-slate-300'
                        }`}
                      >
                        {selectedUserSyncTerminal.userSyncStatus || 'IDLE'}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                        Bridge: {selectedUserSyncTerminal.bridgeStatus || (selectedUserSyncTerminal.bridgeConnected ? 'ONLINE' : 'OFFLINE')} · Device:{' '}
                        {selectedUserSyncTerminal.deviceConnectionStatus || (selectedUserSyncTerminal.status === 'ONLINE' ? 'CONNECTED' : 'DISCONNECTED')}
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-slate-950/50 border border-slate-800/80">
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                        Last user sync
                      </div>
                      <div
                        className="text-slate-200 font-mono tabular-nums mt-1"
                        title={
                          selectedUserSyncTerminal.lastUserSyncAt
                            ? `UTC: ${formatUtcTimestamp(selectedUserSyncTerminal.lastUserSyncAt)}`
                            : undefined
                        }
                      >
                        {selectedUserSyncTerminal.lastUserSyncAt
                          ? formatDateTimeInTimezone(selectedUserSyncTerminal.lastUserSyncAt, timezone, {
                              includeZoneAbbr: true,
                            })
                          : 'Never'}
                      </div>
                      {(selectedUserSyncTerminal.userSyncStatus === 'QUEUED' ||
                        selectedUserSyncTerminal.userSyncStatus === 'RUNNING') && (
                        <div className="text-[11px] text-indigo-300 mt-0.5 font-mono">
                          {selectedUserSyncTerminal.userSyncStatus === 'RUNNING'
                            ? 'Bridge reading hardware users...'
                            : 'Waiting for bridge pickup...'}
                        </div>
                      )}
                    </div>

                    <div className="p-2.5 rounded-lg bg-slate-950/50 border border-slate-800/80">
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                        Users discovered
                      </div>
                      <div className="text-base font-bold text-slate-100 font-mono tabular-nums mt-1">
                        {selectedUserSyncTerminal.discoveredUserCount ?? '—'}
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-slate-950/50 border border-slate-800/80">
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                        Users synchronized
                      </div>
                      <div className="text-base font-bold text-emerald-400 font-mono tabular-nums mt-1">
                        {selectedUserSyncTerminal.syncedUserCount ?? selectedTerminalDeviceUsers.length}
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-slate-950/50 border border-slate-800/80">
                      <div className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
                        Errors
                      </div>
                      <div
                        className={`text-[11px] font-mono mt-1 break-words ${
                          selectedUserSyncTerminal.lastUserSyncError
                            ? 'text-rose-300'
                            : 'text-slate-400'
                        }`}
                        title={selectedUserSyncTerminal.lastUserSyncError || undefined}
                      >
                        {selectedUserSyncTerminal.lastUserSyncError || 'None'}
                      </div>
                    </div>
                  </div>

                  {isLoadingDeviceUsers ? (
                    <div className="text-xs text-slate-400 font-mono">
                      Loading synchronized device users...
                    </div>
                  ) : selectedTerminalDeviceUsers.length > 0 ? (
                    <div className="border border-slate-800 rounded-lg overflow-hidden">
                      <div className="px-3 py-2 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between text-[11px] text-slate-400">
                        <span>Enrolled Hardware Users ({selectedTerminalDeviceUsers.length})</span>
                        <span className="font-mono tabular-nums">
                          Terminal: {selectedUserSyncTerminal.deviceSerialNumber}
                        </span>
                      </div>
                      <div className="max-h-40 overflow-y-auto divide-y divide-slate-800/70 bg-slate-950/40 text-xs">
                        {selectedTerminalDeviceUsers.map((u) => (
                          <div
                            key={`${u.terminalId}::${u.enrollmentId}`}
                            className="px-3 py-1.5 flex items-center justify-between gap-3"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <span className="font-mono tabular-nums font-semibold text-indigo-300 shrink-0">
                                ID {u.enrollmentId}
                              </span>
                              <span className="text-slate-200 truncate">
                                {u.name || 'Unnamed Device User'}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums text-slate-400 shrink-0">
                              {u.uid !== undefined && u.uid !== null && <span>UID {u.uid}</span>}
                              {u.cardNo && <span>Card {u.cardNo}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="text-[11px] text-slate-400">
                      {selectedUserSyncTerminal.lastUserSyncError
                        ? 'Hardware user sync encountered an error. Check bridge connectivity and retry Sync Device Users.'
                        : selectedUserSyncTerminal.lastUserSyncAt
                        ? 'Hardware reported 0 enrolled users on the last sync.'
                        : 'No hardware users synchronized for this terminal yet. Click Sync Device Users to read enrolled users from hardware.'}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {isLoadingTerminals ? (
            <div className="py-12 flex justify-center">
              <LoadingSpinner message="Loading registered biometric terminals..." size="md" />
            </div>
          ) : terminalsError ? (
            <div className="p-4 bg-red-950/40 border border-red-800/60 rounded-xl text-center space-y-2">
              <div className="text-xs text-red-200">{terminalsError}</div>
              <button
                onClick={() => void loadTerminals()}
                className="px-3 py-1 bg-red-900/60 hover:bg-red-800 text-red-100 rounded-lg text-xs font-semibold"
              >
                Retry
              </button>
            </div>
          ) : terminals.length === 0 ? (
            <EmptyState
              icon={<Fingerprint className="w-8 h-8 text-indigo-400" />}
              title="No Biometric Terminals Registered"
              description="Register physical eSSL X2008 or compatible ZKTeco biometric terminals to enable LAN bridge polling and idempotent punch synchronization."
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
                      <th className="py-3 px-4">Terminal &amp; LAN Endpoint</th>
                      <th className="py-3 px-4">Serial &amp; Key</th>
                      <th className="py-3 px-4">Device &amp; Bridge State</th>
                      <th className="py-3 px-4">Last Heartbeat</th>
                      <th className="py-3 px-4">Last Sync &amp; Punches</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-xs">
                    {terminals.map((terminal) => {
                      const isDeactivated = terminal.status === 'DEACTIVATED' || !terminal.isActive;
                      const bridgeStatus = terminal.bridgeStatus || (terminal.bridgeConnected ? 'ONLINE' : 'OFFLINE');
                      const isBridgeOnline = bridgeStatus === 'ONLINE';
                      const deviceConnectionStatus =
                        terminal.deviceConnectionStatus ||
                        (isDeactivated
                          ? 'DEACTIVATED'
                          : terminal.status === 'ONLINE'
                          ? 'CONNECTED'
                          : 'DISCONNECTED');
                      const isDeviceConnected = deviceConnectionStatus === 'CONNECTED';
                      const userSyncStatus = terminal.userSyncStatus || 'IDLE';
                      const isUserSyncActive =
                        userSyncStatus === 'QUEUED' || userSyncStatus === 'RUNNING';
                      const isTesting = testingTerminalId === terminal.id;
                      const isSyncing = syncingTerminalId === terminal.id;

                      return (
                        <tr key={terminal.id} className="hover:bg-slate-800/30 transition-colors align-top">
                          <td className="py-3.5 px-4">
                            <div className="flex items-center gap-2 font-medium text-slate-100">
                              <Server className="w-4 h-4 text-indigo-400 shrink-0" />
                              <span>{terminal.name}</span>
                            </div>
                            <div className="text-[11px] font-mono text-slate-400 mt-1">
                              {terminal.terminalModel}
                              {terminal.platform ? ` · ${terminal.platform}` : ''} ·{' '}
                              {terminal.ipAddress ? `${terminal.ipAddress}:${terminal.port}` : 'Static IP unset'}
                            </div>
                            {terminal.location && (
                              <div className="text-[11px] text-slate-400 mt-0.5">{terminal.location}</div>
                            )}
                            {terminal.lastConnectionError && (
                              <div
                                className="mt-1.5 text-[11px] font-mono text-rose-300 flex items-start gap-1 max-w-sm"
                                title={terminal.lastConnectionError}
                              >
                                <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                                <span className="line-clamp-2">{terminal.lastConnectionError}</span>
                              </div>
                            )}
                          </td>

                          <td className="py-3.5 px-4 font-mono tabular-nums text-slate-300">
                            <div>{terminal.deviceSerialNumber}</div>
                            <div className="text-[11px] text-slate-400 mt-1">
                              <code>{terminal.apiKeyPrefix}...</code>
                            </div>
                            {terminal.firmwareVersion && (
                              <div className="text-[11px] text-slate-500 mt-0.5">FW {terminal.firmwareVersion}</div>
                            )}
                          </td>

                          <td className="py-3.5 px-4">
                            <div className="space-y-1.5">
                              <div
                                className={`flex items-center gap-1.5 font-mono text-[11px] font-semibold ${
                                  isBridgeOnline ? 'text-emerald-400' : 'text-amber-400'
                                }`}
                              >
                                {isBridgeOnline ? (
                                  <Wifi className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                ) : (
                                  <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                )}
                                <span>
                                  Bridge: {bridgeStatus}
                                  {isBridgeOnline && terminal.bridgeHost ? ` (${terminal.bridgeHost})` : ''}
                                </span>
                              </div>

                              <div
                                className={`inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold ${
                                  isDeviceConnected
                                    ? 'text-emerald-300'
                                    : isDeactivated
                                    ? 'text-slate-400'
                                    : terminal.status === 'ERROR'
                                    ? 'text-rose-400'
                                    : 'text-amber-300'
                                }`}
                              >
                                {isDeviceConnected && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                                {!isDeviceConnected && !isDeactivated && terminal.status !== 'ERROR' && (
                                  <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                                )}
                                {isDeactivated && <XCircle className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                                {!isDeviceConnected && !isDeactivated && terminal.status === 'ERROR' && (
                                  <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                                )}
                                <span>Device: {deviceConnectionStatus}</span>
                              </div>

                              <div
                                className={`text-[11px] font-mono ${
                                  userSyncStatus === 'SUCCESS'
                                    ? 'text-emerald-300'
                                    : isUserSyncActive
                                    ? 'text-indigo-300'
                                    : userSyncStatus === 'FAILED'
                                    ? 'text-rose-300'
                                    : 'text-slate-400'
                                }`}
                              >
                                User Sync: {userSyncStatus}
                              </div>

                              {terminal.lastTestConnectionStatus && (
                                <div
                                  className="text-[11px] text-slate-400 font-mono"
                                  title={terminal.lastTestConnectionMessage || undefined}
                                >
                                  Probe: {terminal.lastTestConnectionStatus}
                                </div>
                              )}
                            </div>
                          </td>

                          <td
                            className="py-3.5 px-4 text-slate-300 font-mono tabular-nums whitespace-nowrap"
                            title={
                              terminal.lastHeartbeatAt
                                ? `UTC: ${formatUtcTimestamp(terminal.lastHeartbeatAt)}`
                                : undefined
                            }
                          >
                            <div>
                              {terminal.lastHeartbeatAt
                                ? formatDateTimeInTimezone(terminal.lastHeartbeatAt, timezone, {
                                    includeZoneAbbr: true,
                                  })
                                : 'Never'}
                            </div>
                            {terminal.lastDeviceContactAt && (
                              <div
                                className="text-[11px] text-slate-400 mt-1"
                                title={`Last physical device contact UTC: ${formatUtcTimestamp(terminal.lastDeviceContactAt)}`}
                              >
                                Device:{' '}
                                {formatDateTimeInTimezone(terminal.lastDeviceContactAt, timezone, {
                                  includeZoneAbbr: true,
                                })}
                              </div>
                            )}
                            {terminal.bridgeVersion && (
                              <div className="text-[11px] text-slate-500 mt-1">
                                Bridge v{terminal.bridgeVersion}
                              </div>
                            )}
                          </td>

                          <td
                            className="py-3.5 px-4 text-slate-300 font-mono tabular-nums whitespace-nowrap"
                            title={terminal.lastSyncAt ? `UTC: ${formatUtcTimestamp(terminal.lastSyncAt)}` : undefined}
                          >
                            <div>
                              Punch Sync:{' '}
                              {terminal.lastSyncAt
                                ? formatDateTimeInTimezone(terminal.lastSyncAt, timezone, { includeZoneAbbr: true })
                                : 'Never'}
                            </div>
                            <div className="text-[11px] text-slate-400 mt-1">
                              User Sync:{' '}
                              {terminal.lastUserSyncAt
                                ? formatDateTimeInTimezone(terminal.lastUserSyncAt, timezone, {
                                    includeZoneAbbr: true,
                                  })
                                : 'Never'}
                            </div>
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              Last batch: {terminal.lastProcessedPunchCount ?? 0} punches
                            </div>
                            {terminal.syncRequestedAt && (
                              <div className="text-[11px] text-indigo-300 mt-0.5">Bridge poll queued</div>
                            )}
                          </td>

                          <td className="py-3.5 px-4 text-right">
                            <div className="flex flex-wrap items-center justify-end gap-1.5">
                              {terminal.isActive ? (
                                <>
                                  <button
                                    onClick={() => handleTestConnection(terminal)}
                                    disabled={isTesting}
                                    title="Test connectivity and LAN Bridge heartbeat"
                                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-200 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-md transition cursor-pointer disabled:opacity-50"
                                  >
                                    <PlugZap className={`w-3 h-3 text-indigo-400 ${isTesting ? 'animate-spin' : ''}`} />
                                    <span>{isTesting ? 'Testing...' : 'Test'}</span>
                                  </button>
                                  <button
                                    onClick={() => handleSyncDeviceUsers(terminal)}
                                    disabled={syncingUsersTerminalId === terminal.id || isUserSyncActive}
                                    title="Queue hardware user synchronization only (does not reconcile attendance)"
                                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-indigo-200 hover:text-white bg-indigo-950/60 hover:bg-indigo-900/80 border border-indigo-800/60 rounded-md transition cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
                                  >
                                    <Users
                                      className={`w-3 h-3 text-indigo-400 ${
                                        syncingUsersTerminalId === terminal.id || isUserSyncActive
                                          ? 'animate-pulse'
                                          : ''
                                      }`}
                                    />
                                    <span>
                                      {syncingUsersTerminalId === terminal.id
                                        ? 'Queueing...'
                                        : userSyncStatus === 'RUNNING'
                                        ? 'Syncing...'
                                        : userSyncStatus === 'QUEUED'
                                        ? 'Queued...'
                                        : 'Sync Users'}
                                    </span>
                                  </button>
                                  <button
                                    onClick={() => handleSyncTerminal(terminal)}
                                    disabled={isSyncing}
                                    title="Queue bridge poll & reconcile pending punches"
                                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-emerald-300 hover:text-emerald-100 bg-emerald-950/60 hover:bg-emerald-900/80 border border-emerald-800/60 rounded-md transition cursor-pointer disabled:opacity-50"
                                  >
                                    {isSyncing ? (
                                      <RefreshCw className="w-3 h-3 text-emerald-400 animate-spin" />
                                    ) : (
                                      <Play className="w-3 h-3 text-emerald-400" />
                                    )}
                                    <span>{isSyncing ? 'Syncing...' : 'Sync'}</span>
                                  </button>
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

            {/* Enrollment ID Filter */}
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={filterEnrollmentId}
                onChange={(e) => {
                  setFilterEnrollmentId(e.target.value);
                  setPunchPage(1);
                }}
                placeholder="Enrollment ID (e.g. 101)"
                className="w-40 bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-indigo-500"
              />
            </div>

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

            {(filterSyncStatus || filterTerminalId || filterEnrollmentId || filterStartDate || filterEndDate) && (
              <button
                onClick={() => {
                  setFilterSyncStatus('');
                  setFilterTerminalId('');
                  setFilterEnrollmentId('');
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
                      <th className="py-3 px-4 text-right">Action</th>
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
                          <td
                            className="py-3 px-4 font-mono tabular-nums text-slate-200 whitespace-nowrap"
                            title={`UTC: ${formatUtcTimestamp(p.punchTime)}`}
                          >
                            {formatDateTimeInTimezone(p.punchTime, timezone, { includeSeconds: true, includeZoneAbbr: true })}
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
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            {(isPending || isError) ? (
                              <button
                                type="button"
                                onClick={() => handleOpenTargetedPunchReconcile(p)}
                                title={`Reconcile only raw punch ${p.id} (Enrollment ${p.userEnrollmentId})`}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-indigo-200 hover:text-white bg-indigo-950/70 hover:bg-indigo-800/80 border border-indigo-700/60 rounded-md transition cursor-pointer"
                              >
                                <Play className="w-3 h-3 text-indigo-400" />
                                <span>Reconcile</span>
                              </button>
                            ) : (
                              <span className="text-[11px] text-slate-600">—</span>
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
              <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-indigo-400" />
                  <h3 className="text-sm font-semibold text-slate-100">Manual Punch Reconciliation Action</h3>
                </div>
                {isTargetedReconciliation && (
                  <button
                    type="button"
                    onClick={clearSyncFilters}
                    className="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium cursor-pointer"
                  >
                    Reset Filters
                  </button>
                )}
              </div>

              <p className="text-xs text-slate-400 leading-relaxed">
                Triggers the bounded CoreERP reconciliation engine to match pending raw biometric punches against active
                employee shifts, assign work dates, and record verified attendance logs idempotently.
              </p>

              <BiometricHistoricalCutoffNotice timezone={timezone} compact />

              <datalist id="reconcile-enrollment-suggestions">
                {enrollmentSuggestions.map((eid) => (
                  <option key={eid} value={eid} />
                ))}
              </datalist>

              {isTargetedReconciliation ? (
                <div className="p-3 bg-indigo-950/40 border border-indigo-700/60 rounded-lg text-[11px] text-indigo-200 space-y-1">
                  <div className="font-semibold text-indigo-100">Targeted Reconciliation Mode Active</div>
                  <div>
                    Only pending punches matching your selected criteria will be evaluated — other pending employees
                    and enrollment IDs will remain untouched.
                    {selectedPunchOption && (
                      <span className="block font-mono text-indigo-300 mt-1">
                        Target RawPunchLog: {selectedPunchOption.id} (Enroll {selectedPunchOption.userEnrollmentId})
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-2.5 bg-slate-800/40 border border-slate-700/60 rounded-lg text-[11px] text-slate-400">
                  {hasHistoricalCutoff
                    ? `Historical reconciliation cutoff set: processes up to ${syncBatchSize} pending company punches from the chosen date/time onward after confirmation.`
                    : `Default today-only batch mode: processes up to ${syncBatchSize} pending company punches from the start of today (${timezone}) when no targeted filter or historical cutoff is selected.`}
                </div>
              )}

              <div className="space-y-3 pt-1">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-slate-300">
                      Specific Pending Raw Punch (Optional)
                    </label>
                    <button
                      type="button"
                      onClick={() => loadReconciliationTargets(syncRetryErrors)}
                      disabled={isLoadingPendingPunchOptions}
                      className="text-[11px] text-indigo-400 hover:text-indigo-300 cursor-pointer disabled:opacity-50"
                    >
                      {isLoadingPendingPunchOptions ? 'Refreshing...' : 'Refresh List'}
                    </button>
                  </div>
                  <select
                    value={syncSelectedPunchId}
                    onChange={(e) => setSyncSelectedPunchId(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">All Matching Pending Punches (Use Filters / Batch)</option>
                    {filteredPendingPunchOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {formatDateTimeInTimezone(p.punchTime, timezone, { includeSeconds: true })} · Enroll {p.userEnrollmentId} · {p.inOutMode} · {p.terminalName || p.terminalId} [{p.syncStatus}] ({p.id.slice(0, 8)})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Enrollment ID Filter (Optional)
                    </label>
                    <input
                      type="text"
                      list="reconcile-enrollment-suggestions"
                      value={syncEnrollmentId}
                      onChange={(e) => setSyncEnrollmentId(e.target.value)}
                      placeholder="e.g. 101"
                      className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Employee Filter (Optional)
                    </label>
                    <select
                      value={syncSelectedEmployeeId}
                      onChange={(e) => setSyncSelectedEmployeeId(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="">All Company Employees</option>
                      {reconcileEmployees.map((emp) => (
                        <option key={emp.id} value={emp.id}>
                          {emp.fullName} ({emp.employeeCode}) [{emp.status}]
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Batch Size (Records per execution)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      disabled={Boolean(syncSelectedPunchId)}
                      value={syncSelectedPunchId ? 1 : syncBatchSize}
                      onChange={(e) => setSyncBatchSize(parseInt(e.target.value, 10) || 100)}
                      className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 font-mono tabular-nums focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                    />
                    <span className="text-[11px] text-slate-400 mt-0.5 block">
                      {syncSelectedPunchId
                        ? 'Locked to 1 record for specific punch ID.'
                        : 'Bounded execution cap: 1 to 500 records.'}
                    </span>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label
                      htmlFor="sync-tab-from-punch-time"
                      className="block text-xs font-medium text-slate-300"
                    >
                      From Punch Date/Time (Optional — Historical Cutoff)
                    </label>
                    {hasHistoricalCutoff && (
                      <button
                        type="button"
                        onClick={() => {
                          setSyncFromPunchTime('');
                          setIsConfirmingHistoricalSync(false);
                        }}
                        className="text-[11px] text-amber-300 hover:text-amber-200 cursor-pointer"
                      >
                        Clear Cutoff
                      </button>
                    )}
                  </div>
                  <input
                    id="sync-tab-from-punch-time"
                    type="datetime-local"
                    value={syncFromPunchTime}
                    onChange={(e) => {
                      setSyncFromPunchTime(e.target.value);
                      setIsConfirmingHistoricalSync(false);
                    }}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-3 py-2 focus:outline-none focus:border-amber-500"
                  />
                  <span className="text-[11px] text-slate-400 mt-0.5 block">
                    Leave blank for normal today-only sync (start of current day in{' '}
                    <span className="font-mono text-slate-300">{timezone}</span>). Set only to
                    intentionally reconcile historical PENDING punches.
                  </span>
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

                {isConfirmingHistoricalSync && resolvedHistoricalCutoffPreview ? (
                  <BiometricHistoricalConfirmationBanner
                    fromPunchDateTime={syncFromPunchTime}
                    resolvedCutoffIso={resolvedHistoricalCutoffPreview}
                    timezone={timezone}
                    isSubmitting={isTriggeringSync}
                    onCancel={() => setIsConfirmingHistoricalSync(false)}
                    onConfirm={executeTriggerSync}
                  />
                ) : (
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
                          <span>
                            {syncSelectedPunchId
                              ? 'Reconcile Selected Punch'
                              : hasHistoricalCutoff
                              ? 'Review & Run Historical Reconciliation'
                              : isTargetedReconciliation
                              ? 'Run Targeted Reconciliation'
                              : 'Run Reconciliation Engine'}
                          </span>
                        </>
                      )}
                    </button>
                  </div>
                )}
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

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                    <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/60">
                      <div className="text-[11px] text-slate-400 uppercase">Processed</div>
                      <div className="text-lg font-bold text-emerald-400 font-mono tabular-nums mt-0.5">
                        {syncOutcome.processed}
                      </div>
                    </div>
                    <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/60">
                      <div className="text-[11px] text-slate-400 uppercase">Pending</div>
                      <div className="text-lg font-bold text-amber-400 font-mono tabular-nums mt-0.5">
                        {syncOutcome.pending ?? 0}
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
                      <strong className="text-slate-100">Historical Pending Punch Protection:</strong> Normal
                      biometric sync processes only punches from the start of the current company-local day
                      ({timezone}). Historical PENDING punches are never processed automatically unless an
                      administrator explicitly provides and confirms a From Punch Date/Time cutoff.
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
                    Hardware Profile Preset
                  </label>
                  <select
                    value={formPresetId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setFormPresetId(nextId);
                      const preset = BIOMETRIC_MODEL_PRESETS.find((p) => p.id === nextId);
                      if (preset) {
                        setFormTerminalModel(preset.terminalModel);
                        setFormPort(preset.defaultPort);
                      }
                    }}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                  >
                    {BIOMETRIC_MODEL_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  <div className="text-[11px] text-slate-400 mt-1">
                    {BIOMETRIC_MODEL_PRESETS.find((p) => p.id === formPresetId)?.notes}
                  </div>
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Terminal Display Name <span className="text-rose-400">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Main Office eSSL X2008"
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
                    placeholder="e.g. NFZ8252800275"
                    value={formSerialNumber}
                    onChange={(e) => setFormSerialNumber(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 font-mono focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Terminal Model Code
                  </label>
                  <input
                    type="text"
                    placeholder="eSSL-X2008"
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
                    TCP Port
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
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
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-indigo-400" />
                <h3 className="text-sm font-bold text-slate-100">Manual Punch Reconciliation</h3>
              </div>
              <button
                onClick={() => {
                  setIsConfirmingHistoricalSync(false);
                  setIsSyncModalOpen(false);
                }}
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

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                  <div className="p-2.5 bg-slate-800/60 rounded-lg">
                    <div className="text-[10px] text-slate-400 uppercase">Processed</div>
                    <div className="text-base font-bold text-emerald-400 font-mono tabular-nums">
                      {syncOutcome.processed}
                    </div>
                  </div>
                  <div className="p-2.5 bg-slate-800/60 rounded-lg">
                    <div className="text-[10px] text-slate-400 uppercase">Pending</div>
                    <div className="text-base font-bold text-amber-400 font-mono tabular-nums">
                      {syncOutcome.pending ?? 0}
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

                {syncOutcome.results.length > 0 && (
                  <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                    {syncOutcome.results.slice(0, 5).map((r) => (
                      <div
                        key={r.punchId}
                        className="p-2 bg-slate-800/40 rounded border border-slate-700/40 text-[11px] flex items-center justify-between gap-2"
                      >
                        <span className="font-mono text-slate-300 truncate">
                          Enroll {r.userEnrollmentId} · {r.workDate || 'Unassigned'} · {r.punchId.slice(0, 8)}
                        </span>
                        <span
                          className={`font-mono font-semibold shrink-0 ${
                            r.status === 'PROCESSED'
                              ? 'text-emerald-400'
                              : r.status === 'IGNORED'
                              ? 'text-slate-400'
                              : r.status === 'PENDING'
                              ? 'text-amber-400'
                              : 'text-rose-400'
                          }`}
                        >
                          {r.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSyncOutcome(null)}
                    className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium cursor-pointer"
                  >
                    Reconcile Another
                  </button>
                  <button
                    onClick={() => setIsSyncModalOpen(false)}
                    className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold cursor-pointer"
                  >
                    Close &amp; View Punch Logs
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Reconcile pending punches with shift schedules. Select targeted filters to isolate one punch, enrollment ID, or employee without affecting other pending logs.
                  </p>
                </div>

                <BiometricHistoricalCutoffNotice timezone={timezone} compact />

                <datalist id="modal-reconcile-enrollment-suggestions">
                  {enrollmentSuggestions.map((eid) => (
                    <option key={eid} value={eid} />
                  ))}
                </datalist>

                {isTargetedReconciliation && (
                  <div className="p-2.5 bg-indigo-950/40 border border-indigo-700/60 rounded-lg text-[11px] text-indigo-200 flex items-start justify-between gap-2">
                    <div>
                      <span className="font-semibold text-indigo-100 block">Targeted Scope Active</span>
                      <span>
                        {selectedPunchOption
                          ? `Only RawPunchLog ${selectedPunchOption.id.slice(0, 12)} (Enroll ${selectedPunchOption.userEnrollmentId}) will run.`
                          : 'Only pending records matching your selected filters will be evaluated.'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={clearSyncFilters}
                      className="text-indigo-300 hover:text-white underline shrink-0 cursor-pointer"
                    >
                      Clear
                    </button>
                  </div>
                )}

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Specific Pending Raw Punch (Optional)
                    </label>
                    <select
                      value={syncSelectedPunchId}
                      onChange={(e) => setSyncSelectedPunchId(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="">All Matching Pending Punches</option>
                      {filteredPendingPunchOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {formatDateTimeInTimezone(p.punchTime, timezone, { includeSeconds: true })} · Enroll {p.userEnrollmentId} · {p.inOutMode} · {p.terminalName || p.terminalId} [{p.syncStatus}] ({p.id.slice(0, 8)})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Enrollment ID Filter (Optional)
                      </label>
                      <input
                        type="text"
                        list="modal-reconcile-enrollment-suggestions"
                        value={syncEnrollmentId}
                        onChange={(e) => setSyncEnrollmentId(e.target.value)}
                        placeholder="e.g. 101"
                        className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-300 mb-1">
                        Employee Filter (Optional)
                      </label>
                      <select
                        value={syncSelectedEmployeeId}
                        onChange={(e) => setSyncSelectedEmployeeId(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                      >
                        <option value="">All Company Employees</option>
                        {reconcileEmployees.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.fullName} ({emp.employeeCode}) [{emp.status}]
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                      <label className="block text-xs font-medium text-slate-300 mb-1">Batch Size</label>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        disabled={Boolean(syncSelectedPunchId)}
                        value={syncSelectedPunchId ? 1 : syncBatchSize}
                        onChange={(e) => setSyncBatchSize(parseInt(e.target.value, 10) || 100)}
                        className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 font-mono tabular-nums focus:outline-none focus:border-indigo-500 disabled:opacity-60"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label
                        htmlFor="sync-modal-from-punch-time"
                        className="block text-xs font-medium text-slate-300"
                      >
                        From Punch Date/Time (Optional — Historical Cutoff)
                      </label>
                      {hasHistoricalCutoff && (
                        <button
                          type="button"
                          onClick={() => {
                            setSyncFromPunchTime('');
                            setIsConfirmingHistoricalSync(false);
                          }}
                          className="text-[11px] text-amber-300 hover:text-amber-200 cursor-pointer"
                        >
                          Clear Cutoff
                        </button>
                      )}
                    </div>
                    <input
                      id="sync-modal-from-punch-time"
                      type="datetime-local"
                      value={syncFromPunchTime}
                      onChange={(e) => {
                        setSyncFromPunchTime(e.target.value);
                        setIsConfirmingHistoricalSync(false);
                      }}
                      className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-3 py-2 focus:outline-none focus:border-amber-500"
                    />
                    <span className="text-[11px] text-slate-400 mt-0.5 block">
                      Leave blank for normal today-only sync (start of current day in{' '}
                      <span className="font-mono text-slate-300">{timezone}</span>). Enter a
                      date/time only to intentionally reconcile historical PENDING punches.
                    </span>
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

                {isConfirmingHistoricalSync && resolvedHistoricalCutoffPreview ? (
                  <BiometricHistoricalConfirmationBanner
                    fromPunchDateTime={syncFromPunchTime}
                    resolvedCutoffIso={resolvedHistoricalCutoffPreview}
                    timezone={timezone}
                    isSubmitting={isTriggeringSync}
                    onCancel={() => setIsConfirmingHistoricalSync(false)}
                    onConfirm={executeTriggerSync}
                  />
                ) : (
                  <div className="pt-2 flex items-center justify-end gap-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        setIsConfirmingHistoricalSync(false);
                        setIsSyncModalOpen(false);
                      }}
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
                          <span>
                            {syncSelectedPunchId
                              ? 'Reconcile Selected Punch'
                              : hasHistoricalCutoff
                              ? 'Review Historical Sync'
                              : isTargetedReconciliation
                              ? 'Run Targeted Sync'
                              : 'Run Sync'}
                          </span>
                        </>
                      )}
                    </button>
                  </div>
                )}
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
