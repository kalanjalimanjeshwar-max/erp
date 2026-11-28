#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const vitePackageJsonPath = require.resolve('vite/package.json');
const vitePackageJson = JSON.parse(fs.readFileSync(vitePackageJsonPath, 'utf8'));
const viteBinRelative =
  typeof vitePackageJson.bin === 'string'
    ? vitePackageJson.bin
    : vitePackageJson.bin?.vite;

if (!viteBinRelative) {
  console.error('[build-production] Unable to locate Vite CLI binary in vite/package.json.');
  process.exit(1);
}

const viteBinPath = path.resolve(path.dirname(vitePackageJsonPath), viteBinRelative);
const extraArgs = process.argv.slice(2);

const result = spawnSync(process.execPath, [viteBinPath, 'build', ...extraArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
  },
});

if (result.error) {
  console.error('[build-production] Failed to invoke Vite build:', result.error);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 0);
