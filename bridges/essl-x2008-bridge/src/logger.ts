import fs from 'fs';
import path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|secret|token|password|comm[_-]?key|authorization|x-device-api-key|credential)/i;

export function redactSensitiveText(input: string): string {
  if (!input) return input;
  return input
    .replace(/bio_live_[A-Za-z0-9_-]{12,}/gi, (match) => `${match.slice(0, 12)}***REDACTED***`)
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***REDACTED***')
    .replace(/(x-device-api-key['":\s=]+)[^\s"',}]+/gi, '$1***REDACTED***')
    .replace(/(commKey['":\s=]+)\d+/gi, '$1***REDACTED***');
}

export function redactObject<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSensitiveText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactObject(item)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k) && k !== 'apiKeyPrefix') {
        out[k] = '***REDACTED***';
      } else {
        out[k] = redactObject(v);
      }
    }
    return out as T;
  }
  return value;
}

export class BridgeLogger {
  private readonly minPriority: number;
  private readonly logFilePath: string | null;
  private readonly maxBytes: number;
  private readonly silentConsole: boolean;

  constructor(options?: {
    level?: LogLevel;
    logDir?: string;
    fileName?: string;
    maxBytes?: number;
    silentConsole?: boolean;
  }) {
    const level = options?.level || 'info';
    this.minPriority = LEVEL_PRIORITY[level] ?? LEVEL_PRIORITY.info;
    this.maxBytes = options?.maxBytes ?? 5 * 1024 * 1024;
    this.silentConsole = options?.silentConsole === true;

    if (options?.logDir) {
      fs.mkdirSync(options.logDir, { recursive: true });
      this.logFilePath = path.join(options.logDir, options.fileName || 'bridge.log');
    } else {
      this.logFilePath = null;
    }
  }

  debug(event: string, meta?: Record<string, unknown>): void {
    this.write('debug', event, meta);
  }

  info(event: string, meta?: Record<string, unknown>): void {
    this.write('info', event, meta);
  }

  warn(event: string, meta?: Record<string, unknown>): void {
    this.write('warn', event, meta);
  }

  error(event: string, meta?: Record<string, unknown>): void {
    this.write('error', event, meta);
  }

  private write(level: LogLevel, event: string, meta?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < this.minPriority) return;

    const entry = {
      ts: new Date().toISOString(),
      level,
      event: redactSensitiveText(event),
      ...(meta ? (redactObject(meta) as Record<string, unknown>) : {}),
    };

    const line = JSON.stringify(entry);

    if (!this.silentConsole) {
      if (level === 'error') {
        console.error(line);
      } else if (level === 'warn') {
        console.warn(line);
      } else {
        console.log(line);
      }
    }

    if (this.logFilePath) {
      try {
        if (fs.existsSync(this.logFilePath)) {
          const stat = fs.statSync(this.logFilePath);
          if (stat.size >= this.maxBytes) {
            const rotatedPath = `${this.logFilePath}.1`;
            if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
            fs.renameSync(this.logFilePath, rotatedPath);
          }
        }
        fs.appendFileSync(this.logFilePath, `${line}\n`, 'utf8');
      } catch {
        // Avoid crashing daemon if log rotation hits transient file lock
      }
    }
  }
}
