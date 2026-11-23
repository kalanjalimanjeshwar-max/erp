import fs from 'fs';
import path from 'path';
import {
  BridgeCheckpointFile,
  CheckpointHealthState,
  CheckpointSafetyErrorCode,
  DeviceEnrolledUser,
  NormalizedPunchEvent,
  TerminalCheckpoint,
} from './types.js';

const MAX_RECENT_IDS = 5000;
const DEFAULT_WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

export class CheckpointSafetyError extends Error {
  readonly code: CheckpointSafetyErrorCode;
  readonly terminalKey?: string;
  readonly filePath: string;
  readonly corruptBackupPath: string | null;

  constructor(
    code: CheckpointSafetyErrorCode,
    message: string,
    options: {
      terminalKey?: string;
      filePath: string;
      corruptBackupPath?: string | null;
    }
  ) {
    super(message);
    this.name = 'CheckpointSafetyError';
    this.code = code;
    this.terminalKey = options.terminalKey;
    this.filePath = options.filePath;
    this.corruptBackupPath = options.corruptBackupPath ?? null;
  }
}

export interface CheckpointHealthInfo {
  status: CheckpointHealthState;
  filePath: string;
  error: string | null;
  corruptBackupPath: string | null;
}

export interface FilterEligibleEventsResult {
  eligible: NormalizedPunchEvent[];
  filteredHistoricalCount: number;
  skippedDuplicateCount: number;
  skippedBeforeWatermarkCount: number;
  lateBeforeWatermarkSamples: Array<{ devicePunchId: string; punchTime: string }>;
}

/**
 * Deterministic chronological ordering for normalized punch events.
 * Primary key: punchTime UTC ascending; deterministic tie-breakers preserve unique device identity.
 */
export function compareNormalizedPunches(a: NormalizedPunchEvent, b: NormalizedPunchEvent): number {
  const msA = Date.parse(a.punchTime);
  const msB = Date.parse(b.punchTime);
  const validA = !Number.isNaN(msA);
  const validB = !Number.isNaN(msB);
  if (validA && validB && msA !== msB) return msA - msB;
  if (validA !== validB) return validA ? -1 : 1;

  if (a.devicePunchId !== b.devicePunchId) {
    return a.devicePunchId < b.devicePunchId ? -1 : 1;
  }
  if (a.userEnrollmentId !== b.userEnrollmentId) {
    return a.userEnrollmentId < b.userEnrollmentId ? -1 : 1;
  }
  if (a.inOutMode !== b.inOutMode) {
    return a.inOutMode < b.inOutMode ? -1 : 1;
  }
  if (a.verifyType !== b.verifyType) {
    return a.verifyType < b.verifyType ? -1 : 1;
  }
  return 0;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isValidIsoDateString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0 && !Number.isNaN(Date.parse(val));
}

function isValidNormalizedPunchEvent(val: unknown): val is NormalizedPunchEvent {
  if (!isPlainObject(val)) return false;
  return (
    typeof val.devicePunchId === 'string' &&
    val.devicePunchId.trim().length > 0 &&
    typeof val.userEnrollmentId === 'string' &&
    val.userEnrollmentId.trim().length > 0 &&
    isValidIsoDateString(val.punchTime) &&
    typeof val.verifyType === 'string' &&
    typeof val.inOutMode === 'string'
  );
}

function cloneTerminalCheckpoint(term: TerminalCheckpoint): TerminalCheckpoint {
  return {
    ...term,
    recentPunchIds: [...term.recentPunchIds],
    pendingQueue: term.pendingQueue.map((evt) => ({ ...evt })),
    deviceInfo: term.deviceInfo ? { ...term.deviceInfo } : null,
    pendingUserSync: term.pendingUserSync
      ? {
          discoveredAt: term.pendingUserSync.discoveredAt,
          users: term.pendingUserSync.users.map((u) => ({ ...u })),
        }
      : null,
  };
}

export class CheckpointStore {
  private readonly filePath: string;
  private state: BridgeCheckpointFile | null = null;
  private loadStatus: CheckpointHealthState = 'MISSING';
  private loadError: string | null = null;
  private corruptBackupPath: string | null = null;

  constructor(dataDir: string, fileName = 'checkpoints.json') {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, fileName);
    this.loadFromDisk();
  }

  getFilePath(): string {
    return this.filePath;
  }

  getHealth(): CheckpointHealthInfo {
    return {
      status: this.loadStatus,
      filePath: this.filePath,
      error: this.loadError,
      corruptBackupPath: this.corruptBackupPath,
    };
  }

  private preserveCorruptBackupOnce(): string | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const corruptBytes = fs.readFileSync(this.filePath);
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      const prefix = `${baseName}.corrupt.`;

      // Never delete or overwrite any existing corrupt backup; reuse if identical backup already exists
      const existingEntries = fs.readdirSync(dir);
      for (const name of existingEntries) {
        if (!name.startsWith(prefix)) continue;
        const candidate = path.join(dir, name);
        try {
          const existingBytes = fs.readFileSync(candidate);
          if (existingBytes.equals(corruptBytes)) {
            return candidate;
          }
        } catch {
          // Ignore unreadable sibling backup
        }
      }

      const ts = Date.now();
      for (let attempt = 0; attempt < 100; attempt++) {
        const suffix = attempt === 0 ? `${ts}` : `${ts}.${attempt}`;
        const backupPath = `${this.filePath}.corrupt.${suffix}`;
        try {
          fs.copyFileSync(this.filePath, backupPath, fs.constants.COPYFILE_EXCL);
          return backupPath;
        } catch (copyErr: unknown) {
          if ((copyErr as NodeJS.ErrnoException)?.code === 'EEXIST') {
            continue;
          }
          throw copyErr;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) {
      this.state = null;
      this.loadStatus = 'MISSING';
      this.corruptBackupPath = null;
      this.loadError =
        `Checkpoint file '${this.filePath}' is missing. Refusing normal punch sync to prevent historical import; initialize a safe checkpoint explicitly.`;
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (readErr: unknown) {
      this.state = null;
      this.loadStatus = 'CORRUPT';
      this.corruptBackupPath = this.preserveCorruptBackupOnce();
      this.loadError = `Failed to read checkpoint file '${this.filePath}': ${(readErr as Error)?.message || 'read error'}. Refusing punch sync.`;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr: unknown) {
      this.state = null;
      this.loadStatus = 'CORRUPT';
      this.corruptBackupPath = this.preserveCorruptBackupOnce();
      this.loadError =
        `Checkpoint file '${this.filePath}' contains malformed JSON (${(parseErr as Error)?.message || 'parse error'}). ` +
        `Preserved backup at '${this.corruptBackupPath || 'unavailable'}'. Refusing punch sync; will not reset checkpoint automatically.`;
      return;
    }

    if (!isPlainObject(parsed)) {
      this.state = null;
      this.loadStatus = 'INVALID_SCHEMA';
      this.corruptBackupPath = this.preserveCorruptBackupOnce();
      this.loadError =
        `Checkpoint file '${this.filePath}' has invalid root schema (expected JSON object). ` +
        `Preserved backup at '${this.corruptBackupPath || 'unavailable'}'. Refusing punch sync.`;
      return;
    }

    if (parsed.version !== 1) {
      this.state = null;
      this.loadStatus = 'INVALID_VERSION';
      this.corruptBackupPath = this.preserveCorruptBackupOnce();
      this.loadError =
        `Checkpoint file '${this.filePath}' has unsupported version '${String(parsed.version)}' (expected 1). ` +
        `Preserved backup at '${this.corruptBackupPath || 'unavailable'}'. Refusing punch sync.`;
      return;
    }

    if (!isPlainObject(parsed.terminals)) {
      this.state = null;
      this.loadStatus = 'INVALID_SCHEMA';
      this.corruptBackupPath = this.preserveCorruptBackupOnce();
      this.loadError =
        `Checkpoint file '${this.filePath}' has invalid 'terminals' map. ` +
        `Preserved backup at '${this.corruptBackupPath || 'unavailable'}'. Refusing punch sync.`;
      return;
    }

    this.state = parsed as unknown as BridgeCheckpointFile;
    this.loadStatus = 'VALID';
    this.loadError = null;
    this.corruptBackupPath = null;
  }

  /**
   * Non-mutating read-only lookup for status display and startup diagnostics.
   * Never creates files or modifies checkpoint state.
   */
  peekTerminal(terminalKey: string): TerminalCheckpoint | null {
    if (this.loadStatus !== 'VALID' || !this.state) return null;
    const raw = this.state.terminals[terminalKey];
    if (!isPlainObject(raw)) return null;
    const recentPunchIds = Array.isArray(raw.recentPunchIds)
      ? raw.recentPunchIds.filter((id): id is string => typeof id === 'string')
      : [];
    const pendingQueue = Array.isArray(raw.pendingQueue)
      ? raw.pendingQueue.filter(isValidNormalizedPunchEvent)
      : [];

    return {
      terminalKey: typeof raw.terminalKey === 'string' ? raw.terminalKey : terminalKey,
      serialNumber: typeof raw.serialNumber === 'string' ? raw.serialNumber : '',
      lastSyncedPunchTimeIso:
        typeof raw.lastSyncedPunchTimeIso === 'string' ? raw.lastSyncedPunchTimeIso : null,
      lastSyncedDevicePunchId:
        typeof raw.lastSyncedDevicePunchId === 'string' ? raw.lastSyncedDevicePunchId : null,
      recentPunchIds: [...recentPunchIds],
      pendingQueue: pendingQueue.map((e) => ({ ...e })),
      lastSuccessfulHeartbeatAt:
        typeof raw.lastSuccessfulHeartbeatAt === 'string' ? raw.lastSuccessfulHeartbeatAt : null,
      lastSuccessfulSyncAt:
        typeof raw.lastSuccessfulSyncAt === 'string' ? raw.lastSuccessfulSyncAt : null,
      lastSyncAttemptAt: typeof raw.lastSyncAttemptAt === 'string' ? raw.lastSyncAttemptAt : null,
      lastProcessedPunchCount:
        typeof raw.lastProcessedPunchCount === 'number' ? raw.lastProcessedPunchCount : 0,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
      deviceInfo: isPlainObject(raw.deviceInfo) ? ({ ...raw.deviceInfo } as TerminalCheckpoint['deviceInfo']) : null,
      lastSuccessfulUserSyncAt:
        typeof raw.lastSuccessfulUserSyncAt === 'string' ? raw.lastSuccessfulUserSyncAt : null,
      lastUserSyncAttemptAt:
        typeof raw.lastUserSyncAttemptAt === 'string' ? raw.lastUserSyncAttemptAt : null,
      lastUserSyncError: typeof raw.lastUserSyncError === 'string' ? raw.lastUserSyncError : null,
      discoveredUserCount:
        typeof raw.discoveredUserCount === 'number' ? raw.discoveredUserCount : null,
      syncedUserCount: typeof raw.syncedUserCount === 'number' ? raw.syncedUserCount : null,
      pendingUserSync:
        isPlainObject(raw.pendingUserSync) &&
        typeof raw.pendingUserSync.discoveredAt === 'string' &&
        Array.isArray(raw.pendingUserSync.users)
          ? {
              discoveredAt: raw.pendingUserSync.discoveredAt,
              users: raw.pendingUserSync.users
                .filter(isPlainObject)
                .map((u) => ({ ...(u as unknown as DeviceEnrolledUser) })),
            }
          : null,
    };
  }

  /**
   * Fail-closed validator required before ANY normal punch sync operation.
   * Verifies file integrity, schema version, terminal key binding, exact serialNumber match,
   * valid watermark timestamp, and structurally sound arrays.
   */
  validateTerminalForPunchSync(terminalKey: string, expectedSerialNumber: string): TerminalCheckpoint {
    const cleanKey = (terminalKey || '').trim();
    const cleanSerial = (expectedSerialNumber || '').trim();

    if (this.loadStatus !== 'VALID' || !this.state) {
      const codeMap: Record<Exclude<CheckpointHealthState, 'VALID'>, CheckpointSafetyErrorCode> = {
        MISSING: 'CHECKPOINT_MISSING',
        CORRUPT: 'CHECKPOINT_CORRUPT',
        INVALID_VERSION: 'CHECKPOINT_INVALID_VERSION',
        INVALID_SCHEMA: 'CHECKPOINT_INVALID_SCHEMA',
      };
      const code = this.loadStatus === 'VALID' ? 'CHECKPOINT_MISSING' : codeMap[this.loadStatus];
      throw new CheckpointSafetyError(
        code,
        this.loadError || `Checkpoint store '${this.filePath}' is not in a valid state (${this.loadStatus}).`,
        {
          terminalKey: cleanKey,
          filePath: this.filePath,
          corruptBackupPath: this.corruptBackupPath,
        }
      );
    }

    const existing = this.state.terminals[cleanKey];
    if (!existing) {
      // Detect if the configured hardware serial is already bound under a different terminal ID
      for (const [otherKey, otherEntry] of Object.entries(this.state.terminals)) {
        if (
          isPlainObject(otherEntry) &&
          typeof otherEntry.serialNumber === 'string' &&
          otherEntry.serialNumber.trim() === cleanSerial
        ) {
          throw new CheckpointSafetyError(
            'TERMINAL_ID_CHANGED',
            `Terminal identity mismatch: hardware serial '${cleanSerial}' is bound to checkpoint key '${otherKey}', not '${cleanKey}'. Refusing punch sync to prevent silent checkpoint reset.`,
            { terminalKey: cleanKey, filePath: this.filePath }
          );
        }
      }

      throw new CheckpointSafetyError(
        'TERMINAL_ENTRY_MISSING',
        `Checkpoint file '${this.filePath}' has no initialized entry for terminal '${cleanKey}' (serial '${cleanSerial}'). Refusing punch sync until explicitly initialized.`,
        { terminalKey: cleanKey, filePath: this.filePath }
      );
    }

    if (!isPlainObject(existing)) {
      throw new CheckpointSafetyError(
        'INVALID_TERMINAL_ENTRY',
        `Checkpoint entry for terminal '${cleanKey}' is malformed (not an object). Refusing punch sync.`,
        { terminalKey: cleanKey, filePath: this.filePath }
      );
    }

    if (typeof existing.terminalKey !== 'string' || existing.terminalKey.trim() !== cleanKey) {
      throw new CheckpointSafetyError(
        'INVALID_TERMINAL_ENTRY',
        `Checkpoint entry for terminal '${cleanKey}' has mismatched internal terminalKey '${String(existing.terminalKey)}'. Refusing punch sync.`,
        { terminalKey: cleanKey, filePath: this.filePath }
      );
    }

    if (typeof existing.serialNumber !== 'string' || !existing.serialNumber.trim()) {
      throw new CheckpointSafetyError(
        'INVALID_TERMINAL_ENTRY',
        `Checkpoint entry for terminal '${cleanKey}' is missing stored serialNumber. Refusing punch sync.`,
        { terminalKey: cleanKey, filePath: this.filePath }
      );
    }

    if (existing.serialNumber.trim() !== cleanSerial) {
      throw new CheckpointSafetyError(
        'TERMINAL_SERIAL_MISMATCH',
        `Checkpoint serial mismatch for terminal '${cleanKey}': stored '${existing.serialNumber.trim()}', configured '${cleanSerial}'. Refusing punch sync.`,
        { terminalKey: cleanKey, filePath: this.filePath }
      );
    }

    if (!isValidIsoDateString(existing.lastSyncedPunchTimeIso)) {
      throw new CheckpointSafetyError(
        'MISSING_WATERMARK',
        `Checkpoint entry for terminal '${cleanKey}' is missing a valid lastSyncedPunchTimeIso watermark. Refusing punch sync to prevent full historical import.`,
        { terminalKey: cleanKey, filePath: this.filePath }
      );
    }

    if (
      !Array.isArray(existing.recentPunchIds) ||
      !existing.recentPunchIds.every((id) => typeof id === 'string')
    ) {
      throw new CheckpointSafetyError(
        'INVALID_TERMINAL_ENTRY',
        `Checkpoint entry for terminal '${cleanKey}' has invalid recentPunchIds array. Refusing punch sync.`,
        { terminalKey: cleanKey, filePath: this.filePath }
      );
    }

    if (
      !Array.isArray(existing.pendingQueue) ||
      !existing.pendingQueue.every(isValidNormalizedPunchEvent)
    ) {
      throw new CheckpointSafetyError(
        'INVALID_TERMINAL_ENTRY',
        `Checkpoint entry for terminal '${cleanKey}' has invalid pendingQueue entries. Refusing punch sync.`,
        { terminalKey: cleanKey, filePath: this.filePath }
      );
    }

    existing.lastSuccessfulUserSyncAt = existing.lastSuccessfulUserSyncAt ?? null;
    existing.lastUserSyncAttemptAt = existing.lastUserSyncAttemptAt ?? null;
    existing.lastUserSyncError = existing.lastUserSyncError ?? null;
    existing.discoveredUserCount = existing.discoveredUserCount ?? null;
    existing.syncedUserCount = existing.syncedUserCount ?? null;
    existing.pendingUserSync = existing.pendingUserSync ?? null;

    return existing;
  }

  /**
   * Explicitly initializes a safe checkpoint watermark for a terminal as part of a reviewed setup procedure.
   * Refuses to overwrite a corrupt file, refuses serial/ID mismatches, and refuses to reset an already-valid watermark.
   */
  initializeSafeTerminalCheckpoint(options: {
    terminalKey: string;
    serialNumber: string;
    watermarkIso: string;
  }): TerminalCheckpoint {
    const cleanKey = (options.terminalKey || '').trim();
    const cleanSerial = (options.serialNumber || '').trim();

    if (!cleanKey || !cleanSerial) {
      throw new CheckpointSafetyError(
        'INVALID_TERMINAL_ENTRY',
        'Both terminalKey and serialNumber are required to initialize a safe checkpoint.',
        { terminalKey: cleanKey, filePath: this.filePath }
      );
    }

    if (!isValidIsoDateString(options.watermarkIso)) {
      throw new CheckpointSafetyError(
        'MISSING_WATERMARK',
        `Invalid watermarkIso '${String(options.watermarkIso)}' provided for checkpoint initialization.`,
        { terminalKey: cleanKey, filePath: this.filePath }
      );
    }

    if (
      this.loadStatus === 'CORRUPT' ||
      this.loadStatus === 'INVALID_VERSION' ||
      this.loadStatus === 'INVALID_SCHEMA'
    ) {
      throw new CheckpointSafetyError(
        this.loadStatus === 'CORRUPT'
          ? 'CHECKPOINT_CORRUPT'
          : this.loadStatus === 'INVALID_VERSION'
          ? 'CHECKPOINT_INVALID_VERSION'
          : 'CHECKPOINT_INVALID_SCHEMA',
        `Refusing to initialize over existing invalid checkpoint file '${this.filePath}' (${this.loadStatus}). Inspect and resolve the corrupt file first.`,
        {
          terminalKey: cleanKey,
          filePath: this.filePath,
          corruptBackupPath: this.corruptBackupPath,
        }
      );
    }

    if (!this.state) {
      this.state = {
        version: 1,
        updatedAt: new Date().toISOString(),
        terminals: {},
      };
      this.loadStatus = 'VALID';
      this.loadError = null;
    }

    const existing = this.state.terminals[cleanKey];
    if (existing) {
      if (existing.serialNumber?.trim() !== cleanSerial) {
        throw new CheckpointSafetyError(
          'TERMINAL_SERIAL_MISMATCH',
          `Refusing to overwrite checkpoint for '${cleanKey}': stored serial '${existing.serialNumber}' does not match '${cleanSerial}'.`,
          { terminalKey: cleanKey, filePath: this.filePath }
        );
      }
      if (isValidIsoDateString(existing.lastSyncedPunchTimeIso)) {
        throw new CheckpointSafetyError(
          'INVALID_TERMINAL_ENTRY',
          `Refusing to reset already-valid checkpoint for terminal '${cleanKey}' (existing watermark '${existing.lastSyncedPunchTimeIso}').`,
          { terminalKey: cleanKey, filePath: this.filePath }
        );
      }
    }

    for (const [otherKey, otherEntry] of Object.entries(this.state.terminals)) {
      if (
        otherKey !== cleanKey &&
        isPlainObject(otherEntry) &&
        typeof otherEntry.serialNumber === 'string' &&
        otherEntry.serialNumber.trim() === cleanSerial
      ) {
        throw new CheckpointSafetyError(
          'TERMINAL_ID_CHANGED',
          `Refusing to create duplicate checkpoint for serial '${cleanSerial}': already bound to terminal key '${otherKey}'.`,
          { terminalKey: cleanKey, filePath: this.filePath }
        );
      }
    }

    const normalizedWatermark = new Date(options.watermarkIso).toISOString();
    const fresh: TerminalCheckpoint = {
      terminalKey: cleanKey,
      serialNumber: cleanSerial,
      lastSyncedPunchTimeIso: normalizedWatermark,
      lastSyncedDevicePunchId: null,
      recentPunchIds: [],
      pendingQueue: [],
      lastSuccessfulHeartbeatAt: null,
      lastSuccessfulSyncAt: null,
      lastSyncAttemptAt: null,
      lastProcessedPunchCount: 0,
      lastError: null,
      deviceInfo: null,
      lastSuccessfulUserSyncAt: null,
      lastUserSyncAttemptAt: null,
      lastUserSyncError: null,
      discoveredUserCount: null,
      syncedUserCount: null,
      pendingUserSync: null,
    };

    this.state.terminals[cleanKey] = fresh;
    this.persist();
    return cloneTerminalCheckpoint(fresh);
  }

  getTerminal(terminalKey: string, serialNumber: string): TerminalCheckpoint {
    const term = this.validateTerminalForPunchSync(terminalKey, serialNumber);
    return cloneTerminalCheckpoint(term);
  }

  /**
   * Filters newly polled device events against the mandatory effective cutoff, persisted checkpoint watermark,
   * and recent/pending dedup sets in deterministic chronological ascending order.
   */
  filterEligibleEvents(
    terminalKey: string,
    serialNumber: string,
    candidates: NormalizedPunchEvent[],
    options: {
      effectiveCutoffIso: string;
      overlapWindowMs?: number;
    }
  ): FilterEligibleEventsResult {
    const cp = this.validateTerminalForPunchSync(terminalKey, serialNumber);

    if (!isValidIsoDateString(options?.effectiveCutoffIso)) {
      throw new CheckpointSafetyError(
        'INVALID_CUTOFF',
        `Refusing to filter punches with invalid effectiveCutoffIso '${String(options?.effectiveCutoffIso)}'.`,
        { terminalKey, filePath: this.filePath }
      );
    }

    const effectiveCutoffMs = Date.parse(options.effectiveCutoffIso);
    const lastSyncedMs = Date.parse(cp.lastSyncedPunchTimeIso!);
    const overlapWindowMs = Math.max(0, options.overlapWindowMs ?? DEFAULT_WATERMARK_OVERLAP_MS);

    const seen = new Set<string>(cp.recentPunchIds);
    for (const queued of cp.pendingQueue) {
      seen.add(queued.devicePunchId);
    }

    const sortedCandidates = [...candidates].sort(compareNormalizedPunches);
    const eligible: NormalizedPunchEvent[] = [];
    let filteredHistoricalCount = 0;
    let skippedDuplicateCount = 0;
    let skippedBeforeWatermarkCount = 0;
    const lateBeforeWatermarkSamples: Array<{ devicePunchId: string; punchTime: string }> = [];

    for (const evt of sortedCandidates) {
      const evtMs = Date.parse(evt.punchTime);
      if (Number.isNaN(evtMs) || evtMs < effectiveCutoffMs) {
        filteredHistoricalCount += 1;
        continue;
      }

      if (seen.has(evt.devicePunchId)) {
        skippedDuplicateCount += 1;
        continue;
      }

      // Preserve existing checkpoint watermark as an additional restriction (with bounded clock-skew overlap),
      // while explicitly counting and surfacing any unseen in-day punches older than the watermark (never silent).
      if (evtMs < lastSyncedMs - overlapWindowMs) {
        skippedBeforeWatermarkCount += 1;
        if (lateBeforeWatermarkSamples.length < 10) {
          lateBeforeWatermarkSamples.push({
            devicePunchId: evt.devicePunchId,
            punchTime: evt.punchTime,
          });
        }
        continue;
      }

      seen.add(evt.devicePunchId);
      eligible.push(evt);
    }

    return {
      eligible,
      filteredHistoricalCount,
      skippedDuplicateCount,
      skippedBeforeWatermarkCount,
      lateBeforeWatermarkSamples,
    };
  }

  /**
   * Convenience wrapper returning only eligible NormalizedPunchEvent records in deterministic ascending order.
   */
  filterNewEvents(
    terminalKey: string,
    serialNumber: string,
    candidates: NormalizedPunchEvent[],
    options: {
      effectiveCutoffIso: string;
      overlapWindowMs?: number;
    }
  ): NormalizedPunchEvent[] {
    return this.filterEligibleEvents(terminalKey, serialNumber, candidates, options).eligible;
  }

  /**
   * Defensive pre-upload cutoff gate: removes any pendingQueue entries older than effectiveCutoffIso
   * without uploading them and without advancing the watermark.
   */
  prunePendingQueueBeforeCutoff(
    terminalKey: string,
    serialNumber: string,
    effectiveCutoffIso: string
  ): { removedCount: number; removedSamples: Array<{ devicePunchId: string; punchTime: string }> } {
    const cp = this.validateTerminalForPunchSync(terminalKey, serialNumber);
    if (!isValidIsoDateString(effectiveCutoffIso)) {
      throw new CheckpointSafetyError(
        'INVALID_CUTOFF',
        `Refusing to inspect pendingQueue with invalid effectiveCutoffIso '${String(effectiveCutoffIso)}'.`,
        { terminalKey, filePath: this.filePath }
      );
    }

    const cutoffMs = Date.parse(effectiveCutoffIso);
    const kept: NormalizedPunchEvent[] = [];
    const removedSamples: Array<{ devicePunchId: string; punchTime: string }> = [];
    let removedCount = 0;

    for (const evt of cp.pendingQueue) {
      const evtMs = Date.parse(evt.punchTime);
      if (Number.isNaN(evtMs) || evtMs < cutoffMs) {
        removedCount += 1;
        if (removedSamples.length < 10) {
          removedSamples.push({ devicePunchId: evt.devicePunchId, punchTime: evt.punchTime });
        }
      } else {
        kept.push(evt);
      }
    }

    if (removedCount > 0) {
      cp.pendingQueue = kept.sort(compareNormalizedPunches);
      this.persist();
    }

    return { removedCount, removedSamples };
  }

  enqueuePending(terminalKey: string, serialNumber: string, events: NormalizedPunchEvent[]): void {
    const cp = this.validateTerminalForPunchSync(terminalKey, serialNumber);
    if (events.length === 0) return;

    const existingIds = new Set(cp.pendingQueue.map((e) => e.devicePunchId));
    let added = false;
    for (const evt of events) {
      if (!existingIds.has(evt.devicePunchId)) {
        cp.pendingQueue.push(evt);
        existingIds.add(evt.devicePunchId);
        added = true;
      }
    }

    if (added) {
      cp.pendingQueue.sort(compareNormalizedPunches);
      this.persist();
    }
  }

  markBatchAcknowledged(terminalKey: string, serialNumber: string, ackedEvents: NormalizedPunchEvent[]): void {
    const cp = this.validateTerminalForPunchSync(terminalKey, serialNumber);
    if (ackedEvents.length === 0) return;

    const ackIds = new Set(ackedEvents.map((e) => e.devicePunchId));
    cp.pendingQueue = cp.pendingQueue
      .filter((e) => !ackIds.has(e.devicePunchId))
      .sort(compareNormalizedPunches);

    const recentSet = new Set(cp.recentPunchIds);
    let maxIso = cp.lastSyncedPunchTimeIso!;
    let maxMs = Date.parse(maxIso);
    let latestId = cp.lastSyncedDevicePunchId;

    const sortedAcked = [...ackedEvents].sort(compareNormalizedPunches);
    for (const evt of sortedAcked) {
      if (!recentSet.has(evt.devicePunchId)) {
        cp.recentPunchIds.push(evt.devicePunchId);
        recentSet.add(evt.devicePunchId);
      }
      const evtMs = Date.parse(evt.punchTime);
      if (!Number.isNaN(evtMs) && evtMs >= maxMs) {
        maxMs = evtMs;
        maxIso = evt.punchTime;
        latestId = evt.devicePunchId;
      }
    }

    if (cp.recentPunchIds.length > MAX_RECENT_IDS) {
      cp.recentPunchIds = cp.recentPunchIds.slice(cp.recentPunchIds.length - MAX_RECENT_IDS);
    }

    cp.lastSyncedPunchTimeIso = maxIso;
    cp.lastSyncedDevicePunchId = latestId;
    cp.lastSuccessfulSyncAt = new Date().toISOString();
    cp.lastProcessedPunchCount = ackedEvents.length;
    cp.lastError = null;

    this.persist();
  }

  /**
   * Updates non-watermark telemetry ONLY on an already-valid matching terminal checkpoint.
   * Never creates a missing checkpoint file, never creates an empty terminal entry,
   * and never overwrites a corrupt or mismatched checkpoint.
   */
  updateStatus(
    terminalKey: string,
    serialNumber: string,
    patch: Partial<
      Pick<
        TerminalCheckpoint,
        | 'lastSuccessfulHeartbeatAt'
        | 'lastSuccessfulSyncAt'
        | 'lastSyncAttemptAt'
        | 'lastProcessedPunchCount'
        | 'lastError'
        | 'deviceInfo'
        | 'lastSuccessfulUserSyncAt'
        | 'lastUserSyncAttemptAt'
        | 'lastUserSyncError'
        | 'discoveredUserCount'
        | 'syncedUserCount'
        | 'pendingUserSync'
      >
    >
  ): boolean {
    if (this.loadStatus !== 'VALID' || !this.state) {
      return false;
    }
    const existing = this.state.terminals[terminalKey];
    if (!existing || !isPlainObject(existing)) {
      return false;
    }
    if (
      typeof existing.serialNumber !== 'string' ||
      existing.serialNumber.trim() !== serialNumber.trim()
    ) {
      return false;
    }

    Object.assign(existing, patch);
    this.persist();
    return true;
  }

  /**
   * Atomic write using temporary file + rename.
   * Refuses to write when checkpoint state is not VALID (never overwrites corrupt or missing files).
   */
  persist(): void {
    if (this.loadStatus !== 'VALID' || !this.state) {
      return;
    }
    this.state.updatedAt = new Date().toISOString();
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }
}
