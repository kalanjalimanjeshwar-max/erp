import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  normalizeDatabaseUrl as normalizeRunnerUrl,
  redactDatabaseUrl,
  validateIntegrationTestDatabaseUrl,
  buildIntegrationChildEnv,
  resolveVitestCliPath,
  runIntegrationTests,
} from '../../scripts/run-integration-tests.mjs';
import {
  APPROVED_STANDARD_TEST_DB_URL,
  configureTestEnvironment,
} from '../setup.js';
import { validateIsolatedUnitDbEnv } from '../helpers/unit-prisma-guard.js';
import {
  createPrismaClient,
  resetPrismaClientForTesting,
} from '../../src/server/db/client.js';

describe('Cross-Platform Integration Runner & Vitest DB-Free Isolation Safety (DB-Free)', () => {
  const origEnv = { ...process.env };
  const validLocalhostUrl =
    'postgresql://erp_integration_user:SuperSecretIntegrationPass99!@localhost:5434/core_erp_integration_test?schema=public';
  const validLoopbackUrl =
    'postgres://erp_integration_user:SuperSecretIntegrationPass99!@127.0.0.1:5434/core_erp_integration_test';

  beforeEach(() => {
    resetPrismaClientForTesting();
    process.env = { ...origEnv };
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    resetPrismaClientForTesting();
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  describe('1. Integration Runner URL Validation & Credential Redaction', () => {
    it('accepts valid localhost and 127.0.0.1 port-5434 core_erp_integration_test URLs and strips surrounding quotes', () => {
      const resLocal = validateIntegrationTestDatabaseUrl(` "${validLocalhostUrl}" `);
      expect(resLocal.normalizedUrl).toBe(validLocalhostUrl);
      expect(resLocal.sanitizedUrl).toBe(
        'postgresql://erp_integration_user:*****@localhost:5434/core_erp_integration_test'
      );
      expect(resLocal.sanitizedUrl).not.toContain('SuperSecretIntegrationPass99!');

      const resLoopback = validateIntegrationTestDatabaseUrl(`'${validLoopbackUrl}'`);
      expect(resLoopback.normalizedUrl).toBe(validLoopbackUrl);
      expect(resLoopback.sanitizedUrl).toBe(
        'postgres://erp_integration_user:*****@127.0.0.1:5434/core_erp_integration_test'
      );
      expect(resLoopback.sanitizedUrl).not.toContain('SuperSecretIntegrationPass99!');
    });

    it('rejects missing, empty, or malformed URLs without leaking raw credentials', () => {
      expect(() => validateIntegrationTestDatabaseUrl(undefined)).toThrow(
        /TEST_DATABASE_URL is required/
      );
      expect(() => validateIntegrationTestDatabaseUrl('   ')).toThrow(
        /TEST_DATABASE_URL is required/
      );
      expect(() => validateIntegrationTestDatabaseUrl('""')).toThrow(
        /TEST_DATABASE_URL is required/
      );

      let caught: Error | undefined;
      try {
        validateIntegrationTestDatabaseUrl('not-a-url-with-SuperSecretIntegrationPass99!');
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/Invalid or unparseable TEST_DATABASE_URL/);
      expect(caught!.message).not.toContain('SuperSecretIntegrationPass99!');
      expect(redactDatabaseUrl('not-a-url-with-SuperSecretIntegrationPass99!')).toBe(
        '[REDACTED_INVALID_URL]'
      );
      expect(normalizeRunnerUrl(' "abc" ')).toBe('abc');
    });

    it('rejects dev port 5432, unit port 5433, missing port, remote hosts, non-PostgreSQL protocols, and wrong DB names while redacting credentials', () => {
      const secret = 'UltraSensitiveDbSecret_8842!';
      const rejectedCases: Array<{ url: string; pattern: RegExp }> = [
        {
          url: `postgresql://erp_user:${secret}@localhost:5432/core_erp_integration_test`,
          pattern: /Unapproved port "5432"/,
        },
        {
          url: `postgresql://erp_test_user:${secret}@localhost:5433/core_erp_integration_test`,
          pattern: /Unapproved port "5433"/,
        },
        {
          url: `postgresql://erp_user:${secret}@localhost/core_erp_integration_test`,
          pattern: /Unapproved port "default"/,
        },
        {
          url: `postgresql://erp_integration_user:${secret}@prod.db.internal:5434/core_erp_integration_test`,
          pattern: /Unapproved host "prod\.db\.internal"/,
        },
        {
          url: `mysql://erp_integration_user:${secret}@localhost:5434/core_erp_integration_test`,
          pattern: /Forbidden protocol "mysql:"/,
        },
        {
          url: `postgresql://erp_integration_user:${secret}@127.0.0.1:5434/core_erp`,
          pattern: /Unapproved database "core_erp"/,
        },
        {
          url: `postgresql://erp_integration_user:${secret}@127.0.0.1:5434/core_erp_test`,
          pattern: /Unapproved database "core_erp_test"/,
        },
      ];

      for (const testCase of rejectedCases) {
        let errMessage = '';
        try {
          validateIntegrationTestDatabaseUrl(testCase.url);
        } catch (err) {
          errMessage = err instanceof Error ? err.message : String(err);
        }
        expect(errMessage).toMatch(testCase.pattern);
        expect(errMessage).not.toContain(secret);
      }
    });
  });

  describe('2. Integration Runner Child Environment & Direct Vitest Execution', () => {
    it('prepares child env with NODE_ENV=test, COREERP_INTEGRATION_TEST_MODE=true, and removes DATABASE_URL', () => {
      const baseEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://erp_user:dev_secret@localhost:5432/core_erp?schema=public',
        TEST_DATABASE_URL: ` "${validLoopbackUrl}" `,
      };

      const { childEnv } = buildIntegrationChildEnv(baseEnv);

      expect(childEnv.NODE_ENV).toBe('test');
      expect(childEnv.COREERP_INTEGRATION_TEST_MODE).toBe('true');
      expect(childEnv.DATABASE_URL).toBeUndefined();
      expect('DATABASE_URL' in childEnv).toBe(false);
      expect(childEnv.TEST_DATABASE_URL).toBe(validLoopbackUrl);
      // Base env object must not be mutated
      expect(baseEnv.DATABASE_URL).toContain(':5432/core_erp');
    });

    it('resolves local Vitest CLI JS entrypoint and invokes process.execPath directly without npx.cmd or shell: true', () => {
      const cliPath = resolveVitestCliPath();
      expect(fs.existsSync(cliPath)).toBe(true);
      expect(path.basename(cliPath)).toMatch(/vitest\.(mjs|js|cjs)$/);

      const mockSpawn = vi.fn().mockReturnValue({
        status: 0,
        signal: null,
        error: undefined,
      });
      const stderrChunks: string[] = [];
      const mockStderr = {
        write: (chunk: string) => {
          stderrChunks.push(chunk);
          return true;
        },
      };

      const exitCode = runIntegrationTests(
        ['tests/integration/concurrent-bank-account-default.test.ts'],
        {
          env: {
            DATABASE_URL: 'postgresql://erp_user:dev_pass@localhost:5432/core_erp',
            TEST_DATABASE_URL: validLoopbackUrl,
          },
          spawnFn: mockSpawn,
          execPath: '/usr/bin/node',
          vitestCliPath: cliPath,
          stderr: mockStderr,
        }
      );

      expect(exitCode).toBe(0);
      expect(stderrChunks).toEqual([]);
      expect(mockSpawn).toHaveBeenCalledTimes(1);

      const [cmd, args, spawnOpts] = mockSpawn.mock.calls[0];
      expect(cmd).toBe('/usr/bin/node');
      expect(cmd).not.toContain('npx');
      expect(args).toEqual([
        cliPath,
        'run',
        'tests/integration/concurrent-bank-account-default.test.ts',
      ]);
      expect(spawnOpts.shell).toBeUndefined();
      expect(spawnOpts.stdio).toBe('inherit');
      expect(spawnOpts.env.NODE_ENV).toBe('test');
      expect(spawnOpts.env.COREERP_INTEGRATION_TEST_MODE).toBe('true');
      expect(spawnOpts.env.DATABASE_URL).toBeUndefined();
      expect(spawnOpts.env.TEST_DATABASE_URL).toBe(validLoopbackUrl);
    });

    it('fails before spawning when TEST_DATABASE_URL is invalid and reports spawn errors, signals, and non-zero status clearly', () => {
      const mockSpawn = vi.fn();
      const stderrChunks: string[] = [];
      const mockStderr = {
        write: (chunk: string) => {
          stderrChunks.push(chunk);
          return true;
        },
      };

      // Invalid URL must abort before spawnFn is called
      const invalidCode = runIntegrationTests(['tests/integration'], {
        env: {
          TEST_DATABASE_URL:
            'postgresql://erp_user:SecretLeakCheck77@localhost:5432/core_erp',
        },
        spawnFn: mockSpawn,
        stderr: mockStderr,
      });
      expect(invalidCode).toBe(1);
      expect(mockSpawn).not.toHaveBeenCalled();
      expect(stderrChunks.join('')).toMatch(/Unapproved port "5432"/);
      expect(stderrChunks.join('')).not.toContain('SecretLeakCheck77');

      // Spawn error (e.g., EINVAL / ENOENT) must be reported clearly, never silently
      stderrChunks.length = 0;
      const einvalErr = Object.assign(new Error('spawnSync EINVAL'), { code: 'EINVAL' });
      const errCode = runIntegrationTests([], {
        env: { TEST_DATABASE_URL: validLocalhostUrl },
        spawnFn: vi.fn().mockReturnValue({ status: null, signal: null, error: einvalErr }),
        vitestCliPath: '/fake/vitest.mjs',
        stderr: mockStderr,
      });
      expect(errCode).toBe(1);
      expect(stderrChunks.join('')).toMatch(/Failed to spawn Vitest.*EINVAL.*spawnSync EINVAL/);

      // Signal termination must be reported clearly
      stderrChunks.length = 0;
      const sigCode = runIntegrationTests([], {
        env: { TEST_DATABASE_URL: validLocalhostUrl },
        spawnFn: vi.fn().mockReturnValue({ status: null, signal: 'SIGTERM', error: undefined }),
        vitestCliPath: '/fake/vitest.mjs',
        stderr: mockStderr,
      });
      expect(sigCode).toBe(1);
      expect(stderrChunks.join('')).toMatch(/terminated by signal SIGTERM/);

      // Non-zero exit status must propagate directly
      stderrChunks.length = 0;
      const failCode = runIntegrationTests([], {
        env: { TEST_DATABASE_URL: validLocalhostUrl },
        spawnFn: vi.fn().mockReturnValue({ status: 2, signal: null, error: undefined }),
        vitestCliPath: '/fake/vitest.mjs',
        stderr: mockStderr,
      });
      expect(failCode).toBe(2);
    });

    it('configures package.json integration scripts to use scripts/run-integration-tests.mjs without npx.cmd or inline node -e', () => {
      const pkg = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')
      );
      expect(pkg.scripts['test:integration']).toBe(
        'node scripts/run-integration-tests.mjs tests/integration'
      );
      expect(pkg.scripts['test:integration:concurrency']).toBe(
        'node scripts/run-integration-tests.mjs tests/integration/concurrent-bank-account-default.test.ts'
      );
      expect(pkg.scripts['test:integration:key-rotation']).toBe(
        'node scripts/run-integration-tests.mjs tests/integration/key-rotation-reencryption.test.ts'
      );

      for (const key of [
        'test:integration',
        'test:integration:concurrency',
        'test:integration:key-rotation',
      ]) {
        expect(pkg.scripts[key]).not.toContain('npx.cmd');
        expect(pkg.scripts[key]).not.toContain('node -e');
      }
    });
  });

  describe('3. tests/setup.ts Explicit Integration Mode & DB-Free Normal Mode Isolation', () => {
    it('does NOT auto-enable integration mode when TEST_DATABASE_URL (port 5434) is set without COREERP_INTEGRATION_TEST_MODE=true, and removes it after validation', () => {
      const simulatedEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        TEST_DATABASE_URL: ` "${validLoopbackUrl}" `,
      };

      const outcome = configureTestEnvironment(simulatedEnv, { config: vi.fn() });

      expect(outcome.isIntegrationMode).toBe(false);
      expect(simulatedEnv.COREERP_INTEGRATION_TEST_MODE).toBeUndefined();
      expect(simulatedEnv.TEST_DATABASE_URL).toBeUndefined();
      expect(simulatedEnv.DATABASE_URL).toBe(APPROVED_STANDARD_TEST_DB_URL);

      // Verify unit DB guard accepts the resulting normal DB-free environment
      process.env.DATABASE_URL = simulatedEnv.DATABASE_URL;
      delete process.env.TEST_DATABASE_URL;
      delete process.env.COREERP_INTEGRATION_TEST_MODE;
      expect(() => validateIsolatedUnitDbEnv()).not.toThrow();
    });

    it('still fails closed in normal DB-free mode when TEST_DATABASE_URL targets forbidden port 5432 or remote host', () => {
      expect(() =>
        configureTestEnvironment(
          {
            NODE_ENV: 'test',
            TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/core_erp',
          },
          { config: vi.fn() }
        )
      ).toThrow(/Dedicated integration test must run on port 5434/);

      expect(() =>
        configureTestEnvironment(
          {
            NODE_ENV: 'test',
            TEST_DATABASE_URL: 'postgresql://u:p@db.prod.local:5434/core_erp_integration_test',
          },
          { config: vi.fn() }
        )
      ).toThrow(/Unapproved database host in TEST_DATABASE_URL/);
    });

    it('fails closed in explicit integration mode when DATABASE_URL is defined (never silently deletes before validation)', () => {
      const simulatedEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        COREERP_INTEGRATION_TEST_MODE: 'true',
        DATABASE_URL: 'postgresql://erp_user:dev_pass@localhost:5432/core_erp',
        TEST_DATABASE_URL: validLoopbackUrl,
      };

      expect(() => configureTestEnvironment(simulatedEnv, { config: vi.fn() })).toThrow(
        /Conflicting DATABASE_URL detected in integration test mode/
      );
      // Must not have silently deleted DATABASE_URL before failing
      expect(simulatedEnv.DATABASE_URL).toBe(
        'postgresql://erp_user:dev_pass@localhost:5432/core_erp'
      );
    });

    it('normalizes TEST_DATABASE_URL and guards dotenv.config in explicit integration mode when DATABASE_URL is unset', () => {
      const simulatedEnv: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        COREERP_INTEGRATION_TEST_MODE: 'true',
        TEST_DATABASE_URL: ` '${validLocalhostUrl}' `,
      };
      const fakeDotenv = {
        config: () => {
          simulatedEnv.DATABASE_URL = 'postgresql://erp_user:dev@localhost:5432/core_erp';
          return { parsed: {} };
        },
      };

      const outcome = configureTestEnvironment(simulatedEnv, fakeDotenv);

      expect(outcome.isIntegrationMode).toBe(true);
      expect(simulatedEnv.TEST_DATABASE_URL).toBe(validLocalhostUrl);
      expect(simulatedEnv.DATABASE_URL).toBeUndefined();

      // Calling wrapped dotenv.config must still leave DATABASE_URL undefined
      fakeDotenv.config();
      expect(simulatedEnv.DATABASE_URL).toBeUndefined();
    });
  });

  describe('4. Non-Integration Prisma Client Isolation & Dotenv Contamination Prevention', () => {
    it('never selects TEST_DATABASE_URL in non-integration test mode even when DATABASE_URL is unset', () => {
      delete process.env.COREERP_INTEGRATION_TEST_MODE;
      delete process.env.DATABASE_URL;
      process.env.TEST_DATABASE_URL = validLoopbackUrl;

      const client = createPrismaClient();
      const resolvedUrl = (client as any)._engineConfig?.overrideDatasources?.db?.url;

      expect(resolvedUrl).toBe(APPROVED_STANDARD_TEST_DB_URL);
      expect(resolvedUrl).toContain(':5433/core_erp_test');
      expect(resolvedUrl).not.toContain(':5434');
      expect(resolvedUrl).not.toContain('core_erp_integration_test');
    });

    it('does not leave DATABASE_URL populated after createPrismaClient() in integration mode', () => {
      process.env.COREERP_INTEGRATION_TEST_MODE = 'true';
      delete process.env.DATABASE_URL;
      process.env.TEST_DATABASE_URL = validLoopbackUrl;

      const client = createPrismaClient();
      const resolvedUrl = (client as any)._engineConfig?.overrideDatasources?.db?.url;

      expect(resolvedUrl).toBe(validLoopbackUrl);
      expect(process.env.DATABASE_URL).toBeUndefined();
    });

    it('skips dotenv.config() during test/Vitest runtimes and removes stale port-5433 TEST_DATABASE_URL from generated .env templates', () => {
      const envSource = fs.readFileSync(
        path.resolve(process.cwd(), 'src/server/config/env.ts'),
        'utf-8'
      );
      const devSyncSource = fs.readFileSync(
        path.resolve(process.cwd(), 'src/server/db/dev-credential-sync.ts'),
        'utf-8'
      );

      expect(envSource).toMatch(/process\.env\.NODE_ENV === 'test' \|\| process\.env\.VITEST === 'true'/);
      expect(envSource).not.toContain('localhost:5433/core_erp_test');
      expect(devSyncSource).not.toContain('localhost:5433/core_erp_test');
    });
  });

  describe('5. Legacy Integration Suites Require Explicit Integration Mode & Safe Skip Behavior', () => {
    const legacySuites = [
      'tests/integration/concurrent-bank-account-default.test.ts',
      'tests/integration/key-rotation-reencryption.test.ts',
    ];

    it.each(legacySuites)(
      '%s gates strictly on COREERP_INTEGRATION_TEST_MODE === true, skips with BLOCKED / NOT RUN, rejects any defined DATABASE_URL, and clears DATABASE_URL after PrismaClient init',
      (relativePath) => {
        const source = fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf-8');

        // Explicit opt-in gate & normalized TEST_DATABASE_URL
        expect(source).toContain("process.env.COREERP_INTEGRATION_TEST_MODE === 'true'");
        expect(source).toMatch(/if \(!isIntegrationMode \|\| !testDbUrl\)/);

        // Safe skip behavior using BLOCKED / NOT RUN and ctx.skip
        expect(source).toContain('[BLOCKED / NOT RUN]');
        expect(source).toContain('ctx.skip(blockedReason)');

        // Rejects ANY defined DATABASE_URL in integration mode (not just equality with testDbUrl)
        expect(source).toMatch(/if \(process\.env\.DATABASE_URL && process\.env\.DATABASE_URL\.trim\(\) !== ''\)/);

        // Preserves strict protocol, localhost/127.0.0.1, port 5434, database name, PG 16, and current_database() guards
        expect(source).toContain("port !== 5434");
        expect(source).toContain("dbName !== 'core_erp_integration_test'");
        expect(source).toContain("host !== 'localhost' && host !== '127.0.0.1'");
        expect(source).toContain('/PostgreSQL\\s+16\\b/i');
        expect(source).toContain('SELECT current_database() AS db_name;');

        // Prevents Prisma internal dotenv loader from leaving DATABASE_URL populated
        expect(source).toContain('delete process.env.DATABASE_URL;');
        expect(source).toContain('expect(process.env.DATABASE_URL).toBeUndefined();');
      }
    );
  });
});
