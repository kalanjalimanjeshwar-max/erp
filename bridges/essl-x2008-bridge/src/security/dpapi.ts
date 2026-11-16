import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

interface DpapiCredentialStoreFile {
  version: 1;
  scope: 'CurrentUser' | 'LocalMachine';
  secrets: Record<string, string>; // key -> base64 DPAPI cipherText
}

/**
 * Windows DPAPI Credential Storage Helper.
 * Uses built-in .NET ProtectedData via PowerShell on Windows hosts so device API keys
 * are never stored in plaintext on disk.
 */
export function isWindowsPlatform(): boolean {
  return process.platform === 'win32';
}

export function dpapiEncryptString(plainText: string, scope: 'CurrentUser' | 'LocalMachine' = 'CurrentUser'): string {
  if (!isWindowsPlatform()) {
    throw new Error('Windows DPAPI encryption is only available on Windows hosts.');
  }

  const inputB64 = Buffer.from(plainText, 'utf8').toString('base64');
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$plain = [System.Convert]::FromBase64String($env:COREERP_DPAPI_INPUT);',
    `$scope = [System.Security.Cryptography.DataProtectionScope]::${scope};`,
    '$enc = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, $scope);',
    '[System.Convert]::ToBase64String($enc)',
  ].join(' ');

  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, COREERP_DPAPI_INPUT: inputB64 },
    encoding: 'utf8',
    timeout: 10000,
  });

  return output.trim();
}

export function dpapiDecryptString(cipherB64: string, scope: 'CurrentUser' | 'LocalMachine' = 'CurrentUser'): string {
  if (!isWindowsPlatform()) {
    throw new Error('Windows DPAPI decryption is only available on Windows hosts.');
  }

  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$enc = [System.Convert]::FromBase64String($env:COREERP_DPAPI_CIPHER);',
    `$scope = [System.Security.Cryptography.DataProtectionScope]::${scope};`,
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, $scope);',
    '[System.Text.Encoding]::UTF8.GetString($plain)',
  ].join(' ');

  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, COREERP_DPAPI_CIPHER: cipherB64 },
    encoding: 'utf8',
    timeout: 10000,
  });

  return output.trim();
}

export function saveDpapiSecret(
  storePath: string,
  credentialName: string,
  secretValue: string,
  scope: 'CurrentUser' | 'LocalMachine' = 'CurrentUser'
): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });

  let store: DpapiCredentialStoreFile = { version: 1, scope, secrets: {} };
  if (fs.existsSync(storePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as DpapiCredentialStoreFile;
      if (parsed && parsed.secrets) store = parsed;
    } catch {
      // Overwrite invalid empty store
    }
  }

  store.scope = scope;
  store.secrets[credentialName] = dpapiEncryptString(secretValue, scope);
  const tmpPath = `${storePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmpPath, storePath);
}

export function readDpapiSecret(storePath: string, credentialName: string): string | null {
  if (!fs.existsSync(storePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as DpapiCredentialStoreFile;
  const cipherB64 = parsed?.secrets?.[credentialName];
  if (!cipherB64) return null;
  return dpapiDecryptString(cipherB64, parsed.scope || 'CurrentUser');
}

/**
 * Resolves terminal API key using Windows DPAPI store first, then configured env var, then explicit config.
 */
export function resolveTerminalApiKey(options: {
  dpapiStorePath: string;
  dpapiCredentialName?: string;
  apiKeyEnv?: string;
  inlineApiKey?: string;
}): string {
  if (options.dpapiCredentialName && isWindowsPlatform()) {
    const dpapiVal = readDpapiSecret(options.dpapiStorePath, options.dpapiCredentialName);
    if (dpapiVal) return dpapiVal;
  }

  if (options.apiKeyEnv && process.env[options.apiKeyEnv]?.trim()) {
    return process.env[options.apiKeyEnv]!.trim();
  }

  if (options.inlineApiKey?.trim()) {
    return options.inlineApiKey.trim();
  }

  throw new Error(
    `Missing CoreERP device API key. Configure Windows DPAPI secret ('${options.dpapiCredentialName || 'N/A'}') or environment variable '${options.apiKeyEnv || 'COREERP_DEVICE_API_KEY'}'.`
  );
}

/**
 * Enforces HTTPS for CoreERP endpoints unless local loopback or explicit opt-in for isolated LAN HTTP testing.
 */
export function validateTransportUrl(baseUrl: string, allowInsecureHttp: boolean): URL {
  const parsed = new URL(baseUrl);
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (isLoopback || allowInsecureHttp))) {
    throw new Error(
      `Insecure CoreERP URL '${parsed.origin}' rejected. Use HTTPS in production (or set allowInsecureHttp=true only for isolated local testing).`
    );
  }
  return parsed;
}
