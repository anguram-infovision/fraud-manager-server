# fraud-manager-server

Express 5 backend for AppSolute Fraud & AML Monitor. Receives payment webhooks from the AppSolute backend, evaluates fraud and AML signals, persists alerts to SQLite, and serves a REST API consumed by the [`fraud-manager`](https://github.com/anguram-infovision/fraud-manager) Angular frontend.

## Purpose

Sits between the AppSolute backend and Braintree to add business-context fraud/AML evaluation that a payment processor cannot perform — knowing the borrower's expected monthly payment, loan history, and multi-source payment patterns.

Primary alert path is a poll loop (`sync.service.ts`) that reads new settlements directly from AFS SQL Server every 15s. The webhook is a secondary entry point pushed by the AppSolute backend and performs a real Braintree GraphQL lookup.

## Getting Started

### Prerequisites

- Node 18+
- VPN connected (AFS SQL Server at `192.168.100.226`)
- Braintree sandbox credentials

### Install & configure

```bash
npm install
cp .env.example .env
# Fill in Braintree + SQL credentials
```

### Migrate database

```bash
npm run db:migrate
# Creates data/fraud.db with alerts, notes, audit_log, scenario_configs tables
```

### Run

```bash
npm run dev        # tsx watch — hot reload
npm run build      # tsc → dist/
npm start          # run compiled output (production)
```

Server starts on `http://localhost:3001`.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/fraud/api/webhook/transaction` | Ingest payment webhook, run evaluation |
| GET | `/fraud/api` | List alerts |
| GET | `/fraud/api/:id` | Get alert |
| PUT | `/fraud/api/:id/status` | Update alert status |
| POST | `/fraud/api/:id/notes` | Add note |
| GET | `/fraud/api/scenarios` | Get AML scenario configs |
| PUT | `/fraud/api/scenarios/:scenario` | Update scenario threshold |
| POST | `/fraud/api/auth/login` | Login |
| GET | `/fraud/api/auth/me` | Session check |
| POST | `/fraud/api/auth/logout` | Logout |

All routes mount on both `/api` (dev proxy) and `/fraud/api` (IIS production).

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default `3001`) |
| `BT_MERCHANT_ID` | Braintree merchant ID |
| `BT_PUBLIC_KEY` | Braintree public key |
| `BT_PRIVATE_KEY` | Braintree private key |
| `BT_CAPABILITY_TIER` | `basic` or `premium` |
| `SQL_SERVER` | AFS SQL Server host |
| `SQL_DATABASE` | AFS database name |
| `SQL_USER` | SQL auth user |
| `SQL_PASSWORD` | SQL auth password |
| `DEV_MOCK_BORROWER` | `true` to skip SQL queries (no VPN) |
| `DB_PATH` | SQLite file path (default `./data/fraud.db`) |
| `AUTH_ENABLED` | `true` to enforce session auth (default `false`) |
| `SESSION_SECRET` | Secret for session signing |
| `FRAUD_ADMIN_PASSWORD` | Login password |

## Fraud & AML Rules

**Fraud signals**
- `GATEWAY_REJECTION` — Braintree processor declined
- `DUPLICATE_PAYMENT` — same amount within 60-minute window
- `BIN_COUNTRY_MISMATCH` — card BIN country ≠ borrower country

**AML scenarios** (thresholds configurable via API)
- `AMOUNT_DEVIATION` — payment > 2× expected monthly
- `PAYMENT_VELOCITY` — > 5 payments within 7 days
- `MULTIPLE_PAYMENT_SOURCES` — ≥ 3 distinct payment methods within 7 days
- `REFUND_DISPUTE_CYCLE` — loan has both refunds and active disputes
- `SAME_DAY_VELOCITY` — ≥ 3 payments on same loan within the same calendar day

## Scripts

```bash
npm run dev           # tsx watch src/server.ts
npm run build         # tsc
npm start             # node dist/server.js
npm run db:generate   # drizzle-kit generate
npm run db:migrate    # drizzle-kit migrate
npm run db:studio     # Drizzle Studio UI
```
