import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import YAML from 'yaml';

describe('Docker Compose YAML Parsing & Fail-Closed Security Validation', () => {
  const rootDir = process.cwd();
  const prodComposePath = path.join(rootDir, 'docker-compose.yml');
  const devComposePath = path.join(rootDir, 'docker-compose.dev.yml');
  const integrationComposePath = path.join(rootDir, 'docker-compose.integration-test.yml');
  const stagingComposePath = path.join(rootDir, 'docker-compose.staging.yml');

  it('should parse docker-compose.yml without any YAML scanner or mapping errors', () => {
    const rawYaml = fs.readFileSync(prodComposePath, 'utf8');
    expect(() => YAML.parse(rawYaml)).not.toThrow();
    const doc = YAML.parse(rawYaml);
    expect(doc).toBeDefined();
    expect(doc.services).toBeDefined();
    expect(doc.services.app).toBeDefined();
    expect(doc.services.migration).toBeDefined();
    expect(doc.services.postgres).toBeDefined();
  });

  it('should parse docker-compose.dev.yml without any YAML scanner errors', () => {
    const rawYaml = fs.readFileSync(devComposePath, 'utf8');
    expect(() => YAML.parse(rawYaml)).not.toThrow();
    const doc = YAML.parse(rawYaml);
    expect(doc.services.postgres).toBeDefined();
    expect(doc.services['postgres-test']).toBeDefined();
    expect(doc.services['postgres-shadow']).toBeDefined();
    expect(doc.services['postgres-shadow'].profiles).toEqual(['shadow']);
  });

  it('should parse docker-compose.integration-test.yml without any YAML scanner errors', () => {
    const rawYaml = fs.readFileSync(integrationComposePath, 'utf8');
    expect(() => YAML.parse(rawYaml)).not.toThrow();
    const doc = YAML.parse(rawYaml);
    expect(doc.services['postgres-integration-test']).toBeDefined();
  });

  it('should parse docker-compose.staging.yml without any YAML scanner errors', () => {
    const rawYaml = fs.readFileSync(stagingComposePath, 'utf8');
    expect(() => YAML.parse(rawYaml)).not.toThrow();
    const doc = YAML.parse(rawYaml);
    expect(doc.services['postgres-staging']).toBeDefined();
    expect(doc.services['postgres-staging'].image).toBe('postgres:16-alpine');
    expect(doc.services['postgres-staging'].container_name).toBe('coreerp-postgres-staging');
    expect(doc.services['postgres-staging'].restart).toBe('unless-stopped');
    expect(doc.services['postgres-staging'].healthcheck).toBeDefined();
    expect(doc.volumes.postgres_staging_data).toBeDefined();
  });

  it('should guarantee no unquoted ${...} expressions contain colons followed by spaces in any compose file', () => {
    const files = [prodComposePath, devComposePath, integrationComposePath, stagingComposePath];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        // Strip comments
        const lineWithoutComment = line.split('#')[0];
        // If line contains ${...} and is unquoted (i.e. does not have ": \"" or similar quote wrapper)
        const match = lineWithoutComment.match(/:\s+(\$\{[^}]+\})/);
        if (match) {
          const unquotedExpr = match[1];
          // If unquoted expression contains ": ", it causes YAML syntax error
          expect(
            unquotedExpr.includes(': '),
            `Unquoted variable interpolation containing ": " found at ${path.basename(file)}:${idx + 1}: ${line}`
          ).toBe(false);
        }
      });
    }
  });

  describe('SESSION_SECRET Fail-Closed Security Requirements', () => {
    it('should strictly enforce fail-closed interpolation for SESSION_SECRET in docker-compose.yml', () => {
      const rawYaml = fs.readFileSync(prodComposePath, 'utf8');
      const doc = YAML.parse(rawYaml);
      const appEnv = doc.services.app.environment;

      expect(appEnv.SESSION_SECRET).toBeDefined();
      expect(typeof appEnv.SESSION_SECRET).toBe('string');

      // Must use :? fail-closed syntax, NOT :- or default fallbacks
      expect(appEnv.SESSION_SECRET).toContain('${SESSION_SECRET:?');
      expect(appEnv.SESSION_SECRET).not.toContain('${SESSION_SECRET:-');
      expect(appEnv.SESSION_SECRET).toContain('SESSION_SECRET must be explicitly set with a high-entropy string');
    });

    it('should verify that SESSION_SECRET in raw docker-compose.yml is properly quoted', () => {
      const rawYaml = fs.readFileSync(prodComposePath, 'utf8');
      const sessionSecretLine = rawYaml
        .split('\n')
        .find((l) => l.includes('SESSION_SECRET:'));

      expect(sessionSecretLine).toBeDefined();
      // Must be enclosed in double quotes so YAML scanner does not treat ": " as mapping separator
      expect(sessionSecretLine).toMatch(/SESSION_SECRET:\s*"[^"]+"/);
    });

    it('should correctly simulate Docker Compose fail-closed error when SESSION_SECRET is unset', () => {
      const rawYaml = fs.readFileSync(prodComposePath, 'utf8');
      const doc = YAML.parse(rawYaml);
      const expr = doc.services.app.environment.SESSION_SECRET;

      // Docker Compose variable interpolation logic simulation
      // Format: ${VAR:?error_message}
      const match = expr.match(/^\$\{([a-zA-Z0-9_]+):\?(.*)\}$/);
      expect(match).not.toBeNull();
      const [, varName, errorMessage] = match!;

      expect(varName).toBe('SESSION_SECRET');
      expect(errorMessage).toContain('SESSION_SECRET must be explicitly set with a high-entropy string');

      // Verify that missing/empty evaluation produces the error
      function evaluateInterpolation(env: Record<string, string | undefined>): string {
        const val = env[varName];
        if (!val || val.trim() === '') {
          throw new Error(errorMessage);
        }
        return val;
      }

      // Empty env must fail-closed
      expect(() => evaluateInterpolation({})).toThrowError(/SESSION_SECRET must be explicitly set/);
      expect(() => evaluateInterpolation({ SESSION_SECRET: '' })).toThrowError(/SESSION_SECRET must be explicitly set/);

      // Valid secret must pass
      const testSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      expect(evaluateInterpolation({ SESSION_SECRET: testSecret })).toBe(testSecret);
    });
  });

  describe('Integration Test Database Isolation & Fail-Closed Secrets', () => {
    it('should enforce fail-closed POSTGRES_PASSWORD in docker-compose.integration-test.yml', () => {
      const rawYaml = fs.readFileSync(integrationComposePath, 'utf8');
      const doc = YAML.parse(rawYaml);
      const pgEnv = doc.services['postgres-integration-test'].environment;

      expect(pgEnv.POSTGRES_PASSWORD).toBeDefined();
      expect(pgEnv.POSTGRES_PASSWORD).toContain('${POSTGRES_PASSWORD:?');

      const rawLine = rawYaml
        .split('\n')
        .find((l) => l.includes('POSTGRES_PASSWORD:'));
      expect(rawLine).toMatch(/POSTGRES_PASSWORD:\s*"[^"]+"/);
    });

    it('should enforce fail-closed staging credentials in docker-compose.staging.yml', () => {
      const rawYaml = fs.readFileSync(stagingComposePath, 'utf8');
      const doc = YAML.parse(rawYaml);
      const pgEnv = doc.services['postgres-staging'].environment;

      expect(pgEnv.POSTGRES_USER).toContain('${STAGING_POSTGRES_USER:?');
      expect(pgEnv.POSTGRES_PASSWORD).toContain('${STAGING_POSTGRES_PASSWORD:?');
      expect(pgEnv.POSTGRES_DB).toContain('${STAGING_POSTGRES_DB:?');

      for (const key of ['POSTGRES_USER:', 'POSTGRES_PASSWORD:', 'POSTGRES_DB:']) {
        const rawLine = rawYaml.split('\n').find((l) => l.includes(key));
        expect(rawLine).toMatch(/:\s*"[^"]+"/);
      }
    });

    it('should verify isolated port and volume allocations across all five PostgreSQL environments', () => {
      const prodDoc = YAML.parse(fs.readFileSync(prodComposePath, 'utf8'));
      const devDoc = YAML.parse(fs.readFileSync(devComposePath, 'utf8'));
      const testDoc = YAML.parse(fs.readFileSync(integrationComposePath, 'utf8'));
      const stagingDoc = YAML.parse(fs.readFileSync(stagingComposePath, 'utf8'));

      // Prod DB must not publish host ports and must attach only to the internal DB network
      expect(prodDoc.services.postgres.ports).toBeUndefined();
      expect(prodDoc.services.postgres.networks).toEqual(['coreerp-db-internal']);
      expect(prodDoc.networks['coreerp-db-internal']).toMatchObject({
        driver: 'bridge',
        internal: true,
      });
      expect(prodDoc.services.migration.networks).toEqual(['coreerp-db-internal']);
      expect(prodDoc.services.app.networks).toEqual(['coreerp-db-internal', 'coreerp-edge']);
      expect(prodDoc.services.app.ports).toEqual(['127.0.0.1:${APP_BIND_PORT:-3000}:3000']);
      expect(prodDoc.networks['coreerp-edge']).toMatchObject({ driver: 'bridge' });

      // Five strictly distinct local host ports (5432, 5433, 5434, 5435, 5436)
      expect(devDoc.services.postgres.ports).toContain('5432:5432');
      expect(devDoc.services['postgres-test'].ports).toContain('5433:5432');
      expect(testDoc.services['postgres-integration-test'].ports).toContain('5434:5432');
      expect(stagingDoc.services['postgres-staging'].ports).toContain('5435:5432');
      expect(devDoc.services['postgres-shadow'].ports).toContain('5436:5432');

      // Five strictly distinct named volumes (never shared across environments)
      const volumes = [
        devDoc.services.postgres.volumes[0].split(':')[0],
        devDoc.services['postgres-test'].volumes[0].split(':')[0],
        testDoc.services['postgres-integration-test'].volumes[0].split(':')[0],
        stagingDoc.services['postgres-staging'].volumes[0].split(':')[0],
        devDoc.services['postgres-shadow'].volumes[0].split(':')[0],
      ];
      expect(volumes).toEqual([
        'postgres_dev_data',
        'postgres_test_data',
        'postgres_integration_test_data',
        'postgres_staging_data',
        'postgres_shadow_data',
      ]);
      expect(new Set(volumes).size).toBe(5);
    });
  });

  describe('Fresh Clean-Environment Installation & Variable Resolution', () => {
    it('should successfully resolve all Compose environment interpolations from a clean .env.example setup', () => {
      const exampleContent = fs.readFileSync(path.join(rootDir, '.env.example'), 'utf8');

      // Simulate clean setup: generating required production secrets without pre-existing env vars
      const simulatedSessionSecret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
      const simulatedBankKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const simulatedDbPass = 'StrongProductionPassword999!';

      const cleanEnv = exampleContent
        .replace('replace_with_64_character_cryptographically_secure_random_string', simulatedSessionSecret)
        .replace('replace_with_64_character_hex_bank_encryption_key_256_bit', simulatedBankKey)
        .replace('replace_with_strong_password', simulatedDbPass);

      const parsedEnv: Record<string, string> = {};
      for (const line of cleanEnv.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim();
            let val = trimmed.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            parsedEnv[key] = val;
          }
        }
      }

      // Verify mandatory secrets are present
      expect(parsedEnv.SESSION_SECRET).toBe(simulatedSessionSecret);
      expect(parsedEnv.BANK_ENCRYPTION_KEY).toBe(simulatedBankKey);
      expect(parsedEnv.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
      expect(parsedEnv.BANK_ENCRYPTION_KEY).toMatch(/^[0-9a-fA-F]{64}$/);

      // Verify docker-compose.yml can resolve SESSION_SECRET
      const prodDoc = YAML.parse(fs.readFileSync(prodComposePath, 'utf8'));
      const expr = prodDoc.services.app.environment.SESSION_SECRET;
      const match = expr.match(/^\$\{([a-zA-Z0-9_]+):\?(.*)\}$/);
      expect(match).not.toBeNull();
      const [, varName] = match!;
      expect(parsedEnv[varName]).toBe(simulatedSessionSecret);
    });
  });
});

