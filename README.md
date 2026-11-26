# CoreERP Platform — Phase 1 Foundation

Enterprise Resource Planning (ERP) platform built with React, TypeScript, Node.js/Express, PostgreSQL, and Prisma ORM.

---

## 1. Architecture Overview

```
├── /prisma/                          # Prisma schema, migrations, and database lock
│   ├── schema.prisma                 # Core schema (Company, User, Currency, AuditLog)
│   └── migrations/                   # Version-controlled SQL migrations
├── /src/
│   ├── /client/                      # Frontend application (React 19 + Tailwind CSS)
│   │   ├── /components/              # Reusable UI, layout, error boundary, diagnostics
│   │   ├── /pages/                   # Dashboard, Setup Wizard, System Health, Modules
│   │   └── /services/                # Typed API client with error mapping
│   ├── /server/                      # Express REST API backend
│   │   ├── /config/                  # Environment parsing (Zod) & credential sanitizer
│   │   ├── /controllers/             # Health, Readiness, and Setup controllers
│   │   ├── /db/                      # Prisma client lifecycle & health probe
│   │   ├── /middleware/              # Global error handler and logging
│   │   ├── /services/                # Transactional bootstrap and audit logging
│   │   └── /validation/              # Zod validation schemas
│   └── /shared/                      # Shared TypeScript types, enums, and constants
├── /services/
│   └── /biometric-bridge/            # Architecture contract for LAN hardware daemon (Phase 4)
├── /tests/                           # Vitest unit and integration test suite
│   ├── /unit/                        # Env and schema validation unit tests
│   └── /integration/                 # Endpoints, database failure & error handling tests
├── docker-compose.yml                # Production multi-container orchestration
├── docker-compose.dev.yml            # Local development orchestration (App + Postgres)
├── Dockerfile                        # Multi-stage production container build
└── server.ts                         # Unified entry point (Express + Vite in Dev)
```

---

## 2. PostgreSQL Rules & Data Safety

- **PostgreSQL Exclusivity**: PostgreSQL is the mandatory sole operational database. There are no JSON-file fallbacks or silent downgrades.
- **Precision**: Money-related currency rates and amounts use exact `Decimal(18, 6)` database types.
- **Timezone Integrity**: All dates and timestamps are stored in UTC with explicit PostgreSQL `TIMESTAMPTZ(6)`.
- **Company Isolation**: All user and transaction records are strictly scoped to `companyId` with relational foreign keys (`ON DELETE RESTRICT` / `CASCADE`) and composite unique constraints (`[companyId, email]`).
- **No Production Demo Data**: Production database starts completely clean without fake transactions or mock attendance punches.
- **Non-Destructive Boot**: The server never drops, truncates, or resets the database at startup.

---

## 3. Google AI Studio Preview Configuration (External PostgreSQL)

The Google AI Studio preview sandbox runs the unified Node.js/Express server and React SPA on port 3000, but does not provide a local PostgreSQL daemon or Docker engine.

To connect CoreERP in AI Studio to an external PostgreSQL database:

1. **Obtain an External PostgreSQL Database**:
   - Provision a PostgreSQL 15+ database on any cloud provider (Google Cloud SQL, Neon, Supabase, AWS RDS, Render, or Railway).
   - Ensure the database instance accepts external SSL connections and permits outbound connections from AI Studio.

2. **Configure `.env`**:
   Set `DATABASE_URL` with your external connection string (credentials are never exposed to the frontend):
   ```bash
   DATABASE_URL="postgresql://<username>:<password>@<host>:5432/<database>?sslmode=require"
   ```

3. **Deploy Schema Migrations**:
   Run the version-controlled Prisma migration runner:
   ```bash
   npm run db:migrate
   ```

4. **Verify Connectivity in UI**:
   Click **"Retry Database Connection"** in the web interface (or call `GET /api/ready`). Once connected, the Initial Setup Wizard will unlock to bootstrap your root company and Super Admin.

---

## 4. Permanent Database Architecture (Five Separated Environments)

CoreERP strictly separates all five PostgreSQL environments with dedicated ports, databases, users, credentials, and Docker volumes so operations in one environment can **never** affect another:

| # | Environment | Compose File & Service | Container Name | Host Port | Database | User | Named Volume | Env File / Variable |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **Development** | `docker-compose.dev.yml` → `postgres` | `coreerp-postgres-dev` | `5432` | `core_erp` | `erp_user` | `postgres_dev_data` | `.env` → `DATABASE_URL` |
| 2 | **Automated Test** | `docker-compose.dev.yml` → `postgres-test` | `coreerp-postgres-test` | `5433` | `core_erp_test` | `erp_test_user` | `postgres_test_data` | `tests/setup.ts` |
| 3 | **Integration Test** | `docker-compose.integration-test.yml` → `postgres-integration-test` | `coreerp-postgres-integration-test` | `5434` | `core_erp_integration_test` | `erp_integration_user` | `postgres_integration_test_data` | `.env.integration-test` → `TEST_DATABASE_URL` |
| 4 | **Staging Verification** | `docker-compose.staging.yml` → `postgres-staging` | `coreerp-postgres-staging` | `5435` | `core_erp_staging` | `erp_staging_user` | `postgres_staging_data` | `.env.staging` → `STAGING_DATABASE_URL` |
| 5 | **Prisma Shadow DB** | `docker-compose.dev.yml` → `postgres-shadow` (`--profile shadow`) | `coreerp-postgres-shadow` | `5436` | `core_erp_shadow` | `erp_shadow_user` | `postgres_shadow_data` | `.env` → `SHADOW_DATABASE_URL` |

> **Isolation Guarantees**:
> - Staging verification **exclusively** targets `core_erp_staging` (port `5435` locally) and refuses `DATABASE_URL`, `TEST_DATABASE_URL`, `core_erp`, `core_erp_test`, `core_erp_integration_test`, `core_erp_shadow`, or ports `5432`/`5433`/`5434`/`5436`.
> - Production (`docker-compose.yml`) never publishes PostgreSQL host ports (`coreerp-db-internal` internal bridge only) and requires explicit `.env` secrets.

---

## 5. Fresh Installation Guide (New Computer / Windows / macOS / Linux)

### 5.1 Prerequisites
- **Node.js**: 22.x LTS or later (`node -v`)
- **Docker Engine / Docker Desktop** with Compose v2 plugin (`docker compose version`)
- **Git** (`git --version`)

### 5.2 First-Time Setup (`npm run db:setup`)

CoreERP includes a permanent, repeatable, idempotent setup script (`npm run db:setup`) that:
- Never overwrites existing `.env`, `.env.staging`, or `.env.integration-test` files.
- Generates unique, cryptographically strong credentials for staging, integration, shadow, session signing, and bank encryption.
- Percent-encodes connection URLs losslessly (RFC 3986) and validates cross-file consistency across Docker Compose and Prisma.
- Detects pre-existing Docker volumes safely (read-only) and warns if volume credentials may differ, without ever deleting volumes.

```bash
# 1. Clone the repository and install pinned dependencies (triggers postinstall -> prisma generate)
git clone <repo-url> coreerp
cd coreerp
npm ci

# 2. Initialize all local environment files idempotently (.env, .env.staging, .env.integration-test)
npm run db:setup

# Optional: Audit configuration in read-only mode at any time (exits non-zero on mismatch)
npm run db:setup:check
```

### 5.3 Start Development PostgreSQL & Verify Health

```bash
# 3. Start the primary Development PostgreSQL container (port 5432 -> core_erp)
docker compose -f docker-compose.dev.yml up -d postgres

# 4. Confirm container health status (wait for "healthy")
docker compose -f docker-compose.dev.yml ps postgres
docker exec coreerp-postgres-dev pg_isready -U erp_user -d core_erp

# 5. Inspect and apply version-controlled Prisma migrations to development ONLY
npm run db:migrate:target -- --target dev           # Dry-run safety check
npm run db:migrate:target -- --target dev --execute # Applies migrations and confirms status
# (Alternatively: npm run db:migrate)

# 6. Start the unified CoreERP development server (Express API + Vite on http://localhost:3000)
npm run dev
```

Verify application and database readiness from a second terminal:
```bash
curl -i http://localhost:3000/api/health
curl -i http://localhost:3000/api/ready
```
Visit `http://localhost:3000` to run the Initial Setup Wizard.

### 5.4 Prisma Migrations & Shadow Database

- **Pinned Prisma Tooling**: Both `prisma` and `@prisma/client` are pinned to exact `6.19.3`.
- **Clean Installs (`npm ci`)**: Automatically runs `"postinstall": "prisma generate"`.
- **After `git pull`**: If `prisma/schema.prisma` changed without reinstalling `node_modules`, run `npm run db:generate`.
- **Automatic Pre-Hooks**: `npm run lint`, `npm test`, `npm run build`, and `npm run dev` run `prisma generate` automatically cross-platform.
- **Target-Isolated Migrations**: Use `npm run db:migrate:target -- --target <dev|test|integration|staging>` (dry-run by default; requires `--execute` to apply). Never targets production.
- **Authoring New Migrations (Shadow DB on Port 5436)**:
  ```bash
  docker compose -f docker-compose.dev.yml --profile shadow up -d postgres-shadow
  npx prisma migrate dev --name <descriptive_migration_name>
  ```
- **Prohibited Commands**: Never run `prisma migrate reset` or `prisma db push` against shared, staging, or production databases.

---

## 6. Isolated Staging Verification (Port 5435)

Staging verification uses its own dedicated Compose file (`docker-compose.staging.yml`), port (`5435`), database (`core_erp_staging`), volume (`postgres_staging_data`), and git-ignored credential file (`.env.staging`). See `docs/staging-verification-guide.md` for full details.

```bash
# 1. Ensure .env.staging exists and passes consistency audit (idempotent)
npm run db:setup:check

# 2. Start the isolated staging PostgreSQL container
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d
docker compose --env-file .env.staging -f docker-compose.staging.yml ps

# 3. Pre-flight safety validation (dry-run — no DB connection)
npm run db:verify:staging

# 4. Execute full 6-step read-only staging verification (migrations, catalogs, /api/health, /api/ready, SIGTERM drain)
npm run db:verify:staging -- --execute

# 5. Stop only the staging container when finished (preserves postgres_staging_data volume)
docker compose --env-file .env.staging -f docker-compose.staging.yml stop postgres-staging
```

---

## 7. Production Deployment: Ubuntu Linux with Docker Compose

### Prerequisites
- Ubuntu 22.04 LTS or 24.04 LTS
- Docker Engine & Docker Compose plugin (`docker compose version`)

### Steps

```bash
# 1. Clone repository on server
git clone <repo-url> /opt/coreerp
cd /opt/coreerp

# 2. Create production environment file and configure mandatory secrets
cp .env.example .env

# Generate cryptographically secure 64-character hex secrets:
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # BANK_ENCRYPTION_KEY (256-bit AES-GCM)
openssl rand -hex 32   # POSTGRES_PASSWORD (unique production DB password)
nano .env

# 3. Controlled Database Migration (Runs before application starts)
# Option A: Automatic orchestrated startup (postgres -> migration container -> app)
docker compose up -d --build

# Option B: Explicit one-shot migration execution
docker compose run --rm migration

# 4. Verify system readiness
curl -i http://localhost:3000/api/ready
```

---

## 8. Reinstallation, Credential Recovery, P1000 Troubleshooting & Safe Docker Volumes

### 8.1 Reinstalling CoreERP Without Losing Data
1. **Back up existing environment files** (`.env`, `.env.staging`, `.env.integration-test`) before removing or re-cloning the repository directory.
2. Restore your backed-up `.env*` files into the new repository directory before running `npm run db:setup`.
3. Run `npm ci` followed by `npm run db:setup` (existing `.env*` files are preserved byte-for-byte) and `npm run db:setup:check`.
4. Start the containers; existing named Docker volumes (`postgres_dev_data`, `postgres_staging_data`, etc.) are automatically reattached without data loss.

### 8.2 Why Prisma `P1000` Authentication Failures Happen & How to Fix Them Permanently
**Root Cause**: The official PostgreSQL Docker image (`postgres:16-alpine`) only applies `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` **the very first time an empty data volume is initialized**. If you reinstall the app, regenerate `.env` / `.env.staging`, or edit `POSTGRES_PASSWORD` while an older Docker volume already exists, PostgreSQL keeps the old role password inside the volume and rejects Prisma connections with `P1000: Authentication failed`.

**Permanent Non-Destructive Recovery (Zero Volume Deletion)**:
1. **Audit config parity first** (detects `.env` vs `DATABASE_URL` or `.env` vs `.env.staging` drift):
   ```bash
   npm run db:setup:check
   ```
2. **Development Database (`localhost:5432` / `core_erp`)**:
   ```bash
   # Preview exact change (dry-run)
   npm run db:sync:dev-credentials
   # Synchronize existing coreerp-postgres-dev role password with .env without touching data
   npm run db:sync:dev-credentials -- --confirm
   ```
3. **Staging Database (`localhost:5435` / `core_erp_staging`) or Integration (`5434`)**:
   Align the PostgreSQL role password inside the running container to match `.env.staging` via `psql` over stdin (so the password is never exposed in shell history or `ps` arguments), **without deleting the volume**:
   ```bash
   # Load STAGING_POSTGRES_USER / STAGING_POSTGRES_PASSWORD / STAGING_POSTGRES_DB from .env.staging,
   # then execute ALTER ROLE via stdin inside coreerp-postgres-staging:
   (set -a; source .env.staging; set +a; \
     printf "ALTER ROLE \"%s\" WITH PASSWORD '%s';\n" "$STAGING_POSTGRES_USER" "${STAGING_POSTGRES_PASSWORD//\'/\'\'}" \
     | docker exec -i coreerp-postgres-staging psql -U "$STAGING_POSTGRES_USER" -d "$STAGING_POSTGRES_DB")
   ```
4. **Special Characters in Passwords**: If setting custom passwords manually containing `@`, `:`, `/`, `#`, `%`, `?`, `&`, or `+`, always percent-encode them in the `*_DATABASE_URL` URI (or use 64-char hex from `openssl rand -hex 32` / `npm run db:setup`, which requires no escaping).

### 8.3 Credential Rotation Procedure
1. Generate a new 256-bit hex secret (`openssl rand -hex 32`).
2. Update the running PostgreSQL role password via `ALTER ROLE` (stdin pipe, never CLI flags).
3. Update both the Compose variable (`POSTGRES_PASSWORD` / `STAGING_POSTGRES_PASSWORD`) and the corresponding connection URL (`DATABASE_URL` / `STAGING_DATABASE_URL`) together.
4. Run `npm run db:setup:check` to confirm zero drift, then restart the application service.

### 8.4 Safe Docker Volume Handling
- **NEVER run `docker compose down -v`** or `docker volume prune` casually — `-v` destroys all named volumes declared in that Compose file, including persistent databases.
- Always stop individual containers using service-scoped commands:
  ```bash
  docker compose -f docker-compose.dev.yml stop postgres
  docker compose --env-file .env.staging -f docker-compose.staging.yml stop postgres-staging
  ```
- Only remove a disposable volume (`postgres_staging_data` or `postgres_integration_test_data`) after explicit operator confirmation and, for any non-disposable database, a verified `pg_dump` backup.

### 8.5 Explicitly Confirmed Clean Reset of Local CoreERP Docker Databases (`npm run db:clean-reset`)

When you explicitly authorize a complete clean slate for CoreERP's local Docker databases (when no production company data resides in local containers), use the dedicated, explicitly confirmed clean-reset workflow:

```bash
# 1. Safe Dry-Run Preview (DEFAULT — inspects matching CoreERP containers & volumes; modifies NOTHING)
npm run db:clean-reset

# 2. Explicitly Confirmed Scoped Clean-Reset + Recreate + Ordered Migrations + Staging Verification
npm run db:clean-reset -- --execute --confirm-coreerp-local-reset

# 3. Optional: Back up existing .env* files (.env*.backup.<timestamp>) and regenerate fresh consistent credentials
npm run db:clean-reset -- --execute --confirm-coreerp-local-reset --recreate-env

# 4. Optional: Scope clean-reset to specific local targets only (never accepts prod/production)
npm run db:clean-reset -- --targets dev,staging --execute --confirm-coreerp-local-reset
```

**Strict Safety Guarantees of `npm run db:clean-reset`**:
- **Never Automatic**: Never invoked by `npm install`, `npm ci`, `npm run db:setup`, `npm run dev`, or `npm start`.
- **Dry-Run by Default**: Requires **both** `--execute` and `--confirm-coreerp-local-reset` before touching any Docker resource.
- **Strictly CoreERP Local Allowlist Only**: Removes ONLY `coreerp-postgres-dev`, `coreerp-postgres-test`, `coreerp-postgres-integration-test`, `coreerp-postgres-staging`, `coreerp-postgres-shadow`, and their five dedicated volumes (`postgres_dev_data`, `postgres_test_data`, `postgres_integration_test_data`, `postgres_staging_data`, `postgres_shadow_data`) scoped to this workspace.
- **Never Runs Global Prune**: Hard-blocks `docker system prune`, `docker volume prune`, `docker container prune`, `docker rmi`, and `docker compose down -v`.
- **Production & Unrelated Resources Protected**: Refuses execution if `NODE_ENV=production` or if `DATABASE_URL` targets a remote host; never touches `coreerp-postgres`, `coreerp-app`, `coreerp-migration`, `postgres_data`, `coreerp_storage`, or unrelated Docker projects.
- **Code & Biometric Bridge Preserved**: Never modifies source code, Git history, `bridges/essl-x2008-bridge`, Windows biometric bridge data, or `USER_SYNC_ONLY` mode.
- **Full Clean Recreation**: Recreates each target container, waits for PostgreSQL readiness (`pg_isready`), applies all 17 version-controlled Prisma migrations in order (`prisma migrate deploy` + `prisma migrate status`), leaves `core_erp_shadow` clean for Prisma, and runs full 6-step staging verification.

---

## 9. Automated Verification & Testing

Run Prisma generation/validation, TypeScript checks, Vitest tests, and the production build:

```bash
# 1. Regenerate Prisma Client (idempotent; also triggered automatically by pre* hooks below)
npm run db:generate

# 2. Validate Prisma schema
npx prisma validate

# 3. Audit five-environment DB configuration (read-only)
npm run db:setup:check

# 4. Run TypeScript compilation checks (runs prelint -> prisma generate)
npm run lint

# 5. Run complete unit/offline test suite (runs pretest -> prisma generate; never connects to 5432, 5434, or 5435)
npm test

# 6. Build production bundle (runs prebuild -> prisma generate)
npm run build
```

### Isolated PostgreSQL 16 Integration Testing (Port 5434)

Real PostgreSQL 16 integration tests run exclusively against the dedicated disposable container defined in `docker-compose.integration-test.yml` (`coreerp-postgres-integration-test`, host port `5434`, database `core_erp_integration_test`, user `erp_integration_user`). This environment is completely separate from local development (`localhost:5432` / `core_erp`), automated unit test DB (`localhost:5433` / `core_erp_test`), staging verification (`localhost:5435` / `core_erp_staging`), and Prisma shadow DB (`localhost:5436` / `core_erp_shadow`).

**Database isolation guard layers**: Three independent layers enforce port-`5434` isolation during integration runs:
- `tests/setup.ts`: Enables `COREERP_INTEGRATION_TEST_MODE=true`, deletes `DATABASE_URL`, wraps `dotenv.config()`, and validates `TEST_DATABASE_URL` against `localhost`/`127.0.0.1`, port `5434`, and `core_erp_integration_test`.
- `src/server/db/client.ts`: Refuses conflicting `DATABASE_URL` (split-brain protection) and independently validates `TEST_DATABASE_URL` before creating or binding the integration Prisma client.
- `src/server/config/env.ts`: Provides an additional independent integration-mode environment validation layer that permits `DATABASE_URL` omission strictly when `NODE_ENV=test` and `COREERP_INTEGRATION_TEST_MODE=true`, rejects any non-empty `DATABASE_URL` in integration mode, and independently validates `TEST_DATABASE_URL` against `localhost`/`127.0.0.1`, port `5434`, and `core_erp_integration_test`.

1. **Generate `.env.integration-test`** (handled automatically by `npm run db:setup`):
   ```env
   POSTGRES_PASSWORD=<disposable_integration_password>
   TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public"
   ```
2. **Start the isolated PostgreSQL 16 integration container**:
   ```bash
   docker compose --env-file .env.integration-test -f docker-compose.integration-test.yml up -d
   ```
3. **Deploy all 17 version-controlled Prisma migrations** to `core_erp_integration_test` on port `5434`:
   ```bash
   TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npm run db:migrate:target -- --target integration --execute
   ```
4. **Run targeted PostgreSQL 16 integration suites** (ensure `DATABASE_URL` remains unset; do **not** run full `npm test` with integration DB variables):
   ```bash
   TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npm run test:integration:concurrency
   TEST_DATABASE_URL="postgresql://erp_integration_user:<password>@localhost:5434/core_erp_integration_test?schema=public" npm run test:integration:key-rotation
   ```

---

## 10. Health & Diagnostic Endpoints

- `GET /api/health`: Returns process status, uptime, environment, and version.
- `GET /api/ready`: Returns 200 when PostgreSQL is connected; returns 503 with safe diagnostic error when unreachable (never leaks credentials).
- `GET /api/setup/status`: Verifies whether initial company and Super Admin exist.
- `POST /api/setup/bootstrap`: Transactionally creates the initial company and Super Admin with bcrypt password hashing (cost factor 12).
