import fs from 'fs';
import path from 'path';
import { BridgeCheckpointFile, NormalizedPunchEvent, TerminalCheckpoint } from './types.js';

const MAX_RECENT_IDS = 5000;

export class CheckpointStore {
  private readonly filePath: string;
  private state: BridgeCheckpointFile;

  constructor(dataDir: string, fileName = 'checkpoints.json') {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, fileName);
    this.state = this.loadFromDisk();
  }

  private loadFromDisk(): BridgeCheckpointFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as BridgeCheckpointFile;
        if (parsed && parsed.version === 1 && parsed.terminals && typeof parsed.terminals === 'object') {
          return parsed;
        }
      }
    } catch {
      // If checkpoint file was corrupted externally, preserve backup and start clean
      try {
        if (fs.existsSync(this.filePath)) {
          fs.copyFileSync(this.filePath, `${this.filePath}.corrupt.${Date.now()}`);
        }
      } catch {
        // Ignore backup failure
      }
    }

    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      terminals: {},
    };
  }

  getTerminal(terminalKey: string, serialNumber: string): TerminalCheckpoint {
    const existing = this.state.terminals[terminalKey];
    if (existing) {
      return existing;
    }

    const fresh: TerminalCheckpoint = {
      terminalKey,
      serialNumber,
      lastSyncedPunchTimeIso: null,
      lastSyncedDevicePunchId: null,
      recentPunchIds: [],
      pendingQueue: [],
      lastSuccessfulHeartbeatAt: null,
      lastSuccessfulSyncAt: null,
      lastSyncAttemptAt: null,
      lastProcessedPunchCount: 0,
      lastError: null,
      deviceInfo: null,
    };

    this.state.terminals[terminalKey] = fresh;
    this.persist();
    return fresh;
  }

  /**
   * Filters newly polled device events against the persisted checkpoint & recent punch ring
   * so bridge restarts or overlapping device polls never re-queue already acknowledged punches.
   */
  filterNewEvents(terminalKey: string, serialNumber: string, candidates: NormalizedPunchEvent[]): NormalizedPunchEvent[] {
    const cp = this.getTerminal(terminalKey, serialNumber);
    const seen = new Set<string>(cp.recentPunchIds);
    for (const queued of cp.pendingQueue) {
      seen.add(queued.devicePunchId);
    }

    const lastSyncedMs = cp.lastSyncedPunchTimeIso ? new Date(cp.lastSyncedPunchTimeIso).getTime() : null;

    return candidates.filter((evt) => {
      if (seen.has(evt.devicePunchId)) return false;

      // Also skip punches strictly older than lastSyncedPunchTimeIso minus a 5-minute safety clock-skew overlap
      // (within the 5-minute overlap window, exact devicePunchId dedup above handles duplicates safely)
      if (lastSyncedMs !== null && !Number.isNaN(lastSyncedMs)) {
        const evtMs = new Date(evt.punchTime).getTime();
        if (!Number.isNaN(evtMs) && evtMs < lastSyncedMs - 5 * 60 * 1000) {
          return false;
        }
      }

      seen.add(evt.devicePunchId);
      return true;
    });
  }

  enqueuePending(terminalKey: string, serialNumber: string, events: NormalizedPunchEvent[]): void {
    if (events.length === 0) return;
    const cp = this.getTerminal(terminalKey, serialNumber);
    const existingIds = new Set(cp.pendingQueue.map((e) => e.devicePunchId));
    for (const evt of events) {
      if (!existingIds.has(evt.devicePunchId)) {
        cp.pendingQueue.push(evt);
        existingIds.add(evt.devicePunchId);
      }
    }
    this.persist();
  }

  markBatchAcknowledged(terminalKey: string, serialNumber: string, ackedEvents: NormalizedPunchEvent[]): void {
    const cp = this.getTerminal(terminalKey, serialNumber);
    const ackIds = new Set(ackedEvents.map((e) => e.devicePunchId));

    cp.pendingQueue = cp.pendingQueue.filter((e) => !ackIds.has(e.devicePunchId));

    const recentSet = new Set(cp.recentPunchIds);
    let maxIso = cp.lastSyncedPunchTimeIso;
    let maxMs = maxIso ? new Date(maxIso).getTime() : 0;
    let latestId = cp.lastSyncedDevicePunchId;

    for (const evt of ackedEvents) {
      if (!recentSet.has(evt.devicePunchId)) {
        cp.recentPunchIds.push(evt.devicePunchId);
        recentSet.add(evt.devicePunchId);
      }
      const evtMs = new Date(evt.punchTime).getTime();
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
      >
    >
  ): void {
    const cp = this.getTerminal(terminalKey, serialNumber);
    Object.assign(cp, patch);
    this.persist();
  }

  /**
   * Atomic write using temporary file + rename so crashes never corrupt checkpoint JSON.
   */
  persist(): void {
    this.state.updatedAt = new Date().toISOString();
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }
}
