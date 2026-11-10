import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

describe('Dependency & Lockfile Integrity Validation', () => {
  const rootDir = process.cwd();
  const packageJsonPath = path.join(rootDir, 'package.json');
  const packageLockPath = path.join(rootDir, 'package-lock.json');
  const bunLockPath = path.join(rootDir, 'bun.lock');

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  it('should successfully resolve and load the yaml package in the Node runtime', async () => {
    // Verify module is resolvable via standard Node resolution
    const resolvedPath = require.resolve('yaml');
    expect(resolvedPath).toBeDefined();
    expect(resolvedPath.length).toBeGreaterThan(0);

    // Verify dynamic import
    const yamlModule = await import('yaml');
    expect(yamlModule).toBeDefined();
    expect(typeof yamlModule.parse).toBe('function');
    expect(typeof yamlModule.stringify).toBe('function');

    // Functional verification
    const parsed = yamlModule.parse('foo: bar\ncount: 42');
    expect(parsed).toEqual({ foo: 'bar', count: 42 });
  });

  it('should declare yaml with a compatible version in package.json devDependencies', () => {
    expect(packageJson.devDependencies).toBeDefined();
    expect(packageJson.devDependencies.yaml).toBeDefined();
    // Must be ^2.x.x (modern, active YAML 1.2 parser compatible with Docker Compose)
    expect(packageJson.devDependencies.yaml).toMatch(/^\^2\./);
  });

  it('should guarantee package-lock.json is synchronized with package.json (no lockfile drift)', () => {
    expect(fs.existsSync(packageLockPath)).toBe(true);
    const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));

    // 1. Verify root package devDependencies in lockfile
    const rootPackage = packageLock.packages?.[''];
    expect(rootPackage).toBeDefined();
    expect(rootPackage.devDependencies).toBeDefined();
    expect(rootPackage.devDependencies.yaml).toBe(packageJson.devDependencies.yaml);

    // 2. Verify resolved node_modules/yaml entry exists in lockfile
    const yamlEntry = packageLock.packages?.['node_modules/yaml'];
    expect(yamlEntry).toBeDefined();
    expect(yamlEntry.version).toBeDefined();
    expect(yamlEntry.version).toMatch(/^2\./);
    expect(yamlEntry.dev || yamlEntry.devOptional).toBeTruthy();

    // 3. Comprehensive lockfile drift check: all package.json dependencies must exist in lockfile
    const allDeclaredDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    for (const depName of Object.keys(allDeclaredDeps)) {
      const lockKey = `node_modules/${depName}`;
      expect(
        packageLock.packages?.[lockKey],
        `Lockfile drift detected: "${depName}" is in package.json but missing from package-lock.json`
      ).toBeDefined();
    }
  });

  it('should guarantee bun.lock is synchronized with package.json when present', () => {
    if (!fs.existsSync(bunLockPath)) {
      // Optional if project is purely npm-only
      return;
    }

    const bunLockRaw = fs.readFileSync(bunLockPath, 'utf8');
    // Verify yaml is present in bun.lock devDependencies and packages
    expect(bunLockRaw).toMatch(/"yaml":\s*"\^2\./);
    expect(bunLockRaw).toContain('"yaml": ["yaml@2.');
  });

  describe('Prisma Client Lifecycle & Clean-Install Reliability', () => {
    it('should define postinstall script running prisma generate in package.json', () => {
      expect(packageJson.scripts).toBeDefined();
      expect(packageJson.scripts.postinstall).toBe('prisma generate');
      expect(packageJson.scripts['db:generate']).toBe('prisma generate');
    });

    it('should confirm Prisma Client is generated and initialized in the node runtime', async () => {
      // Verify generated client schema/artifacts exist on filesystem
      const prismaClientDir = path.resolve(rootDir, 'node_modules/.prisma/client');
      const hasSchema = fs.existsSync(path.join(prismaClientDir, 'schema.prisma'));
      const hasIndex = fs.existsSync(path.join(prismaClientDir, 'index.js'));
      expect(hasSchema || hasIndex).toBe(true);

      // Verify that PrismaClient can be instantiated without throwing initialization errors
      const { PrismaClient } = await import('@prisma/client');
      expect(PrismaClient).toBeDefined();

      expect(() => {
        const client = new PrismaClient({
          datasources: {
            db: {
              url: 'postgresql://erp_test_user:test_pass@localhost:5433/core_erp_test?schema=public',
            },
          },
        });
        expect(client).toBeDefined();
      }).not.toThrowError(/did not initialize yet/);
    });

    it('should verify tests/setup.ts safely exports isPrismaClientInitialized guard', async () => {
      const { isPrismaClientInitialized } = await import('../setup.js');
      expect(typeof isPrismaClientInitialized).toBe('function');
      expect(isPrismaClientInitialized()).toBe(true);
    });

    it('should verify Dockerfile build lifecycle runs npm ci which triggers postinstall', () => {
      const dockerfilePath = path.join(rootDir, 'Dockerfile');
      expect(fs.existsSync(dockerfilePath)).toBe(true);
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      expect(dockerfile).toContain('RUN npm ci');
    });
  });
});

