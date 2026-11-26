# CoreERP Isolated PostgreSQL Staging Verification Guide (Phase 8.7)

## 1. Executive Summary & Purpose

CoreERP has achieved complete functional coverage, high-entropy secret validation, non-destructive migration ordering, and full static type safety across its entire stack. 

However, all automated tests executed to date have been **mocked unit tests** or **offline integration tests** verifying application behavior when the database is unavailable. **The application has not yet been verified against a live, running PostgreSQL database instance.**

This guide outlines the **safe, isolated PostgreSQL staging verification procedure**. It is designed to be executed only when the user explicitly authorizes live staging verification, ensuring zero risk to production data or existing infrastructure.

---

## 2. Fundamental Safety Guardrails

To prevent accidental data loss, schema corruption, or unintended modifications:

1. **Dedicated Disposable Staging Database Target Only (`core_erp_staging`)**:
   - Verification runs **exclusively** against the dedicated staging database (`core_erp_staging` on host port `5435` locally, or an isolated remote `core_erp_staging` instance).
   - The tooling (`npm run db:verify:staging`) **strictly refuses** to run if:
     - `STAGING_DATABASE_URL` is missing or empty (**never** falls back to `DATABASE_URL` or `TEST_DATABASE_URL`).
     - The target database URL resolves to the same endpoint as `DATABASE_URL`, `TEST_DATABASE_URL`, or `SHADOW_DATABASE_URL`.
     - The database name is a production, test, integration-test, or shadow name (`core_erp`, `core_erp_test`, `core_erp_integration_test`, `core_erp_shadow`, `prod`, `production`, `main`, `live`).
     - A loopback target uses a port reserved for another environment (`5432` dev, `5433` automated test, `5434` integration test, `5436` shadow).

2. **Prohibited Destructive Operations**:
   - `prisma migrate reset` is **strictly prohibited**.
   - `prisma db push` is **strictly prohibited**.
   - Raw `DROP DATABASE`, `DROP TABLE`, or destructive SQL scripts are **strictly prohibited**.

3. **Explicit User Approval Required**:
   - Running `npm run db:verify:staging` without `--execute` performs dry-run pre-flight validation only (no live database connections, Docker mutations, or migrations).
   - Live execution occurs only when explicitly invoked with `--execute` after user authorization.

---

## 3. Dedicated Staging Database Architecture Options

### Option A: Local Dedicated Staging Docker Container (`docker-compose.staging.yml` — Recommended)
CoreERP defines a dedicated, isolated staging PostgreSQL 16 service (`postgres-staging`) in `docker-compose.staging.yml` on port `5435` with its own volume (`postgres_staging_data`) and fail-closed credentials in git-ignored `.env.staging`:

```yaml
# From docker-compose.staging.yml
postgres-staging:
  image: postgres:16-alpine
  container_name: coreerp-postgres-staging
  restart: unless-stopped
  environment:
    POSTGRES_USER: "${STAGING_POSTGRES_USER:?STAGING_POSTGRES_USER must be set in .env.staging}"
    POSTGRES_PASSWORD: "${STAGING_POSTGRES_PASSWORD:?STAGING_POSTGRES_PASSWORD must be set in .env.staging}"
    POSTGRES_DB: "${STAGING_POSTGRES_DB:?STAGING_POSTGRES_DB must be set in .env.staging (core_erp_staging)}"
    TZ: UTC
    PGTZ: UTC
  ports:
    - "5435:5432"
  volumes:
    - postgres_staging_data:/var/lib/postgresql/data
```

> **Five-Environment Host Port Separation**:
> - **Port 5432**: Development database (`docker-compose.dev.yml` → `postgres` / `core_erp`)
> - **Port 5433**: Automated test database (`docker-compose.dev.yml` → `postgres-test` / `core_erp_test`)
> - **Port 5434**: Integration test database (`docker-compose.integration-test.yml` → `postgres-integration-test` / `core_erp_integration_test`)
> - **Port 5435**: Dedicated staging verification database (`docker-compose.staging.yml` → `postgres-staging` / `core_erp_staging`)
> - **Port 5436**: Optional Prisma shadow database (`docker-compose.dev.yml --profile shadow` → `postgres-shadow` / `core_erp_shadow`)

**Initialize `.env.staging` cleanly (idempotent — never overwrites existing files)**:
```bash
npm run db:setup
```

**Target Connection String** (auto-generated into `.env.staging` by `npm run db:setup`):
```bash
STAGING_DATABASE_URL="postgresql://erp_staging_user:<unique_staging_password>@localhost:5435/core_erp_staging?schema=public"
```

### Option B: Ephemeral Cloud Staging Branch
If verifying in cloud environments (e.g. Neon, Supabase, Cloud SQL):
- Create a dedicated disposable branch or database named `core_erp_staging`.
- Ensure SSL is configured (`?sslmode=require`).
- **Never** point to the production database.

### Distinction: Local Disposable Integration Testing (Port 5434) vs. Staging Verification (Port 5435 / Cloud Staging)
CoreERP intentionally separates **local disposable PostgreSQL 16 integration testing** (`localhost:5434` / `core_erp_integration_test`) from **local development** (`localhost:5432` / `core_erp`), **automated unit test DB** (`localhost:5433` / `core_erp_test`), **Prisma shadow DB** (`localhost:5436` / `core_erp_shadow`), and **dedicated staging verification** (`localhost:5435` / `core_erp_staging` or an ephemeral remote `core_erp_staging` instance):

| Dimension | Local Disposable Integration Testing | Staging Verification |
| :--- | :--- | :--- |
| **Purpose** | Automated real-PostgreSQL Vitest concurrency, constraint, trigger, HTTP authorization/payroll-lock, and rollback suites | End-to-end release pre-flight, migration deployment, health/readiness probes, and operational verification |
| **Compose File / Target** | `docker-compose.integration-test.yml` (`postgres-integration-test`) | `docker-compose.staging.yml` (`postgres-staging`) or dedicated ephemeral `core_erp_staging` instance |
| **Host Port / DB Name** | `localhost:5434` / `core_erp_integration_test` (`erp_integration_user`) — distinct from dev port `5432` (`core_erp`) | `localhost:5435` / `core_erp_staging` (`erp_staging_user`) or remote `core_erp_staging` — distinct from `5432`/`5433`/`5434`/`5436` |
| **Safety Guard Layer** | `tests/setup.ts` + `src/server/db/client.ts` + `src/server/config/env.ts` (`COREERP_INTEGRATION_TEST_MODE=true`, `TEST_DATABASE_URL` on `5434` only, `DATABASE_URL` unset) | `npm run db:verify:staging` (`src/server/db/staging-safety.ts` via `STAGING_DATABASE_URL` exclusively) |
| **Secret File** | Git-ignored `.env.integration-test` (`POSTGRES_PASSWORD`) | Git-ignored `.env.staging` (`STAGING_POSTGRES_*`, `STAGING_DATABASE_URL`) |

> **Database Isolation Guard Responsibilities (Port 5434):**
> - `tests/setup.ts` retains responsibility for enabling `COREERP_INTEGRATION_TEST_MODE=true`, unsetting `DATABASE_URL`, wrapping `dotenv.config()`, and validating `TEST_DATABASE_URL` before test execution.
> - `src/server/db/client.ts` retains responsibility for preventing split-brain database routing (rejecting any non-empty `DATABASE_URL` in integration mode) and validating `TEST_DATABASE_URL` before initializing or binding the integration Prisma client.
> - `src/server/config/env.ts` provides an additional independent integration-mode environment validation layer: it permits `DATABASE_URL` omission strictly when `NODE_ENV=test` and `COREERP_INTEGRATION_TEST_MODE=true`, rejects any non-empty `DATABASE_URL` in that mode, and independently validates `TEST_DATABASE_URL` against `localhost`/`127.0.0.1`, port `5434`, and database `core_erp_integration_test` (allowing real authenticated HTTP integration suites to call `getConfig()` without weakening production or development `DATABASE_URL` requirements).

#### Dedicated PostgreSQL 16 Integration-Test Workflow (Port 5434)
When explicitly authorized on a host with Docker Engine installed:

1. **Create git-ignored `.env.integration-test`** with a dedicated disposable `POSTGRES_PASSWORD`:
   ```env
   POSTGRES_PASSWORD=<disposable_integration_password>
   ```
2. **Start the isolated PostgreSQL 16 integration container** (must include `--env-file .env.integration-test`):
   ```bash
   docker compose --env-file .env.integration-test -f docker-compose.integration-test.yml up -d
   docker compose --env-file .env.integration-test -f docker-compose.integration-test.yml ps
   ```
3. **Deploy all 17 version-controlled Prisma migrations** to port `5434` only (pass `DATABASE_URL` inline for the explicitly targeted `prisma migrate deploy` and `prisma migrate status` commands only; do not leave it exported for Vitest):
   ```bash
   DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx prisma migrate deploy
   DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx prisma migrate status
   ```
4. **Run targeted PostgreSQL 16 integration suites** (ensure `DATABASE_URL` remains unset; never run `npm test` with `TEST_DATABASE_URL` targeting port `5434`, as isolated unit tests intentionally reject `COREERP_INTEGRATION_TEST_MODE=true` and port `5434`):
   ```bash
   # Dedicated npm scripts (set COREERP_INTEGRATION_TEST_MODE=true and unset DATABASE_URL):
   TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npm run test:integration:concurrency
   TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npm run test:integration:key-rotation

   # Targeted Vitest commands for all seven PostgreSQL 16 integration suites (with DATABASE_URL unset):
   COREERP_INTEGRATION_TEST_MODE=true TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx vitest run tests/integration/concurrent-bank-account-default.test.ts
   COREERP_INTEGRATION_TEST_MODE=true TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx vitest run tests/integration/concurrent-biometric-punch-ingestion.test.ts
   COREERP_INTEGRATION_TEST_MODE=true TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx vitest run tests/integration/concurrent-punch-reconciliation.test.ts
   COREERP_INTEGRATION_TEST_MODE=true TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx vitest run tests/integration/key-rotation-reencryption.test.ts
   COREERP_INTEGRATION_TEST_MODE=true TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx vitest run tests/integration/work-policy-revision-constraints.test.ts
   COREERP_INTEGRATION_TEST_MODE=true TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx vitest run tests/integration/company-profile-transaction-rollback.test.ts
   COREERP_INTEGRATION_TEST_MODE=true TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npx vitest run tests/integration/attendance-authorization-and-payroll-lock.test.ts
   ```
5. **Stop only the integration container** when finished (preserve volumes unless explicitly approved):
   ```bash
   docker compose --env-file .env.integration-test -f docker-compose.integration-test.yml stop postgres-integration-test
   ```

---

## 4. Step-by-Step Staging Verification Workflow

When authorized by the user, execute the following steps in sequence:

### Step 1: Pre-Flight Safety Verification
Run the CoreERP staging safety validator:
```bash
# Validates target URL against safety guardrails without touching the database
npm run db:verify:staging
```

Expected result:
```
✔ Safety validation PASSED for database "core_erp_staging".
✔ Target is confirmed isolated and disposable (non-production).
✔ Discovered 17 versioned migration directories.
```

To execute all 6 automated staging verification checks end-to-end against an explicitly validated, running disposable PostgreSQL staging target (with zero application data mutation and `DISABLE_AUTO_CHECKOUT_SCHEDULER=true` on the temporary probe server):
```bash
# Automatically loads STAGING_* from .env.staging when STAGING_DATABASE_URL is not overridden in shell:
npm run db:verify:staging -- --execute
# Or with an explicit staging connection string:
STAGING_DATABASE_URL="postgresql://erp_staging_user:<password>@localhost:5435/core_erp_staging?schema=public" npm run db:verify:staging -- --execute
```
The automated runner executes:
1. Target URL & primary `DATABASE_URL`/`TEST_DATABASE_URL`/`SHADOW_DATABASE_URL` isolation validation (fails closed on any ambiguity; never falls back to `DATABASE_URL` or `TEST_DATABASE_URL`).
2. TCP socket reachability check (exits with code `2` before running Prisma if unreachable).
3. `prisma migrate deploy`, `prisma migrate status`, live `current_database()` identity verification, and `_prisma_migrations` integrity validation against all 17 repository migration directories.
4. Read-only PostgreSQL catalog verification for unique indexes (`Company_code_key`, `User_companyId_email_key`, `Attendance_companyId_employeeId_workDate_key`), schema-backed `Decimal` precision (`CurrencyConfig.exchangeRate` `(18, 6)` and `JournalEntry`/`JournalLine` `(18, 4)`), and `AttendanceSource` enum values (`MANUAL`, `BIOMETRIC`, `SYSTEM_GENERATED`). No application rows are seeded, truncated, deleted, reset, or modified.
5. Isolated staging server startup on an ephemeral loopback port to validate `GET /api/health` (`200`, `status="ok"`) and `GET /api/ready` (`200`, `status="ready"`, `checks.postgres.status="connected"`).
6. Graceful `SIGTERM` shutdown verification confirming HTTP server closure and `prisma.$disconnect()`.

### Step 2: Start Isolated Staging Database Container (User Authorized)
```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d
```
Wait for healthy status:
```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml ps
```

### Step 3: Verify Ordered Migration Application
Inspect the migration status before applying:
```bash
DATABASE_URL="$STAGING_DATABASE_URL" npx prisma migrate status
```

Apply all version-controlled migrations in exact historical sequence:
```bash
DATABASE_URL="$STAGING_DATABASE_URL" npx prisma migrate deploy
```

Verify that all 17 version-controlled migrations applied cleanly:
1. `20261011000000_init`
2. `20261011120000_core_tenant_foundation`
3. `20261011180000_auth_rbac_company_admin`
4. `20261012000000_core_accounting_engine`
5. `20261012120000_quotations_billing_receipts`
6. `20261012180000_employee_management_salary`
7. `20261013000000_attendance_shift_leave_payroll`
8. `20261019000000_biometric_terminals_and_raw_punches`
9. `20261030000000_persistent_admin_notifications`
10. `20261031120000_role_enum_cleanup`
11. `20261103000000_four_eyes_payroll_approval`
12. `20261105000000_phase2_1_company_settings_foundations`
13. `20261105120000_phase2_2_document_sequence_padding`
14. `20261106000000_phase2_3_bank_account_encryption_capacity`
15. `20261112000000_employee_expense_claims_reimbursement`
16. `20261119000000_employee_work_policy_and_multi_pair_attendance`
17. `20261126000000_attendance_auto_checkout_system_generated`

Verify migration table records in PostgreSQL:
```bash
DATABASE_URL="$STAGING_DATABASE_URL" npx prisma migrate status
# Expected output: Database schema is up to date!
```

### Step 4: Health & Readiness Endpoint Verification
Start the server connected to the disposable staging database:
```bash
DATABASE_URL="$STAGING_DATABASE_URL" SESSION_SECRET="$(openssl rand -hex 32)" PORT=3000 npm start
```

Probe the endpoints from another shell:
- **Liveness Probe**:
  ```bash
  curl -i http://localhost:3000/api/health
  # Expected: HTTP 200 OK, {"status":"ok","environment":"production",...}
  ```
- **Readiness Probe**:
  ```bash
  curl -i http://localhost:3000/api/ready
  # Expected: HTTP 200 OK, {"status":"ready","checks":{"postgres":{"status":"connected",...}}}
  ```

### Step 5: Relational Invariants & Constraint Verification
The automated runner (`npm run db:verify:staging -- --execute`) verifies schema constraints via read-only PostgreSQL catalog queries (`pg_indexes`, `information_schema.columns`, `pg_enum`) without mutating any application rows:

1. **Unique Company Code Constraint (`Company_code_key`)**:
   - Verified in `pg_indexes` as a `UNIQUE` index on `Company`.
   - During optional manual/integration functional verification, attempting to create two companies with the same code raises a PostgreSQL `P2002` violation (`409 Conflict`).

2. **Composite Tenant-Scoped User & Attendance Constraints (`User_companyId_email_key`, `Attendance_companyId_employeeId_workDate_key`)**:
   - Verified in `pg_indexes` as `UNIQUE` indexes enforcing tenant-scoped uniqueness for users and daily employee attendance records.

3. **Decimal Precision (18, 6) & Accounting Decimal Precision (18, 4)**:
   - Verified in `information_schema.columns` against `prisma/schema.prisma`:
     - `CurrencyConfig.exchangeRate`: `numeric(18, 6)` (`@db.Decimal(18, 6)`).
     - `JournalEntry.totalDebit`, `JournalEntry.totalCredit`, `JournalLine.debit`, `JournalLine.credit`: `numeric(18, 4)` (`@db.Decimal(18, 4)`).

4. **AttendanceSource Enum Completeness**:
   - Verified in `pg_enum` that `AttendanceSource` contains `MANUAL`, `BIOMETRIC`, and `SYSTEM_GENERATED`.

5. **Double-Entry Balance Enforcement & Fiscal Period Locking** *(verified by dedicated integration suites; never mutated by the automated staging verifier)*:
   - **Double-Entry Balance**: Posting a journal entry where Total Debits ≠ Total Credits is rejected and rolls back cleanly.
   - **Fiscal Period Locking**: Attempting to post a journal entry within a `LOCKED` fiscal period is rejected with a 400 validation error.
   - **Non-Overlapping Salary Revisions**: Creating a subsequent salary revision supersedes active revisions without date overlaps.

### Step 6: Graceful Shutdown & Connection Pool Drain
Send `SIGTERM` to the server process:
```bash
kill -TERM <pid>
```
Verify the output log:
```
[CoreERP] Received SIGTERM. Shutting down gracefully...
[CoreERP] HTTP server closed.
[CoreERP] PostgreSQL connections closed.
```
Confirm `prisma.$disconnect()` completes and no connections linger in PostgreSQL `pg_stat_activity`.

---

## 5. Distinction: Mocked Tests vs. Real Database Tests

| Dimension | Vitest Unit / Mocked Integration Tests | Live PostgreSQL Staging Verification |
| :--- | :--- | :--- |
| **Database Instance** | None (Prisma mocked or offline sandbox) | Real PostgreSQL 16 container / instance |
| **Constraint Enforcement** | Application TypeScript logic only | Native PostgreSQL triggers, unique indexes, and foreign keys |
| **Transaction Semantics** | In-memory simulated transactions | Real ACID transactions with row-level locks and rollback |
| **Migration Testing** | Static SQL text inspection & regex checks | Actual DDL execution (`_prisma_migrations` tracking) |
| **Prisma Engine** | Mocked query results or connection-refusal stubs | Native Query Engine binary executing TCP queries |
| **Health Probe** | Verifies 503 fallback when offline | Verifies 200 OK with live latency measurement |

---

## 6. Teardown Procedure

Once staging verification is complete, stop only the isolated staging container using the container-scoped sequence (preserving volumes):

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml stop postgres-staging
docker compose --env-file .env.staging -f docker-compose.staging.yml rm -f postgres-staging
```

### Safety & Scope Guarantees:
1. **Container-Scoped Cleanup vs. Compose-Wide Teardown**:
   - `docker compose down -v` destroys named volumes and must **never** be used routinely.
   - Running `stop` followed by `rm -f` against `docker-compose.staging.yml` strictly targets `postgres-staging` (`coreerp-postgres-staging`) without impacting `postgres` (`postgres_dev_data`), `postgres-test` (`postgres_test_data`), `postgres-integration-test` (`postgres_integration_test_data`), or `postgres-shadow` (`postgres_shadow_data`).

2. **Named Volume Preservation**:
   - The container removal command (`rm -f`) removes only the stopped container instance and preserves named volumes.
   - The dedicated staging data volume (`postgres_staging_data`) remains intact and must **not** be deleted unless the operator separately and explicitly approves deletion of disposable staging data.
   - Volume deletion commands (such as `docker volume rm`) are **not** recommended as routine cleanup, eliminating the risk of accidental volume deletion.

3. **Explicitly Authorized Local Clean-Reset Workflow**:
   - When an operator explicitly authorizes resetting CoreERP's local Docker databases (`dev`, `test`, `integration`, `staging`, `shadow`) from scratch, use the dedicated allowlisted script instead of manual or global Docker cleanup commands:
     ```bash
     # Dry-run preview (zero changes):
     npm run db:clean-reset -- --targets staging
     # Explicitly confirmed scoped reset + recreate + ordered migrations + staging verification:
     npm run db:clean-reset -- --targets staging --execute --confirm-coreerp-local-reset
     ```
   - Never run `docker system prune --volumes` or touch production volumes (`postgres_data`, `coreerp_storage`).
