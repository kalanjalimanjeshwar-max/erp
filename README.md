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

## 4. Quickstart: Windows / Local Development (Docker Compose)

### Prerequisites
- Node.js 22.x or later
- Docker Desktop (or native PostgreSQL 16 on port 5432)

### Steps (PowerShell / Command Prompt)

```powershell
# 1. Clone repository and install dependencies
npm install

# 2. Copy environment configuration
cp .env.example .env

# 3. Start verified PostgreSQL container in background (service: postgres)
docker compose -f docker-compose.dev.yml up -d postgres

# 4. Apply version-controlled Prisma migrations
npm run db:migrate

# 5. Start unified development server (Express API on :3000 with Vite middleware)
npm run dev
```

Visit `http://localhost:3000` to access the CoreERP dashboard and run the Initial Setup Wizard.

---

## 4. Production Deployment: Ubuntu Linux with Docker Compose

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
# For SESSION_SECRET:
openssl rand -hex 32
# For BANK_ENCRYPTION_KEY (Phase 2.3 dedicated 256-bit AES-GCM key):
openssl rand -hex 32

# Configure .env with your generated secrets and a strong POSTGRES_PASSWORD:
# Mandatory production variables:
# - SESSION_SECRET: High-entropy string (min 32 chars, 64-hex recommended).
# - BANK_ENCRYPTION_KEY: Exactly 64 hexadecimal characters (256 bits).
# - POSTGRES_USER: PostgreSQL database username (e.g., erp_user).
# - POSTGRES_PASSWORD: Strong unique database password.
# - POSTGRES_DB: Database name (e.g., core_erp).
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

## 5. Automated Verification & Testing

Run unit tests and integration tests via Vitest:

```bash
# Run complete test suite
npm run test

# Run TypeScript compilation checks
npm run lint

# Build production bundle
npm run build
```

---

## 6. Health & Diagnostic Endpoints

- `GET /api/health`: Returns process status, uptime, environment, and version.
- `GET /api/ready`: Returns 200 when PostgreSQL is connected; returns 503 with safe diagnostic error when unreachable (never leaks credentials).
- `GET /api/setup/status`: Verifies whether initial company and Super Admin exist.
- `POST /api/setup/bootstrap`: Transactionally creates the initial company and Super Admin with bcrypt password hashing (cost factor 12).
