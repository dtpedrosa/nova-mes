# Data Flows

The three primary flows through Nova-MES. Each is a single distributed trace in Dynatrace.

## 1. Batch Release (Journey 1)

```
Browser click "Release batch"
  │ RUM span: user_action:Release batch
  ▼
POST /api/journey/batch-release          [nova-mes-web]  span: journey.batch_release
  ├─► POST /review        [batch-service]  — 400 params scanned, 3 exceptions
  │        └─ (slow_review flag → +2.5s)
  └─► POST /gxp-release   [batch-service]  span: oracle.commit
           ├─ gxp.sap.call   (db_error_batch_release → ORA-00060 deadlock)
           └─ gxp.lims.call  (gxp_integration_failure → SAP/LIMS 503)
  ▼
res.json({ok, ...}) → browser  (green/red result banner)
  │
  ├─ (async) UPSERT batch_records status=released|failed   [PostgreSQL]  pg span
  └─ on failure: INSERT deviations severity=major          [PostgreSQL]  pg span
  ▼
Browser GET /api/batches → table refreshes with new row
```

**Metrics emitted:** `nova.journey.completed{journey=batch_release}`,
`nova.journey.duration`, `nova.review.exceptions`, `nova.db.commit_latency`.
**Business events:** `batch.release.started` → `batch.released` | `batch.release.failed`.

## 2. Weigh & Dispense (Journey 2)

```
Browser click "Dispense material"
  │ RUM span: user_action:Dispense material
  ▼
POST /api/journey/dispense               [nova-mes-web]  span: journey.dispense
  └─► POST /weigh         [dispensing-service]  span: plc.scale_read
           ├─ (slow_dispensing flag → 3.5–4.5s)
           └─ (dispensing_exception flag → SCALE_TIMEOUT)
  ▼
res.json({ok, weigh}) → browser  (result banner)
  │
  ├─ (async) UPSERT work_orders status=completed|deviation, actual_kg  [PostgreSQL]
  ├─ (async) UPDATE equipment SCALE-L3-02 last_reading + last_seen      [PostgreSQL]
  └─ on failure: INSERT deviations severity=minor                       [PostgreSQL]
  ▼
Browser GET /api/work-orders → table refreshes
```

**Metrics emitted:** `nova.journey.completed{journey=dispense}`,
`nova.dispense.latency`, `nova.dispense.net_weight`.
**Business events:** `dispense.started` → `dispense.completed` | `dispense.deviation`.

## 3. Dashboard KPIs (read path)

```
Browser loads #dashboard  (and every 15s thereafter)
  ▼
GET /api/dashboard/kpis                  [nova-mes-web]
  ├─ compound COUNT query  → batchesToday, activeWorkOrders,
  │                          openDeviations, equipmentFaults      [PostgreSQL]
  ├─ SELECT last 10 batch_records         → recentBatches (chart)  [PostgreSQL]
  └─ UNION last 5 batches + deviations    → recentActivity (feed)  [PostgreSQL]
  ▼
Browser renders KPI tiles + Chart.js bar chart + activity feed
```

## Fault-injection fan-out (control path)

```
Browser toggles a flag on Control Panel
  ▼
POST /_flags {flag, value}               [nova-mes-web]
  └─ fan-out → POST /_flags on batch-service + dispensing-service
                (keeps all three processes' in-memory flag state in sync)
```

## Graceful degradation

| Condition | Behaviour |
|---|---|
| `DATABASE_URL` unset | `getPool()` returns `null`; list endpoints return `[]`; journeys still work; UI shows empty-state messages. |
| DB unreachable at startup | `initDatabase` catches, logs a warning, `app.listen` still fires. |
| DB drops mid-run | Queries throw (3s timeout), caught per-route → 500; journey telemetry unaffected; pool auto-reconnects. |
| Journey DB write fails | Fire-and-forget `.catch()` swallows it — the user-facing journey response is never blocked. |
