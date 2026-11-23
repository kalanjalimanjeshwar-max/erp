import fs from 'fs';
import path from 'path';

export interface BridgeLockMetadata {
  pid: number;
  host: string;
  startedAt: string;
  workDir: string;
}

export class BridgeInstanceLockError extends Error {
  readonly existingPid: number | null;
  readonly lockFilePath: string;

  constructor(message: string, lockFilePath: string, existingPid: number | null = null) {
    super(message);
    this.name = 'BridgeInstanceLockError';
    this.lockFilePath = lockFilePath;
    this.existingPid = existingPid;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPERM means the process exists under another privilege level
    return code === 'EPERM';
  }
}

/**
 * Single-instance PID lockfile guard preventing duplicate bridge daemons
 * from contending for TCP port 4370 on the biometric device or health port 4379.
 */
export class BridgeInstanceLock {
  private readonly lockFilePath: string;
  private readonly checkPidAlive: (pid: number) => boolean;
  private acquired = false;

  constructor(
    dataDir: string,
    options?: {
      fileName?: string;
      isPidAlive?: (pid: number) => boolean;
    }
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.lockFilePath = path.join(dataDir, options?.fileName || 'bridge.lock.json');
    this.checkPidAlive = options?.isPidAlive || isProcessAlive;
  }

  getLockFilePath(): string {
    return this.lockFilePath;
  }

  isAcquired(): boolean {
    return this.acquired;
  }

  readLock(): BridgeLockMetadata | null {
    try {
      if (!fs.existsSync(this.lockFilePath)) return null;
      const raw = fs.readFileSync(this.lockFilePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<BridgeLockMetadata>;
      if (typeof parsed.pid !== 'number') return null;
      return {
        pid: parsed.pid,
        host: String(parsed.host || ''),
        startedAt: String(parsed.startedAt || ''),
        workDir: String(parsed.workDir || ''),
      };
    } catch {
      return null;
    }
  }

  acquire(meta?: { host?: string; workDir?: string }): BridgeLockMetadata {
    if (this.acquired) {
      return (
        this.readLock() || {
          pid: process.pid,
          host: meta?.host || '',
          startedAt: new Date().toISOString(),
          workDir: meta?.workDir || process.cwd(),
        }
      );
    }

    const payload: BridgeLockMetadata = {
      pid: process.pid,
      host: meta?.host || '',
      startedAt: new Date().toISOString(),
      workDir: meta?.workDir || process.cwd(),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.lockFilePath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        this.acquired = true;
        return payload;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EEXIST') {
          throw err;
        }

        const existing = this.readLock();
        if (existing && existing.pid !== process.pid && this.checkPidAlive(existing.pid)) {
          throw new BridgeInstanceLockError(
            `Another CoreERP Biometric Bridge daemon is already running (PID ${existing.pid}, started ${existing.startedAt}). Refusing to start duplicate process.`,
            this.lockFilePath,
            existing.pid
          );
        }

        // Stale lockfile from crashed/terminated process — remove safely and retry once
        try {
          fs.unlinkSync(this.lockFilePath);
        } catch {
          // If unlink races with another starter, next loop iteration will fail cleanly
        }
      }
    }

    const existing = this.readLock();
    throw new BridgeInstanceLockError(
      `Unable to acquire single-instance bridge lock at '${this.lockFilePath}'.`,
      this.lockFilePath,
      existing?.pid ?? null
    );
  }

  release(): void {
    if (!this.acquired) return;
    this.acquired = false;
    try {
      const existing = this.readLock();
      if (!existing || existing.pid === process.pid) {
        if (fs.existsSync(this.lockFilePath)) {
          fs.unlinkSync(this.lockFilePath);
        }
      }
    } catch {
      // Best-effort cleanup on process shutdown
    }
  }
}
