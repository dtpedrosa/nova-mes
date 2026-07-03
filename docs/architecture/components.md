# Component Reference

Per-file map of the Nova-MES codebase.

## Services

### `services/mes-web/` — Backend-for-frontend (port 4000)
| File | Purpose |
|---|---|
| `server.js` | Express app. Serves the SPA, orchestrates journeys, exposes the data-query API (`/api/batches`, `/api/work-orders`, `/api/equipment`, `/api/deviations`, `/api/dashboard/kpis`), proxies browser RUM, hosts flag control, and persists journey results to PostgreSQL. |
| `db-init.js` | Idempotent schema creation (`CREATE TABLE IF NOT EXISTS`) + seed data (transaction-wrapped, `ON CONFLICT DO NOTHING`). Called once on startup. |
| `public/index.html` | SPA shell — topbar, sidebar nav, `#content` mount point. Loads Chart.js (CDN) + RUM. |
| `public/app.js` | Hash-based client router + one render function per page (Dashboard, Batches, Work Orders, Equipment, Deviations, Control). Includes `runJourney`, `makeExpandableRow`, table sorters, and interval cleanup. |
| `public/styles.css` | Dark-theme design tokens + app-shell layout, nav, KPI tiles, data tables, status badges, result banners, equipment cards, chart/activity containers. |
| `public/rum-otel.js` | OpenTelemetry Web SDK bootstrap — exposes `window.novaRum`. |

### `services/batch-service/` — Journey 1 backend (port 4001)
| Route | Purpose |
|---|---|
| `POST /review` | Automated review-by-exception; scans 400 params, surfaces 3 exceptions. `slow_review` flag adds latency. |
| `POST /gxp-release` | Simulated Oracle commit (`oracle.commit` span) + SAP + LIMS calls. `db_error_batch_release` and `gxp_integration_failure` flags inject faults. |

### `services/dispensing-service/` — Journey 2 backend (port 4002)
| Route | Purpose |
|---|---|
| `POST /weigh` | Simulated PLC/scale read (`plc.scale_read` span). `slow_dispensing` and `dispensing_exception` flags inject faults. |

### `services/shared/` — Shared library
| File | Purpose |
|---|---|
| `telemetry.js` | OTel SDK bootstrap (traces/metrics/logs, OTLP/protobuf, delta temporality). Enables `pg` `db.statement` capture via `dbStatementSerializer`. |
| `db.js` | PostgreSQL pool factory. Returns `null` when `DATABASE_URL` is unset (graceful local dev); `connectionTimeoutMillis: 3000` fails fast when DB is down. |
| `logger.js` | Structured JSON logger, trace-correlated, dual-writes stdout + OTel LogRecords. |
| `bizevents.js` | Sends CloudEvents-shaped business events to the Dynatrace bizevents API. |
| `flags.js` | In-memory feature-flag / fault-injection store + Express router. 6 flags, 3 scenarios. |
| `domain.js` | Deterministic domain enrichment (product/material/value) from batch/order IDs via FNV-1a hash. |

## Infrastructure

| File | Purpose |
|---|---|
| `docker-compose.yaml` | Local stack: postgres (healthcheck-gated) + collector + 3 services + loadgen. |
| `k8s/nova-mes.yaml` | Raw manifests — postgres as Deployment + `emptyDir` (ephemeral). |
| `k8s/otel-collector.yaml` | Collector ConfigMap + Deployment + Service. |
| `helm/nova-mes/templates/postgres.yaml` | Postgres StatefulSet + PVC + headless & ClusterIP services + Secret. Gated on `postgres.enabled`. |
| `helm/nova-mes/templates/mes-web.yaml` | mes-web Deployment (LoadBalancer). Injects `DATABASE_URL` from the postgres secret. |
| `helm/nova-mes/values.yaml` | Image, Dynatrace creds, gVisor tolerations/DNS, `postgres` block. |
| `Dockerfile` | Single `node:20-slim` image for all services; command overridden per deployment. |
