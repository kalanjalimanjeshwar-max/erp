# CoreERP Isolated PostgreSQL Staging Verification Guide (Phase 8.7)

## 1. Executive Summary & Purpose

CoreERP has achieved complete functional coverage, high-entropy secret validation, non-destructive migration ordering, and full static type safety across its entire stack. 

However, all automated tests executed to date have been **mocked unit tests** or **offline integration tests** verifying application behavior when the database is unavailable. **The application has not yet been verified against a live, running PostgreSQL database instance.**

This guide outlines the **safe, isolated PostgreSQL staging verification procedure**. It is designed to be executed only when the user explicitly authorizes live staging verification, ensuring zero risk to production data or existing infrastructure.

---

## 2. Fundamental Safety Guardrails

To prevent accidental data loss, schema corruption, or unintended modifications:

1. **Dedicated Disposable Database Target Only**:
   - Verification must run against an isolated disposable database instance (e.g. `core_erp_staging` or `core_erp_test`).
   - The tooling (`npm run db:verify:staging`) **strictly refuses** to run if:
     - No explicit staging database URL is provided (`STAGING_DATABASE_URL` or `TEST_DATABASE_URL`).
     - The target database URL matches the production `DATABASE_URL`.
     - The database name is a production name (`core_erp`, `prod`, `production`, `main`, `live`).
     - The database name lacks a required test/staging indicator (`test`, `staging`, `disposable`, `sandbox`, `temp`).

2. **Prohibited Destructive Operations**:
   - `prisma migrate reset` is **strictly prohibited**.
   - `prisma db push` is **strictly prohibited**.
   - Raw `DROP DATABASE`, `DROP TABLE`, or destructive SQL scripts are **strictly prohibited**.

3. **Explicit User Approval Required**:
   - During Phase 8.7A (Preparation), no live database connections, Docker containers, or migrations are executed.
   - Live execution will occur only in Phase 8.7B upon explicit user authorization.

---

## 3. Dedicated Staging Database Architecture Options

### Option A: Local Disposable Docker Container (Recommended)
`docker-compose.dev.yml` already defines a dedicated, isolated test database service (`postgres-test`) running on port `5433`:

```yaml
# From docker-compose.dev.yml
postgres-test:
  image: postgres:16-alpine
  container_name: coreerp-postgres-test
  environment:
    POSTGRES_USER: erp_test_user
    POSTGRES_PASSWORD: erp_test_password
    POSTGRES_DB: core_erp_test
    TZ: UTC
    PGTZ: UTC
  ports:
    - "5433:5432"
  volumes:
    - postgres_test_data:/var/lib/postgresql/data
```

> **Host Port Distinction (Port 5433 vs. Port 5432)**:
> - **Port 5433 (Host)**: Mapped strictly to the isolated `postgres-test` container (`5433:5432`). All staging/test database commands must connect via port 5433.
> - **Port 5432 (Host)**: The default PostgreSQL port reserved for the primary development database (`postgres` service in `docker-compose.yml` or `docker-compose.dev.yml`).
> - This explicit port distinction guarantees that running staging verification against `localhost:5433` cannot inadvertently connect to, query, or mutate the development database on `localhost:5432`.

**Target Connection String**:
```bash
export STAGING_DATABASE_URL="postgresql://erp_test_user:erp_test_password@localhost:5433/core_erp_test?schema=public"
```

### Option B: Ephemeral Cloud Staging Branch
If verifying in cloud environments (e.g. Neon, Supabase, Cloud SQL):
- Create a dedicated disposable branch or database named `core_erp_staging`.
- Ensure SSL is configured (`?sslmode=require`).
- **Never** point to the production database.

### Distinction: Local Disposable Integration Testing (Port 5434) vs. Staging Verification (Port 5433 / Cloud Staging)
CoreERP intentionally separates **local disposable PostgreSQL 16 integration testing** (`localhost:5434` / `core_erp_integration_test`) from both **local development** (`localhost:5432` / `core_erp`) and **staging verification** (`localhost:5433` / `core_erp_test` or an ephemeral `core_erp_staging` instance):

| Dimension | Local Disposable Integration Testing | Staging Verification |
| :--- | :--- | :--- |
| **Purpose** | Automated real-PostgreSQL Vitest concurrency, constraint, trigger, HTTP authorization/payroll-lock, and rollback suites | End-to-end release pre-flight, migration deployment, health/readiness probes, and operational verification |
| **Compose File / Target** | `docker-compose.integration-test.yml` (`postgres-integration-test`) | `docker-compose.dev.yml` (`postgres-test`) or dedicated ephemeral `core_erp_staging` instance |
| **Host Port / DB Name** | `localhost:5434` / `core_erp_integration_test` (`erp_integration_user`) — distinct from dev port `5432` (`core_erp`) | `localhost:5433` / `core_erp_test` or remote `core_erp_staging` — distinct from dev port `5432` (`core_erp`) |
| **Safety Guard Layer** | `tests/setup.ts` + `src/server/db/client.ts` + `src/server/config/env.ts` (`COREERP_INTEGRATION_TEST_MODE=true`, `TEST_DATABASE_URL` on `5434` only, `DATABASE_URL` unset) | `npm run db:verify:staging` (`src/server/db/staging-safety.ts` via `STAGING_DATABASE_URL`) |
| **Secret File** | Git-ignored `.env.integration-test` (`POSTGRES_PASSWORD`) | Environment-scoped staging secret mechanism |

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
3. **Deploy all 16 version-controlled Prisma migrations** to port `5434` only (pass `DATABASE_URL` inline for the explicitly targeted `prisma migrate deploy` and `prisma migrate status` commands only; do not leave it exported for Vitest):
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
✔ Safety validation PASSED for database "core_erp_test" (or "core_erp_staging").
✔ Target is confirmed isolated and disposable (non-production).
```

### Step 2: Start Isolated Staging Database Container (User Authorized)
```bash
docker compose -f docker-compose.dev.yml up -d postgres-test
```
Wait for healthy status:
```bash
docker compose -f docker-compose.dev.yml ps postgres-test
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

Verify that all 16 version-controlled migrations applied cleanly:
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
Execute live database queries and API calls to confirm that PostgreSQL enforces all enterprise constraints:

1. **Unique Company Code Constraint (`Company_code_key`)**:
   - Attempt to bootstrap two companies with the same code (e.g. `ACME`).
   - Confirm PostgreSQL throws a `P2002` unique constraint violation and API returns `409 Conflict`.

2. **Composite Tenant-Scoped User Constraint (`User_companyId_email_key`)**:
   - Confirm two different companies can both have a user with email `admin@example.com`.
   - Confirm a single company cannot have two users with the same email.

3. **Decimal Precision (18, 6)**:
   - Create a journal line with 6 decimal places (e.g. `1250.550000`).
   - Confirm PostgreSQL stores the exact decimal value without floating-point truncation.

4. **Double-Entry Balance Enforcement**:
   - Attempt to post a journal entry where Total Debits ≠ Total Credits.
   - Confirm the transaction is rejected and rolls back cleanly.

5. **Fiscal Period Locking**:
   - Mark a fiscal period as `LOCKED`.
   - Attempt to post a journal entry within that period.
   - Confirm the operation is blocked with a 400 validation error.

6. **Non-Overlapping Salary Revisions**:
   - Create an initial salary revision for an employee.
   - Create a subsequent revision and verify existing active revisions are superseded without date overlaps.

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

Once staging verification is complete, tear down only the disposable staging container using the container-scoped cleanup sequence:

```bash
docker compose -f docker-compose.dev.yml stop postgres-test
docker compose -f docker-compose.dev.yml rm -f postgres-test
```

### Safety & Scope Guarantees:
1. **Container-Scoped Cleanup vs. Compose-Wide Teardown**:
   - `docker compose down` operates at the entire project level and cannot be scoped to a single service. Running `docker compose down` (and especially `docker compose down -v`) would shut down all services in `docker-compose.dev.yml` and destroy all project volumes, including `postgres_dev_data`.
   - Running `stop` followed by `rm -f` strictly targets the `postgres-test` container (`coreerp-postgres-test`) without impacting any other development or auxiliary containers.

2. **Named Volume Preservation**:
   - The container removal command (`rm -f`) removes only the stopped container instance and preserves named volumes.
   - The dedicated test data volume (`postgres_test_data`) remains intact and must **not** be deleted unless the operator separately and explicitly approves deletion of disposable test data.
   - Volume deletion commands (such as `docker volume rm`) are **not** recommended as routine cleanup, eliminating the risk of accidental volume deletion.
