# Nova Pharma MES — Dynatrace observability demo

A fully runnable, **anonymized** pharmaceutical Manufacturing Execution System (MES)
demo, instrumented end to end for Dynatrace. Built to showcase full-stack
observability against two mission-critical customer journeys, with a fault-injection
control panel so you can turn the demo red on command in front of a prospect.

No real company names appear anywhere — the fictional site is "Nova Pharma,
Northgate site."

---

## Getting it into Git

```bash
cp .env.example .env      # then fill in your Dynatrace endpoint + token (gitignored)
npm install               # generates package-lock.json — commit it for reproducible builds
git init && git add . && git commit -m "Add Nova Pharma MES OpenTelemetry demo"
git remote add origin <your-repo-url>
git push -u origin main
```

Repo hygiene included: `.gitignore` (excludes `node_modules`, `.env`, logs),
`.env.example` (all variables documented), `LICENSE` (MIT — change if needed),
and a GitHub Actions workflow (`.github/workflows/ci.yml`) that installs deps,
syntax-checks every file, runs the flag-logic smoke test, and builds the Docker
image on each push and PR. No secrets are committed — the Dynatrace token is only
ever read from the environment or the k8s secret.

---

## What it demonstrates

| Signal | How it shows up | Where in code |
|---|---|---|
| **Distributed traces** | Browser → `nova-mes-web` → `batch`/`dispensing` → simulated Oracle / SAP / LIMS / PLC, as one trace | OTel auto-instrumentation + manual spans in every `server.js` |
| **Metrics** | `nova.journey.*`, `nova.dispense.latency`, `nova.db.commit_latency`, `nova.batches.in_progress`, etc. (OTLP, **delta** temporality — Dynatrace-native) | `metrics.getMeter(...)` in each service |
| **Logs** | Structured JSON on stdout, auto-correlated to traces via `dt.trace_id` | `shared/logger.js` |
| **Business events** | `batch.released`, `dispense.deviation`, `batch.gxp.released`, … to `/api/v2/bizevents/ingest` | `shared/bizevents.js` |
| **Business flow** | Both journeys emit an ordered chain of bizevents that reconstruct the process | see "Business flow" below |
| **RUM** | OpenTelemetry Web SDK instruments the browser as a first-class OTel tier — page load, fetch/XHR, named user actions, and JS errors as spans; W3C context links browser spans to backend spans in one trace. **No OneAgent.** | `services/mes-web/public/rum-otel.js`, `app.js` |
| **Load generator** | Continuous realistic traffic through both journeys | `loadgen/loadgen.js` |
| **Feature flags / fault injection** | Toggle errors, exceptions, and slow actions at key points | `shared/flags.js` + control panel in the UI |

---

## The two customer journeys

**Journey 1 — Electronic batch record release** (`nova-mes-web` → `nova-batch-service`)
1. `journey.batch_release` span opens; `batch.release.started` bizevent.
2. `batch.review_by_exception` — scans 400 process parameters, surfaces 3 exceptions.
3. `batch.gxp_release` — child `oracle.commit` span, then `gxp.sap.call` + `gxp.lims.call`.
4. `batch.released` bizevent with cycle time; audit trail complete.

**Journey 2 — Weigh & dispense deviation RCA** (`nova-mes-web` → `nova-dispensing-service`)
1. `journey.dispense` span opens; `dispense.started` bizevent.
2. `dispense.weigh` → child `plc.scale_read` span models the shop-floor scale.
3. On success: `dispense.weighed` + `dispense.completed` bizevents, net-weight metric.
4. Under fault: latency climbs / `SCALE_TIMEOUT` exception → `dispense.deviation` bizevent.

---

## Run it locally (no Kubernetes needed)

Requires Node 20+.

```bash
npm install            # installs all workspaces (needs network for npm registry)

# Optional — point at your Dynatrace tenant. Omit to run fully local (telemetry
# prints to stdout, bizevents log as JSON, app still works end to end).
export OTEL_EXPORTER_OTLP_ENDPOINT="https://<env>.live.dynatrace.com/api/v2/otlp"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Api-Token dt0c01.XXXX"
export DT_TENANT_URL="https://<env>.live.dynatrace.com"
export DT_API_TOKEN="dt0c01.XXXX"     # scopes: bizevents.ingest (+ others below)

npm run dev            # starts batch, dispensing, and web together
# in another terminal:
npm run start:loadgen  # drives traffic
```

Open **http://localhost:4000**.

Browser RUM works automatically: the page loads the OTel Web SDK, and browser
spans post to `/otlp-proxy`, which forwards to the collector. For local `npm run
dev` (no collector), set `RUM_OTLP_TARGET` to a reachable OTLP endpoint or use
the Docker Compose path below, which includes the collector.

### With Docker Compose

```bash
docker compose up --build     # includes the load generator
```

Required API token scopes: `openTelemetryTrace.ingest`, `metrics.ingest`,
`logs.ingest`, `bizevents.ingest`.

---

## Run it on GKE

The app is instrumented entirely with **OpenTelemetry** — no OneAgent. All
telemetry (backend and browser) flows over OTLP to the OpenTelemetry Collector,
which forwards to Dynatrace's native OTLP endpoint. So Kubernetes is optional;
it's just a realistic place to run the microservices and the collector together.

```bash
# 1. Build and push the image to your registry (or load into the cluster).
docker build -t nova-mes:latest .

# 2. Deploy an OpenTelemetry Collector reachable at otel-collector:4318 in the
#    cluster, using otel/collector-config.yaml (set DT_ENDPOINT + DT_API_TOKEN).
#    The services and the browser proxy send OTLP here; it forwards to Dynatrace.

# 3. Create the telemetry secret and apply.
kubectl create namespace nova-mes
kubectl -n nova-mes create secret generic nova-mes-otel \
  --from-literal=otlp-endpoint="https://<env>.live.dynatrace.com/api/v2/otlp" \
  --from-literal=otlp-headers="Authorization=Api-Token dt0c01.XXXX" \
  --from-literal=tenant-url="https://<env>.live.dynatrace.com" \
  --from-literal=api-token="dt0c01.XXXX"
kubectl apply -f k8s/

# 4. Get the external IP of the nova-mes-web service and open it in a browser.
kubectl -n nova-mes get svc nova-mes-web
```

### Browser RUM (OpenTelemetry) — what to verify
- The frontend loads `rum-otel.js` (OTel Web SDK) from the `<head>`. No agent,
  no injection step — it's an ordinary ES module.
- User clicks run inside `user_action:*` spans (via `window.novaRum`), which
  parent the `fetch` spans to the backend. W3C `traceparent` propagation stitches
  the browser span and the server spans into ONE distributed trace.
- Browser spans, page-load spans, and JS errors export OTLP to `/otlp-proxy` on
  the web server, which forwards to the collector (keeps the token server-side,
  avoids browser CORS to the tenant).
- Confirm in Dynatrace: open a distributed trace and check it starts at the
  `nova-mes-frontend` service and continues into `nova-mes-web` and the backends.
- Everything degrades gracefully: if the SDK fails to load, `window.novaRum`
  no-ops and the app still works.

---

## The live demo script (turn it red on command)

Start clean, prove the happy path, then inject faults from the control panel.

1. **Healthy baseline.** Click *Reset · healthy*. Run *Release batch* and
   *Dispense material* a few times. Show the traces, the business-flow bizevents,
   and the browser user-action spans in Dynatrace. Leave the load generator running.

2. **Journey 2 — deviation RCA.** Click *Scenario · dispensing deviation*
   (arms `slow_dispensing` + `dispensing_exception`). Run *Dispense material*:
   - latency jumps to ~4s, then the `plc.scale_read` span throws `SCALE_TIMEOUT`;
   - the failing span, the `dispense.deviation` bizevent, and the error logs all
     line up on one trace. Narrate Davis AI root cause + auto-remediation.

3. **Journey 1 — release failure.** Click *Scenario · release failure*
   (arms `db_error_batch_release` + `gxp_integration_failure`). Run *Release
   batch*: the `oracle.commit` span shows `ORA-00060` and/or `gxp.sap.call`
   returns 503; `batch.release.failed` bizevent fires. Show how the audit trail
   still captures the failed attempt.

4. **RUM error.** Toggle the `RUM JS error` flag and run either journey: the
   frontend reports a custom error via `window.novaRum.reportError`, exported as an error span.

5. **Reset.** Click *Reset · healthy* to return to green.

Individual flags can be toggled independently in the control panel for finer control.

---

## Project layout

```
nova-mes/
├── services/
│   ├── shared/           telemetry.js, bizevents.js, logger.js, flags.js
│   ├── mes-web/          frontend + orchestrator (browser OTel RUM + OTLP proxy)
│   │   └── public/       index.html, app.js, rum-otel.js (OTel Web SDK), styles.css
│   ├── batch-service/    Journey 1 backend
│   └── dispensing-service/ Journey 2 backend
├── loadgen/              continuous traffic generator
├── otel/                 collector-config.yaml (incl. cumulativetodelta pipeline)
├── k8s/                  nova-mes.yaml (all deployments + services + loadgen)
├── Dockerfile
└── docker-compose.yaml
```

## Notes on metric temporality
The app exports **delta** OTLP metrics directly, so it needs no
`cumulativetodelta` processor. The collector config still ships one on a separate
`metrics/cumulative` pipeline for third-party cumulative sources (e.g. an
OpenTelemetry Astronomy Shop demo) you may route through the same gateway.
