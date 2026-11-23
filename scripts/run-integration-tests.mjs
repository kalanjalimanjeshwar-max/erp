#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPROVED_INTEGRATION_HOSTS = new Set(['localhost', '127.0.0.1']);
export const INTEGRATION_DB_PORT = '5434';
export const INTEGRATION_DB_NAME = 'core_erp_integration_test';

/**
 * Trims whitespace and strips matching surrounding single or double quotes.
 */
export function normalizeDatabaseUrl(rawValue) {
  if (typeof rawValue !== 'string') {
    return '';
  }
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Redacts credentials from a database URL so secrets never appear in diagnostics.
 */
export function redactDatabaseUrl(rawValue) {
  const normalized = normalizeDatabaseUrl(rawValue);
  if (!normalized) {
    return '[NOT_CONFIGURED]';
  }
  try {
    const parsed = new URL(normalized);
    const auth = parsed.username ? `${parsed.username}:*****@` : '';
    return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`;
  } catch {
    return '[REDACTED_INVALID_URL]';
  }
}

/**
 * Strictly validates TEST_DATABASE_URL for the dedicated PostgreSQL 16 integration database.
 * Never includes credentials or raw connection strings in thrown errors.
 */
export function validateIntegrationTestDatabaseUrl(rawValue) {
  const normalizedUrl = normalizeDatabaseUrl(rawValue);
  if (!normalizedUrl) {
    throw new Error(
      '[INTEGRATION RUNNER SAFETY VIOLATION] TEST_DATABASE_URL is required to run CoreERP integration tests. ' +
        `Expected a local PostgreSQL URL targeting localhost or 127.0.0.1 on port ${INTEGRATION_DB_PORT} for database "${INTEGRATION_DB_NAME}".`
    );
  }

  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new Error(
      '[INTEGRATION RUNNER SAFETY VIOLATION] Invalid or unparseable TEST_DATABASE_URL. ' +
        `Expected a valid PostgreSQL URL targeting localhost or 127.0.0.1:${INTEGRATION_DB_PORT}/${INTEGRATION_DB_NAME}.`
    );
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      `[INTEGRATION RUNNER SAFETY VIOLATION] Forbidden protocol "${parsed.protocol}" in TEST_DATABASE_URL (${redactDatabaseUrl(normalizedUrl)}). Only PostgreSQL is allowed.`
    );
  }

  if (!APPROVED_INTEGRATION_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `[INTEGRATION RUNNER SAFETY VIOLATION] Unapproved host "${parsed.hostname}" in TEST_DATABASE_URL (${redactDatabaseUrl(normalizedUrl)}). Only localhost or 127.0.0.1 is allowed.`
    );
  }

  if (parsed.port !== INTEGRATION_DB_PORT) {
    throw new Error(
      `[INTEGRATION RUNNER SAFETY VIOLATION] Unapproved port "${parsed.port || 'default'}" in TEST_DATABASE_URL (${redactDatabaseUrl(normalizedUrl)}). Dedicated integration tests must run strictly on port ${INTEGRATION_DB_PORT}.`
    );
  }

  const dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
  if (dbName !== INTEGRATION_DB_NAME) {
    throw new Error(
      `[INTEGRATION RUNNER SAFETY VIOLATION] Unapproved database "${dbName || '(empty)'}" in TEST_DATABASE_URL (${redactDatabaseUrl(normalizedUrl)}). Expected strictly "${INTEGRATION_DB_NAME}".`
    );
  }

  return {
    normalizedUrl,
    sanitizedUrl: redactDatabaseUrl(normalizedUrl),
  };
}

/**
 * Prepares an isolated child environment for integration tests:
 * - Validates TEST_DATABASE_URL upfront
 * - Sets NODE_ENV=test and COREERP_INTEGRATION_TEST_MODE=true
 * - Removes DATABASE_URL completely to prevent split-brain routing
 */
export function buildIntegrationChildEnv(baseEnv = process.env) {
  const { normalizedUrl, sanitizedUrl } = validateIntegrationTestDatabaseUrl(
    baseEnv.TEST_DATABASE_URL
  );

  const childEnv = { ...baseEnv };
  for (const key of Object.keys(childEnv)) {
    if (key.toUpperCase() === 'DATABASE_URL') {
      delete childEnv[key];
    }
  }
  childEnv.NODE_ENV = 'test';
  childEnv.COREERP_INTEGRATION_TEST_MODE = 'true';
  childEnv.TEST_DATABASE_URL = normalizedUrl;

  return {
    childEnv,
    sanitizedUrl,
  };
}

/**
 * Resolves the locally installed Vitest CLI entrypoint JS file without npx or shell lookup.
 */
export function resolveVitestCliPath() {
  const require = createRequire(import.meta.url);
  const vitestPkgPath = require.resolve('vitest/package.json');
  const vitestDir = path.dirname(vitestPkgPath);
  const pkg = JSON.parse(fs.readFileSync(vitestPkgPath, 'utf-8'));

  let relBin = 'vitest.mjs';
  if (typeof pkg.bin === 'string') {
    relBin = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin.vitest === 'string') {
    relBin = pkg.bin.vitest;
  }

  const cliPath = path.resolve(vitestDir, relBin);
  if (!fs.existsSync(cliPath)) {
    throw new Error(
      `[INTEGRATION RUNNER ERROR] Resolved Vitest CLI entrypoint does not exist at "${cliPath}".`
    );
  }
  return cliPath;
}

/**
 * Executes Vitest directly via process.execPath against the local Vitest CLI.
 * Never uses npx.cmd, shell: true, or shell interpolation.
 */
export function runIntegrationTests(targetArgs = [], options = {}) {
  const {
    env = process.env,
    spawnFn = spawnSync,
    execPath = process.execPath,
    vitestCliPath,
    stderr = process.stderr,
  } = options;

  let childEnv;
  try {
    ({ childEnv } = buildIntegrationChildEnv(env));
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let resolvedVitestCli;
  try {
    resolvedVitestCli = vitestCliPath ?? resolveVitestCliPath();
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const targets = targetArgs.length > 0 ? targetArgs : ['tests/integration'];
  const args = [resolvedVitestCli, 'run', ...targets];

  const result = spawnFn(execPath, args, {
    stdio: 'inherit',
    env: childEnv,
  });

  if (result.error) {
    const code = result.error.code ? ` (${result.error.code})` : '';
    stderr.write(
      `[INTEGRATION RUNNER ERROR] Failed to spawn Vitest via "${execPath}"${code}: ${result.error.message}\n`
    );
    return 1;
  }

  if (result.signal) {
    stderr.write(
      `[INTEGRATION RUNNER ERROR] Vitest integration process terminated by signal ${result.signal}.\n`
    );
    return 1;
  }

  if (typeof result.status !== 'number') {
    stderr.write(
      '[INTEGRATION RUNNER ERROR] Vitest integration process exited without a numeric exit code.\n'
    );
    return 1;
  }

  return result.status;
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const exitCode = runIntegrationTests(process.argv.slice(2));
  process.exit(exitCode);
}
