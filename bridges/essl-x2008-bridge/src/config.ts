import fs from 'fs';
import os from 'os';
import path from 'path';
import { BridgeConfig, TerminalConfig } from './types.js';
import { LogLevel } from './logger.js';

/**
 * Lightweight zero-dependency .env loader (does not overwrite existing process.env values).
 */
export function loadDotEnvFile(envFilePath: string): void {
  if (!fs.existsSync(envFilePath)) return;
  const content = fs.readFileSync(envFilePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let val = line.slice(eqIndex + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

export function loadBridgeConfig(baseDir = process.cwd()): BridgeConfig {
  loadDotEnvFile(path.join(baseDir, '.env'));

  const configPath = process.env.BRIDGE_CONFIG_PATH
    ? path.resolve(baseDir, process.env.BRIDGE_CONFIG_PATH)
    : path.join(baseDir, 'bridge.config.json');

  let fileConfig: Partial<BridgeConfig> = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<BridgeConfig>;
  }

  const dataDir = path.resolve(baseDir, process.env.BRIDGE_DATA_DIR || fileConfig.dataDir || './data');
  const logDir = path.resolve(baseDir, process.env.BRIDGE_LOG_DIR || fileConfig.logDir || './logs');

  let terminals: TerminalConfig[] = Array.isArray(fileConfig.terminals) ? fileConfig.terminals : [];

  // Allow simple single-terminal environment variable setup if bridge.config.json is omitted
  if (terminals.length === 0 && process.env.DEVICE_SERIAL_NUMBER && process.env.DEVICE_IP) {
    terminals = [
      {
        id: process.env.TERMINAL_ID || 'essl-x2008-primary',
        name: process.env.TERMINAL_NAME || 'eSSL X2008 Main Terminal',
        serialNumber: process.env.DEVICE_SERIAL_NUMBER.trim(),
        ipAddress: process.env.DEVICE_IP.trim(),
        port: Number(process.env.DEVICE_PORT || 4370),
        commKey: Number(process.env.DEVICE_COMM_KEY || 0),
        deviceTimezone: process.env.DEVICE_TIMEZONE || 'Asia/Kolkata',
        apiKeyEnv: 'COREERP_DEVICE_API_KEY',
        dpapiCredentialName: process.env.DPAPI_CREDENTIAL_NAME || 'coreerp-essl-x2008-primary',
      },
    ];
  }

  if (terminals.length === 0) {
    throw new Error(
      `No biometric terminals configured. Provide '${configPath}' or set DEVICE_SERIAL_NUMBER & DEVICE_IP in .env.`
    );
  }

  const coreErpBaseUrl = (
    process.env.COREERP_BASE_URL ||
    fileConfig.coreErpBaseUrl ||
    ''
  ).trim();

  if (!coreErpBaseUrl) {
    throw new Error('Missing COREERP_BASE_URL / coreErpBaseUrl configuration.');
  }

  return {
    coreErpBaseUrl,
    allowInsecureHttp:
      process.env.BRIDGE_ALLOW_INSECURE_HTTP === 'true' || fileConfig.allowInsecureHttp === true,
    bridgeHost: (process.env.BRIDGE_HOST_NAME || fileConfig.bridgeHost || os.hostname()).trim(),
    bridgeVersion: '1.0.0',
    healthHost: (process.env.BRIDGE_HEALTH_HOST || fileConfig.healthHost || '127.0.0.1').trim(),
    healthPort: Number(process.env.BRIDGE_HEALTH_PORT || fileConfig.healthPort || 4379),
    dataDir,
    logDir,
    logLevel: ((process.env.BRIDGE_LOG_LEVEL || fileConfig.logLevel || 'info') as LogLevel),
    batchSize: Number(process.env.BRIDGE_BATCH_SIZE || fileConfig.batchSize || 200),
    pollIntervalMs: Number(process.env.BRIDGE_POLL_INTERVAL_MS || fileConfig.pollIntervalMs || 15000),
    heartbeatIntervalMs: Number(
      process.env.BRIDGE_HEARTBEAT_INTERVAL_MS || fileConfig.heartbeatIntervalMs || 30000
    ),
    jobPollIntervalMs: Number(
      process.env.BRIDGE_JOB_POLL_INTERVAL_MS || fileConfig.jobPollIntervalMs || 5000
    ),
    userSyncTimeoutMs: Number(
      process.env.BRIDGE_USER_SYNC_TIMEOUT_MS || fileConfig.userSyncTimeoutMs || 45000
    ),
    connectTimeoutMs: Number(process.env.BRIDGE_CONNECT_TIMEOUT_MS || fileConfig.connectTimeoutMs || 5000),
    maxBackoffMs: Number(process.env.BRIDGE_MAX_BACKOFF_MS || fileConfig.maxBackoffMs || 300000),
    dpapiStorePath: path.resolve(
      baseDir,
      process.env.BRIDGE_DPAPI_STORE_PATH || fileConfig.dpapiStorePath || path.join(dataDir, 'credentials.dpapi.json')
    ),
    terminals,
  };
}
