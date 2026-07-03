# Nova MES — Dynatrace dashboards

Two Dynatrace **Platform** dashboards (Grail/DQL) for the Nova MES demo:

| File | Audience | Focus |
|------|----------|-------|
| `nova-mes-business-dashboard.json` | Ops / plant management | Value released, units, batch/dispense yield, deviations |
| `nova-mes-service-dashboard.json` | SRE / platform | RED metrics per service, journey & DB latency, log health |

## Business dashboard

`nova-mes-business-dashboard.json` is built entirely on the `nova.*` business-event
logs the services emit (`event.name` = `batch.release.*`, `batch.review.*`,
`batch.gxp.*`, `dispense.*`). No metrics or extensions required.

## Import

1. In Dynatrace open **Dashboards**.
2. **Upload** (top-right ▾ menu) → select `nova-mes-business-dashboard.json`.
3. Set the timeframe (e.g. last 2h) and the `site` / `line` filter variables.

> Must be the tenant nova-mes actually exports to — **`mbr52431.sprint.dynatracelabs.com`**.
> (The MCP server in `.vscode/mcp.json` points at a *different* tenant, `guu84124`,
> which has no nova-mes data.)

If the tenant rejects the `version` field on import, create an empty dashboard,
then add tiles and paste the DQL below — the queries are the durable part.

## Field reference (log attributes)

Business events carry: `event.name`, `event.outcome`, `nova.site`, `nova.line`,
and per journey:

- **Batch release:** `nova.product.code|name|form`, `nova.batch.quantity_units`,
  `nova.batch.value_usd`, `nova.review.exceptions`, `nova.batch.first_pass`,
  `nova.gxp.sap_status`, `nova.gxp.lims_status`, `nova.batch.cycle_time_days`,
  `nova.batch.duration_ms`, `nova.failure.stage`, `nova.failure.reason`
- **Dispensing:** `nova.material.code|name`, `nova.dispense.target_kg`,
  `nova.dispense.net_weight_kg`, `nova.dispense.deviation_kg`,
  `nova.dispense.within_tolerance`, `nova.dispense.duration_ms`

Field names contain literal dots, so they are wrapped in backticks in DQL.

## Tiles (raw DQL)

**Value Released (USD)**
```dql
fetch logs
| filter `event.name` == "batch.release.completed"
| summarize `Value Released` = sum(`nova.batch.value_usd`)
```

**Batch Release Success Rate**
```dql
fetch logs
| filter `event.name` == "batch.release.completed" or `event.name` == "batch.release.failed"
| summarize success_rate = countIf(`event.outcome` == "released") * 100.0 / count()
```

**Value Released Over Time by Product**
```dql
fetch logs
| filter `event.name` == "batch.release.completed"
| makeTimeseries value_usd = sum(`nova.batch.value_usd`), by:{`nova.product.name`}
```

**First-Pass Yield by Line (%)**
```dql
fetch logs
| filter `event.name` == "batch.release.completed"
| summarize fpy = countIf(`nova.batch.first_pass` == true) * 100.0 / count(), by:{`nova.line`}
| sort fpy desc
```

**Batch Release Failures by Stage**
```dql
fetch logs
| filter `event.name` == "batch.release.failed"
| summarize failures = count(), by:{`nova.failure.stage`}
| sort failures desc
```

**Units Released by Product**
```dql
fetch logs
| filter `event.name` == "batch.release.completed"
| summarize units = sum(`nova.batch.quantity_units`), by:{`nova.product.name`}
| sort units desc
```

**Dispense Tolerance Conformance by Material (%)**
```dql
fetch logs
| filter `event.name` == "dispense.weighed"
| summarize conformance_pct = countIf(`nova.dispense.within_tolerance` == true) * 100.0 / count(), by:{`nova.material.name`}
| sort conformance_pct desc
```

**Dispense Throughput Over Time**
```dql
fetch logs
| filter `event.name` == "dispense.completed"
| makeTimeseries dispenses = count()
```

**Avg Net-Weight Deviation by Material (kg)**
```dql
fetch logs
| filter `event.name` == "dispense.weighed"
| summarize avg_deviation_kg = avg(`nova.dispense.deviation_kg`),
            max_deviation_kg = max(abs(`nova.dispense.deviation_kg`)),
            by:{`nova.material.name`}
| sort avg_deviation_kg desc
```

**Recent Business Events**
```dql
fetch logs
| filter isNotNull(`event.name`)
| sort timestamp desc
| fields timestamp, `event.name`, `event.outcome`, `nova.site`, `nova.line`,
         `nova.product.name`, `nova.material.name`, `nova.batch.value_usd`, `nova.failure.stage`
| limit 100
```

## Same data as business events

These `nova.*` dimensions are also emitted as Dynatrace **bizevents** and set as
**span attributes**, so you can rebuild any tile with `fetch bizevents` or from
traces if you prefer that over logs.

## Service & infrastructure dashboard

`nova-mes-service-dashboard.json` is the SRE counterpart. Nova pods are
OpenTelemetry-only (no OneAgent), so it draws on service RED metrics, the custom
`nova.*` OpenTelemetry metrics, and namespace logs rather than container metrics.

Scope: the three services `nova-mes-web`, `nova-batch-service`,
`nova-dispensing-service` (namespace `nova-mes`).

### KPIs
- **Avg Response Time (ms)**, **Total Requests**, **Failure Rate %** — from
  `dt.service.request.response_time` / `.count` / `.failure_count`
- **Error / Warn Logs** — `fetch logs | filter k8s.namespace.name == "nova-mes"`

### Charts
- **Request Throughput / Response Time / Failure Rate by Service** — RED metrics
  grouped by `dt.entity.service`
- **Log Volume by Level** — `makeTimeseries count(), by:{loglevel}`
- **End-to-End Journey Duration** — `nova.journey.duration` by `journey`
- **DB Commit Latency (Oracle)** — `nova.db.commit_latency` by `table`
- **Weigh / Dispense Latency** — `nova.dispense.latency` by `line`
- **Batches In Progress** — `nova.batches.in_progress` observable gauge
- **Journeys Completed vs Errors** — `nova.journey.completed` / `nova.journey.errors`
- **Service Health Summary** table + **Recent Errors & Warnings** log table

### Custom OpenTelemetry metrics (emitted by the services)

| Metric | Type | Dimensions |
|--------|------|-----------|
| `nova.journey.completed` | counter | `journey`, `outcome` |
| `nova.journey.errors` | counter | `journey` |
| `nova.journey.duration` | histogram | `journey` |
| `nova.batches.in_progress` | gauge | — |
| `nova.review.exceptions` | histogram | `batch` |
| `nova.db.commit_latency` | histogram | `table` |
| `nova.dispense.latency` | histogram | `line` |
| `nova.dispense.net_weight` | histogram | `line`, `material` |

> Flip the demo scenario flags (`slow_review`, `dispensing_exception`,
> `db_error_batch_release`, …) to make the failure-rate, latency and
> error-log tiles light up.
