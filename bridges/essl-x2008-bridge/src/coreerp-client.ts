import { NormalizedPunchEvent } from './types.js';
import { redactSensitiveText } from './logger.js';

export interface HeartbeatPayload {
  firmwareVersion?: string;
  platform?: string;
  fingerprintAlgorithm?: string;
  deviceSerialNumber: string;
  bridgeConnected: boolean;
  bridgeHost: string;
  bridgeVersion: string;
  lastConnectionError?: string | null;
  lastProcessedPunchCount?: number;
  lastSyncAttemptAt?: string;
  lastSyncAt?: string;
}

export interface HeartbeatResult {
  success: boolean;
  serverTime: string;
  terminalId: string;
  terminalName: string;
  status: string;
  syncRequested?: boolean;
  syncRequestedAt?: string | null;
}

export interface BatchSubmitResult {
  success: boolean;
  totalReceived: number;
  inserted: number;
  duplicates: number;
  unmappedEmployees: number;
  terminalId: string;
  terminalName: string;
}

export class CoreErpApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly isAuthError: boolean;
  readonly isRetryable: boolean;

  constructor(message: string, statusCode: number, code = 'API_ERROR') {
    super(redactSensitiveText(message));
    this.name = 'CoreErpApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.isAuthError = statusCode === 401 || statusCode === 403;
    this.isRetryable = statusCode === 0 || statusCode === 429 || statusCode >= 500;
  }
}

export interface ICoreErpClient {
  sendHeartbeat(apiKey: string, serialNumber: string, payload: HeartbeatPayload): Promise<HeartbeatResult>;
  submitPunches(
    apiKey: string,
    serialNumber: string,
    punches: NormalizedPunchEvent[],
    meta?: { bridgeHost?: string; bridgeVersion?: string }
  ): Promise<BatchSubmitResult>;
}

export class CoreErpHttpClient implements ICoreErpClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(baseUrl: string, requestTimeoutMs = 15000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async sendHeartbeat(apiKey: string, serialNumber: string, payload: HeartbeatPayload): Promise<HeartbeatResult> {
    return this.postJson<HeartbeatResult>('/api/biometric/heartbeat', apiKey, serialNumber, payload);
  }

  async submitPunches(
    apiKey: string,
    serialNumber: string,
    punches: NormalizedPunchEvent[],
    meta?: { bridgeHost?: string; bridgeVersion?: string }
  ): Promise<BatchSubmitResult> {
    return this.postJson<BatchSubmitResult>('/api/biometric/punches', apiKey, serialNumber, {
      punches,
      deviceSerialNumber: serialNumber,
      bridgeHost: meta?.bridgeHost,
      bridgeVersion: meta?.bridgeVersion,
    });
  }

  private async postJson<T>(
    endpointPath: string,
    apiKey: string,
    serialNumber: string,
    body: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${endpointPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Api-Key': apiKey,
          'X-Device-Serial': serialNumber,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const message = parsed?.error?.message || `HTTP ${response.status} from CoreERP (${endpointPath})`;
        const code = parsed?.error?.code || `HTTP_${response.status}`;
        throw new CoreErpApiError(message, response.status, code);
      }

      return parsed as T;
    } catch (err: unknown) {
      if (err instanceof CoreErpApiError) {
        throw err;
      }
      const message = (err as Error)?.name === 'AbortError'
        ? `CoreERP request timed out after ${this.requestTimeoutMs}ms (${endpointPath})`
        : `Network error calling CoreERP (${endpointPath}): ${(err as Error)?.message || 'unknown error'}`;
      throw new CoreErpApiError(message, 0, 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }
}
