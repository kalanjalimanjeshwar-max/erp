# CoreERP Verification Baseline Report

- **Date:** 2026-11-25
- **Repository Branch:** `main`
- **Baseline Merge Commit:** `10fb7ff`
- **Verification Environment:** Windows local workstation with isolated Docker PostgreSQL 16 integration container
- **Scope:** Engineering verification baseline covering Git synchronization, TypeScript/lint validation, isolated unit tests, PostgreSQL 16 integration tests, and production bundle compilation.

---

## 1. Executive Summary

| Verification Gate | Command | Status | Summary |
| :--- | :--- | :--- | :--- |
| **Git Synchronization** | Merge & push (`main` / `origin/main`) | **Verified (Passed)** | Merge commit `10fb7ff` pushed to GitHub; local `main` and `origin/main` synchronized. |
| **TypeScript / Lint** | `npm.cmd run lint` | **Verified (Passed)** | Zero TypeScript errors. |
| **Unit Tests** | `npx.cmd vitest run tests/unit` | **Verified (Passed)** | 72/72 test files passed; 1,204 passed, 0 failed, 0 skipped. |
| **PostgreSQL 16 Integration Tests** | `npm.cmd run test:integration` | **Verified (Passed)** | 12/12 test files passed; 35 passed, 0 failed, 0 skipped (including 4/4 Auth & RBAC integration tests). |
| **Production Build** | `npm.cmd run build` | **Verified (Passed with Advisory Warning)** | Prisma Client generated; Vite build succeeded in 966 ms (1,722 modules, 0 errors; non-blocking large JS chunk warning recorded). |
| **Real Application Business Workflows (Next Stage)** | — | **Not Yet Verified** | End-to-end interactive business workflows have not yet undergone next-stage verification. |
| **Staging / Production Deployment & Runtime Validation** | — | **Not Verified / Not Claimed** | Neither staging verification sign-off, production deployment, nor production runtime validation has been performed. |

---

## 2. Verified Baseline Results

### 2.1 Git & Working Tree State

- Local `main` was cleanly merged with `origin/main`.
- **Merge Commit:** `10fb7ff`
- Merged changes were successfully pushed to GitHub.
- Local `main` and `origin/main` were confirmed synchronized after push.
- **Intentionally Preserved Untracked Files (Untouched):**
  - `bridges/essl-x2008-bridge/bridge.config.json`
  - `bridges/essl-x2008-bridge/data/`

### 2.2 TypeScript / Lint Check

- **Command:** `npm.cmd run lint`
- **Result:** **Passed**
- **Errors:** `0` TypeScript errors.

### 2.3 Isolated Unit Test Suite

- **Command:** `npx.cmd vitest run tests/unit`
- **Test Files:** `72` passed, `0` failed (`72` total)
- **Tests:** `1,204` passed, `0` failed, `0` skipped (`1,204` total)

### 2.4 PostgreSQL 16 Integration Test Suite

- **Command:** `npm.cmd run test:integration` (executed with `TEST_DATABASE_URL` targeting the isolated PostgreSQL 16 integration database at `localhost:5434/core_erp_integration_test`, with `DATABASE_URL` unset by the integration runner)
- **Target Environment:** Isolated PostgreSQL 16 integration database (`localhost:5434/core_erp_integration_test`)
- **Test Files:** `12` passed, `0` failed (`12` total)
- **Tests:** `35` passed, `0` failed, `0` skipped (`35` total)
- **Authentication & RBAC Integration Tests (`tests/integration/auth-rbac-endpoints.test.ts`):** `4` passed (`0` failed, `0` skipped)

### 2.5 Production Build

- **Command:** `npm.cmd run build`
- **Prisma Client Generation:** Passed
- **Vite Production Build:** Passed
- **Modules Transformed:** `1,722`
- **Build Duration:** `966 ms`
- **Build Errors:** `0`
- **Recorded Advisory Warning (Non-Failing):**
  - JavaScript bundle size: `2,275.29 kB` (`gzip: 460.75 kB`)
  - Chunks exceed Vite's `500 kB` post-minification advisory threshold.
  - Classified as an advisory optimization warning only — **not** a build failure.

---

## 3. Items Not Yet Tested (Explicit Scope Boundaries)

This baseline records automated build, static type-check, unit test, and isolated PostgreSQL 16 integration test verification only. The following areas have **not** been tested as part of this baseline and remain pending:

1. **Real Application Business Workflows (Next-Stage Verification Pending):**
   - Full end-to-end interactive business workflows across the running web UI and API (initial setup/onboarding, company administration, double-entry accounting & financial reporting, quotations/invoicing/receipts, employee lifecycle, work-policy revisions, attendance/leave/payroll runs, expense claims, and document exports) have **not yet undergone this next-stage verification**.
2. **Physical Biometric Bridge / Hardware Integration:**
   - Live LAN communication and end-to-end punch synchronization with physical eSSL hardware using the local biometric bridge (`bridges/essl-x2008-bridge/`) have not been verified in this baseline.
3. **Staging Environment Verification:**
   - Full staging pre-flight rehearsal (`docs/staging-verification-guide.md`) against a dedicated staging environment has not been signed off in this baseline.
4. **Production Deployment & Production Runtime Validation (Not Claimed):**
   - This report does **not** claim production deployment, production database migration execution, live production runtime validation, reverse-proxy/TLS/cookie verification, load/stress testing, or backup/recovery drills.
5. **Frontend Bundle Splitting Optimization:**
   - Resolving the advisory `2,275.29 kB` (`460.75 kB` gzip) JavaScript bundle size warning via route/module code-splitting remains a deferred optimization item.

---

## 4. Baseline Integrity Notice

- This document serves as a permanent point-in-time verification baseline anchored at verified merge commit `10fb7ff` on `2026-11-25`; the Git synchronization state described in Section 2.1 reflects the repository state at that commit before this report file was added.
- No application source code, business logic, authentication/RBAC rules, database state, environment files, Docker configurations, or Git history were modified when recording this report.
