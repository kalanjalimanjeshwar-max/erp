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
    it('should define postinstall, db:generate, and pre* generation hooks in package.json', () => {
      expect(packageJson.scripts).toBeDefined();
      expect(packageJson.scripts.postinstall).toBe('prisma generate');
      expect(packageJson.scripts['db:generate']).toBe('prisma generate');
      expect(packageJson.scripts.prelint).toBe('prisma generate');
      expect(packageJson.scripts.pretest).toBe('prisma generate');
      expect(packageJson.scripts.prebuild).toBe('prisma generate');
      expect(packageJson.scripts.predev).toBe('prisma generate');
    });

    it('should pin prisma and @prisma/client to identical exact compatible versions across package.json and lockfiles', () => {
      const clientVersion = packageJson.dependencies?.['@prisma/client'];
      const cliVersion = packageJson.devDependencies?.prisma;

      expect(clientVersion).toBe('6.19.3');
      expect(cliVersion).toBe('6.19.3');
      expect(clientVersion).toBe(cliVersion);

      const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
      expect(packageLock.packages?.['']?.dependencies?.['@prisma/client']).toBe('6.19.3');
      expect(packageLock.packages?.['']?.devDependencies?.prisma).toBe('6.19.3');
      expect(packageLock.packages?.['node_modules/@prisma/client']?.version).toBe('6.19.3');
      expect(packageLock.packages?.['node_modules/prisma']?.version).toBe('6.19.3');

      if (fs.existsSync(bunLockPath)) {
        const bunLockRaw = fs.readFileSync(bunLockPath, 'utf8');
        expect(bunLockRaw).toMatch(/"@prisma\/client":\s*"6\.19\.3"/);
        expect(bunLockRaw).toMatch(/"prisma":\s*"6\.19\.3"/);
      }
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

    it('should verify Dockerfile build lifecycle runs npm ci and explicit prisma generate', () => {
      const dockerfilePath = path.join(rootDir, 'Dockerfile');
      expect(fs.existsSync(dockerfilePath)).toBe(true);
      const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
      expect(dockerfile).toContain('RUN npm ci');
      expect(dockerfile).toContain('RUN npx prisma generate');
    });

    it('should exclude dist and node_modules in tsconfig.json to avoid build output scan errors', () => {
      const tsconfigPath = path.join(rootDir, 'tsconfig.json');
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
      expect(Array.isArray(tsconfig.exclude)).toBe(true);
      expect(tsconfig.exclude).toContain('node_modules');
      expect(tsconfig.exclude).toContain('dist');
    });

    it('should provide a GitHub Actions CI workflow that runs npm ci, prisma generate, tsc, tests, and build', async () => {
      const yamlModule = await import('yaml');
      const ciPath = path.join(rootDir, '.github/workflows/ci.yml');
      expect(fs.existsSync(ciPath)).toBe(true);

      const ciDoc = yamlModule.parse(fs.readFileSync(ciPath, 'utf8'));
      expect(ciDoc?.jobs?.verify?.steps).toBeDefined();

      const steps: Array<{ run?: string }> = ciDoc.jobs.verify.steps;
      const runCommands = steps.map((s) => s.run || '').filter(Boolean);

      const ciIdx = runCommands.findIndex((cmd) => cmd.includes('npm ci'));
      const genIdx = runCommands.findIndex((cmd) => cmd.includes('npm run db:generate') || cmd.includes('prisma generate'));
      const lintIdx = runCommands.findIndex((cmd) => cmd.includes('npm run lint'));
      const testIdx = runCommands.findIndex((cmd) => cmd.includes('npm test'));
      const buildIdx = runCommands.findIndex((cmd) => cmd.includes('npm run build'));

      expect(ciIdx).toBeGreaterThanOrEqual(0);
      expect(genIdx).toBeGreaterThan(ciIdx);
      expect(lintIdx).toBeGreaterThan(genIdx);
      expect(testIdx).toBeGreaterThan(genIdx);
      expect(buildIdx).toBeGreaterThan(genIdx);
    });

    it('should document clean npm ci installation and post-pull Prisma Client regeneration in README.md', () => {
      const readmePath = path.join(rootDir, 'README.md');
      const readme = fs.readFileSync(readmePath, 'utf8');
      expect(readme).toContain('npm ci');
      expect(readme).toContain('npm run db:generate');
      expect(readme).toContain('npx prisma generate');
      expect(readme).toContain('prisma/schema.prisma');
    });
  });
});

