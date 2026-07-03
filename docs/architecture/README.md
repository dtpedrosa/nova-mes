# Nova Pharma MES — Architecture Overview

Nova-MES is an anonymized pharmaceutical Manufacturing Execution System (MES) demo,
instrumented end-to-end with **pure OpenTelemetry** (no OneAgent) and observed in
**Dynatrace**. It models two core MES journeys — electronic batch record release and
shop-floor weigh & dispense — backed by a **PostgreSQL** persistence layer and a
modern SPA that mirrors production MES products like **Körber PAS X**.

## Contents

- [System Architecture](#system-architecture)
- [Application Components](#application-components)
- [Data Model](#data-model)
- [Infrastructure & Deployment](#infrastructure--deployment)
- [Observability Pipeline](#observability-pipeline)
- [MES / PAS X Mapping](#mes--pas-x-mapping)
- [Request Flow — Batch Release](#request-flow--batch-release)

---

## System Architecture

```
                            ┌───────────────────────────┐
                            │        BROWSER (SPA)       │
                            │  vanilla JS hash-router    │
                            │  Chart.js · OTel Web SDK   │
                            └────────────┬──────────────┘
                    fetch() /api/* │     │ OTLP (RUM traces)
                                   │     │ via /otlp-proxy
                                   ▼     ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         KUBERNETES / DOCKER COMPOSE                          │
│                                                                             │
│   ┌──────────────────────────── nova-mes-web :4000 ─────────────────────┐  │
│   │  Express BFF + static SPA host + journey orchestrator               │  │
│   │  /api/journey/*   /api/batches   /api/dashboard/kpis   /_flags       │  │
│   └───────┬──────────────────┬──────────────────────┬──────────────────┘  │
│           │ HTTP             │ HTTP                  │ SQL (pg)             │
│           ▼                  ▼                       ▼                      │
│   ┌───────────────┐  ┌────────────────────┐  ┌──────────────────┐         │
│   │ batch-service │  │ dispensing-service │  │  nova-postgres   │  ◄─ NEW  │
│   │    :4001      │  │       :4002        │  │  PostgreSQL 16   │         │
│   │  stateless    │  │    stateless       │  │  4 tables        │         │
│   └───────┬───────┘  └─────────┬──────────┘  └──────────────────┘         │
│           │                    │                                           │
│           └──────── OTLP ──────┴──────── OTLP ────────┐                    │
│                                                        ▼                    │
│   ┌────────────────┐                        ┌────────────────────┐         │
│   │  nova-loadgen  │──── HTTP traffic ─────► │   otel-collector   │         │
│   │  (2 RPS)       │    (drives mes-web)     │   :4317 / :4318    │         │
│   └────────────────┘                        └─────────┬──────────┘         │
└─────────────────────────────────────────────────────── │ ──────────────────┘
                                                          │ OTLP/HTTP + Api-Token
                                                          ▼
                                        ┌────────────────────────────────┐
                                        │           DYNATRACE            │
                                        │  Traces · Metrics · Logs ·      │
                                        │  Business Events · RUM (Grail)  │
                                        └────────────────────────────────┘
```

---

## Application Components

| Component | Port | Stateful | Responsibility |
|---|---|---|---|
| **nova-mes-web** | 4000 | No (reads/writes DB) | Backend-for-frontend. Serves the SPA, orchestrates journeys, exposes the data-query API, proxies browser RUM, hosts the fault-injection flag control. |
| **nova-batch-service** | 4001 | No | Journey 1 backend — automated review-by-exception (`/review`) and GxP release with simulated Oracle/SAP/LIMS integrations (`/gxp-release`). |
| **nova-dispensing-service** | 4002 | No | Journey 2 backend — shop-floor weigh & dispense with a simulated PLC/scale read (`/weigh`). |
| **nova-postgres** | 5432 | **Yes** | PostgreSQL 16. Persists batch records, work orders, deviations, and equipment state. |
| **otel-collector** | 4317/4318 | No | Receives OTLP from all tiers (including browser) and forwards to Dynatrace. |
| **nova-loadgen** | — | No | Generates continuous background traffic against mes-web. |

### Tech stack

- **Runtime:** Node.js 20, Express 4
- **Frontend:** Vanilla HTML/CSS/JS (no build step), hash-based SPA router, Chart.js via CDN
- **Database:** PostgreSQL 16 (`pg` driver, connection pool with graceful fallback)
- **Telemetry:** OpenTelemetry (SDK-node backend, Web SDK browser), OTLP/protobuf
- **Backend observability:** Dynatrace (Grail)
- **Packaging:** Single Docker image (`node:20-slim`), one image for all services

---

## Data Model

PostgreSQL schema created idempotently on startup (`services/mes-web/db-init.js`),
seeded with realistic historical data.

```
┌────────────────────────┐      ┌────────────────────────┐
│      batch_records     │      │       work_orders      │
├────────────────────────┤      ├────────────────────────┤
│ id            PK        │      │ id            PK        │
│ batch_id      UNIQUE    │      │ order_id      UNIQUE    │
│ product_code/name       │      │ material_code/name      │
│ status ▸ pending|       │      │ target_kg / actual_kg   │
│         in_review|      │      │ status ▸ pending|       │
│         released|failed │      │   in_progress|          │
│ quantity_units          │      │   completed|deviation   │
│ value_usd               │      │ priority                │
│ site / line             │      │ site / line             │
│ created_at / released_at│      │ created_at/completed_at │
│ review_exceptions       │      └────────────────────────┘
└────────────────────────┘
                                 ┌────────────────────────┐
┌────────────────────────┐      │       equipment        │
│       deviations       │      ├────────────────────────┤
├────────────────────────┤      │ id            PK        │
│ id            PK        │      │ equipment_id  UNIQUE    │
│ reference_id            │◄─────│ name / type             │
│ reference_type ▸ batch| │ soft │ line / site             │
│              work_order │ ref  │ status ▸ operational|   │
│ severity ▸ minor|major| │      │   fault|maintenance|    │
│           critical      │      │   offline               │
│ description             │      │ last_reading_json JSONB │
│ status ▸ open|          │      │ last_seen_at            │
│   investigating|closed  │      └────────────────────────┘
│ site / created / closed │
└────────────────────────┘
```

**Write pattern:** journey endpoints in `mes-web` persist results *after* responding to
the client (fire-and-forget), so DB latency never affects user-facing response time and
a DB outage never breaks a journey. Batch/dispensing services stay fully stateless.

---

## Infrastructure & Deployment

### Local — Docker Compose

```bash
export DT_ENDPOINT="https://<env>.live.dynatrace.com/api/v2/otlp"
export DT_API_TOKEN="dt0c01.XXXX"   # traces, metrics, logs, bizevents ingest
docker compose up --build
# open http://localhost:4000
```

- `postgres` starts first, gated by a `pg_isready` healthcheck.
- `mes-web` waits for `postgres: service_healthy`, then runs schema init + seed.
- Data persists in the `postgres-data` named volume across restarts.
- Omit `DT_*` vars to run fully local — the collector's debug exporter still logs everything.

### Production — Kubernetes / GKE

Two deployment paths, both in the `nova-mes` namespace:

| Path | Postgres | Persistence |
|---|---|---|
| **Helm** (`helm/nova-mes/`) | StatefulSet + 2Gi PVC (`volumeClaimTemplates`) | Durable across pod restarts |
| **Raw manifests** (`k8s/`) | Deployment + `emptyDir` | Ephemeral — re-seeded on restart |

- Postgres password lives in a dedicated Secret (`{release}-postgres` / `nova-mes-postgres`), separate from the OTel secret.
- `DATABASE_URL` is assembled in the mes-web pod using k8s `$(VAR)` interpolation from the secret.
- **gVisor note:** service and postgres pods run on the default runc runtime with `use-vc` DNS-over-TCP and gVisor tolerations so they schedule on sandbox nodes; only loadgen runs inside gVisor. Postgres runs with `shared_memory_type=mmap` for sandbox safety.

### Deployment topology

```
GKE cluster (dp-apps-2)
└── namespace: nova-mes
    ├── Deployment  nova-mes-web         → Service (LoadBalancer :80 → :4000)  [external]
    ├── Deployment  nova-batch-service   → Service (ClusterIP :4001)
    ├── Deployment  nova-dispensing-service → Service (ClusterIP :4002)
    ├── StatefulSet nova-postgres        → Service (ClusterIP :5432) + headless
    ├── Deployment  otel-collector       → Service (ClusterIP :4317/:4318)
    └── Deployment  nova-loadgen         (no service — egress only)
```

---

## Observability Pipeline

All four telemetry signals flow through the collector to Dynatrace:

| Signal | Source | Examples |
|---|---|---|
| **Traces** | All tiers incl. browser | `journey.batch_release` → `oracle.commit`, `gxp.sap.call`, and now **PostgreSQL `pg` spans** with `db.statement` |
| **Metrics** | mes-web + backends | `nova.journey.completed`, `nova.journey.duration`, `nova.dispense.latency`, `nova.batches.in_progress` |
| **Logs** | All services | Structured JSON, trace-correlated (`dt.trace_id` / `dt.span_id`) |
| **Business events** | mes-web + backends | `batch.released`, `dispense.completed`, `batch.release.failed` |
| **RUM** | Browser (OTel Web SDK) | Page load, `user_action:*`, `nav:*` navigation spans, JS errors |

A single "Release Batch" click produces one distributed trace spanning: browser action →
mes-web journey → batch-service review → GxP release (Oracle/SAP/LIMS) → PostgreSQL upsert.

---

## MES / PAS X Mapping

| Nova-MES page | PAS X equivalent | Function |
|---|---|---|
| **Dashboard** | Production Overview | Live KPIs, throughput chart, activity feed |
| **Batch Records** | Electronic Batch Record (eBR) | Batch release history, inline release, status tracking |
| **Work Orders** | Work Order Management | Weigh/dispense queue, target vs actual kg |
| **Equipment** | Equipment Management | Instrument status, live readings, last-seen |
| **Deviations** | Deviation Management | Auto-logged quality events from journey failures |
| **Control Panel** | *(demo-only)* | Fault-injection flags & scenario presets |

---

## Request Flow — Batch Release

```
1. User clicks "Release batch"  (Batch Records page)
      │  RUM span: user_action:Release batch
      ▼
2. POST /api/journey/batch-release          [nova-mes-web]
      │  span: journey.batch_release
      ├─► POST /review        [batch-service]  — 400 params, 3 exceptions
      └─► POST /gxp-release    [batch-service]  — oracle.commit + SAP + LIMS
      ▼
3. Response returned to browser  (result banner: success/fail)
      │
      ├─ (fire-and-forget) UPSERT batch_records      [PostgreSQL]  ── pg span
      └─ on failure: INSERT deviations               [PostgreSQL]  ── pg span
      ▼
4. Browser refreshes table via GET /api/batches
      → new row appears with status badge

   ── entire chain is ONE distributed trace in Dynatrace ──
```

---

*Diagrams are ASCII for portability. See [`components.md`](components.md) for a per-file
component reference and [`data-flows.md`](data-flows.md) for the remaining journey flows.*
