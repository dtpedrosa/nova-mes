'use strict';
// Telemetry must be required before anything else so auto-instrumentation hooks http/express.
const { startTelemetry } = require('../shared/telemetry');
startTelemetry(process.env.OTEL_SERVICE_NAME || 'nova-mes-web');

const express = require('express');
const path = require('path');
const { metrics, trace, SpanStatusCode } = require('@opentelemetry/api');
const { makeLogger } = require('../shared/logger');
const { emitBizEvent } = require('../shared/bizevents');
const { FlagStore, flagRouter } = require('../shared/flags');
const { batchContext, orderContext } = require('../shared/domain');
const { getPool } = require('../shared/db');
const { initDatabase } = require('./db-init');

const log = makeLogger('nova-mes-web');
const store = new FlagStore();
const tracer = trace.getTracer('nova-mes-web');
const meter = metrics.getMeter('nova-mes-web');
const pool = getPool();

const BATCH_SVC = process.env.BATCH_SVC_URL || 'http://localhost:4001';
const DISP_SVC = process.env.DISPENSING_SVC_URL || 'http://localhost:4002';
const PORT = Number(process.env.PORT || 4000);
const RUM_OTLP_TARGET =
  process.env.RUM_OTLP_TARGET ||
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  'http://localhost:4318';

// ---- Custom metrics ----
const journeyCounter = meter.createCounter('nova.journey.completed', {
  description: 'Count of completed MES journeys',
});
const journeyErrors = meter.createCounter('nova.journey.errors', {
  description: 'Count of failed MES journeys',
});
const journeyDuration = meter.createHistogram('nova.journey.duration', {
  description: 'End-to-end journey duration',
  unit: 'ms',
});
let batchesInProgress = 7;
meter
  .createObservableGauge('nova.batches.in_progress', { description: 'Batches currently in progress' })
  .addCallback((obs) => obs.observe(batchesInProgress));

const app = express();

// ---- Browser RUM OTLP proxy ----
app.post(
  '/otlp-proxy/v1/:signal',
  express.raw({ type: '*/*', limit: '4mb' }),
  async (req, res) => {
    try {
      const target = `${RUM_OTLP_TARGET.replace(/\/$/, '')}/v1/${req.params.signal}`;
      const headers = { 'Content-Type': req.headers['content-type'] || 'application/x-protobuf' };
      (process.env.OTEL_EXPORTER_OTLP_HEADERS || '')
        .split(',').map((s) => s.trim()).filter(Boolean)
        .forEach((pair) => {
          const i = pair.indexOf('=');
          if (i > 0) headers[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
        });
      const upstream = await fetch(target, { method: 'POST', headers, body: req.body });
      res.status(upstream.status).end();
    } catch (err) {
      log.error('otlp proxy failed', { error: String(err.message || err) });
      res.status(502).end();
    }
  }
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Fan-out flag changes to backend services.
async function fanout(pathname, body) {
  await Promise.allSettled(
    [BATCH_SVC, DISP_SVC].map((base) =>
      fetch(`${base}/_flags${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {})
    )
  );
}
app.use('/_flags', flagRouter(express, store, async (flag, value) => {
  log.event('flag.changed', { 'event.outcome': 'changed', 'nova.flag.name': flag, 'nova.flag.value': value });
  if (flag === 'scenario') await fanout('/scenario', { scenario: value });
  else if (flag === '*') await fanout('/reset', {});
  else await fanout('', { flag, value });
}));

// ---- DB persistence helpers (fire-and-forget, never throw) ----
async function persistBatch(bctx, status, exceptions) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO batch_records
         (batch_id, product_code, product_name, status, quantity_units, value_usd,
          site, line, created_at, released_at, review_exceptions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),
         CASE WHEN $4='released' THEN NOW() ELSE NULL END, $9)
       ON CONFLICT (batch_id) DO UPDATE SET
         status=EXCLUDED.status,
         released_at=EXCLUDED.released_at,
         review_exceptions=EXCLUDED.review_exceptions`,
      [
        bctx['nova.batch.id'],
        bctx['nova.product.code'],
        bctx['nova.product.name'],
        status,
        bctx['nova.batch.quantity_units'],
        bctx['nova.batch.value_usd'],
        bctx['nova.site'],
        bctx['nova.line'],
        exceptions || 0,
      ]
    );
  } catch (err) {
    log.warn('persistBatch failed', { error: String(err) });
  }
}

async function persistWorkOrder(octx, status, actualKg) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO work_orders
         (order_id, material_code, material_name, target_kg, actual_kg,
          status, site, line, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),
         CASE WHEN $6='completed' THEN NOW() ELSE NULL END)
       ON CONFLICT (order_id) DO UPDATE SET
         status=EXCLUDED.status,
         actual_kg=EXCLUDED.actual_kg,
         completed_at=EXCLUDED.completed_at`,
      [
        octx['nova.order.id'],
        octx['nova.material.code'],
        octx['nova.material.name'],
        octx['nova.dispense.target_kg'],
        actualKg || null,
        status,
        octx['nova.site'],
        octx['nova.line'],
      ]
    );
  } catch (err) {
    log.warn('persistWorkOrder failed', { error: String(err) });
  }
}

async function persistDeviation(referenceId, referenceType, severity, description, site) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO deviations (reference_id, reference_type, severity, description, site)
       VALUES ($1,$2,$3,$4,$5)`,
      [referenceId, referenceType, severity, description, site]
    );
  } catch (err) {
    log.warn('persistDeviation failed', { error: String(err) });
  }
}

async function updateEquipmentSeen(equipmentId, readingJson) {
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE equipment SET last_reading_json=$2, last_seen_at=NOW() WHERE equipment_id=$1`,
      [equipmentId, readingJson]
    );
  } catch (err) {
    log.warn('updateEquipmentSeen failed', { error: String(err) });
  }
}

// ---- Journey 1: Electronic batch record release ----
app.post('/api/journey/batch-release', async (req, res) => {
  const t0 = Date.now();
  const batchId = (req.body && req.body.batchId) || `NX-${88000 + Math.floor(Math.random() * 999)}`;
  const bctx = batchContext(batchId);
  const jlog = log.child(bctx);
  let stage = 'accepted';
  let review = null;
  await tracer.startActiveSpan('journey.batch_release', async (span) => {
    span.setAttributes(bctx);
    try {
      jlog.event('batch.release.started', { 'event.outcome': 'started' });
      await emitBizEvent('batch.release.started', bctx);

      stage = 'review';
      review = await callJson(`${BATCH_SVC}/review`, { batchId });
      stage = 'gxp_release';
      const gxp = await callJson(`${BATCH_SVC}/gxp-release`, { batchId });

      const dur = Date.now() - t0;
      const firstPass = review.exceptions === 0;
      journeyCounter.add(1, { journey: 'batch_release', outcome: 'released' });
      journeyDuration.record(dur, { journey: 'batch_release' });
      await emitBizEvent('batch.released', {
        ...bctx, exceptions: review.exceptions, cycleTimeDays: 2.1, sap: gxp.sap, lims: gxp.lims,
      });
      jlog.event('batch.release.completed', {
        'event.outcome': 'released',
        'nova.review.parameters_scanned': review.parametersScanned,
        'nova.review.exceptions': review.exceptions,
        'nova.batch.first_pass': firstPass,
        'nova.gxp.sap_status': gxp.sap && gxp.sap.status,
        'nova.gxp.lims_status': gxp.lims && gxp.lims.status,
        'nova.batch.cycle_time_days': 2.1,
        'nova.batch.duration_ms': dur,
      });
      span.end();
      res.json({ ok: true, batchId, review, gxp, durMs: dur });
      persistBatch(bctx, 'released', review.exceptions).catch(() => {});
    } catch (err) {
      const dur = Date.now() - t0;
      journeyErrors.add(1, { journey: 'batch_release' });
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err.message || err) });
      await emitBizEvent('batch.release.failed', { ...bctx, stage, reason: String(err.message || err) });
      jlog.event('batch.release.failed', {
        'event.outcome': 'failed',
        'nova.failure.stage': stage,
        'nova.failure.reason': String(err.message || err),
        'nova.batch.duration_ms': dur,
      });
      span.end();
      res.status(502).json({ ok: false, batchId, error: String(err.message || err) });
      persistBatch(bctx, 'failed', review ? review.exceptions : 0).catch(() => {});
      persistDeviation(
        bctx['nova.batch.id'], 'batch', 'major',
        `${stage}: ${String(err.message || err)}`,
        bctx['nova.site']
      ).catch(() => {});
    }
  });
});

// ---- Journey 2: Shop-floor weigh & dispense ----
app.post('/api/journey/dispense', async (req, res) => {
  const t0 = Date.now();
  const orderId = (req.body && req.body.orderId) || `WO-${5000 + Math.floor(Math.random() * 999)}`;
  const octx = orderContext(orderId);
  const jlog = log.child(octx);
  await tracer.startActiveSpan('journey.dispense', async (span) => {
    span.setAttributes(octx);
    try {
      jlog.event('dispense.started', { 'event.outcome': 'started' });
      await emitBizEvent('dispense.started', octx);

      const weigh = await callJson(`${DISP_SVC}/weigh`, { orderId });

      const dur = Date.now() - t0;
      journeyCounter.add(1, { journey: 'dispense', outcome: 'ok' });
      journeyDuration.record(dur, { journey: 'dispense' });
      await emitBizEvent('dispense.completed', { ...octx, netWeightKg: weigh.netWeightKg, durMs: dur });
      jlog.event('dispense.completed', {
        'event.outcome': 'completed',
        'nova.dispense.net_weight_kg': weigh.netWeightKg,
        'nova.dispense.deviation_kg': weigh.deviationKg,
        'nova.dispense.within_tolerance': weigh.withinTolerance,
        'nova.dispense.duration_ms': dur,
      });
      span.end();
      res.json({ ok: true, orderId, weigh, durMs: dur });
      persistWorkOrder(octx, 'completed', weigh.netWeightKg).catch(() => {});
      updateEquipmentSeen('SCALE-L3-02', { net_kg: weigh.netWeightKg, unit: 'kg' }).catch(() => {});
    } catch (err) {
      const dur = Date.now() - t0;
      journeyErrors.add(1, { journey: 'dispense' });
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err.message || err) });
      await emitBizEvent('dispense.deviation', { ...octx, reason: String(err.message || err) });
      jlog.event('dispense.deviation', {
        'event.outcome': 'deviation',
        'nova.failure.reason': String(err.message || err),
        'nova.dispense.duration_ms': dur,
      });
      span.end();
      res.status(502).json({ ok: false, orderId, error: String(err.message || err) });
      persistWorkOrder(octx, 'deviation', null).catch(() => {});
      persistDeviation(
        octx['nova.order.id'], 'work_order', 'minor',
        String(err.message || err),
        octx['nova.site']
      ).catch(() => {});
    }
  });
});

// RUM error-injection probe
app.get('/api/flags/rum', (_req, res) => res.json({ rum_js_error: store.get('rum_js_error') }));

// ---- Database query routes ----
app.get('/api/batches', async (_req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM batch_records ORDER BY created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (err) {
    log.error('batches query failed', { error: String(err) });
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/work-orders', async (_req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM work_orders ORDER BY created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (err) {
    log.error('work-orders query failed', { error: String(err) });
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/equipment', async (_req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM equipment ORDER BY site, line'
    );
    res.json(rows);
  } catch (err) {
    log.error('equipment query failed', { error: String(err) });
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/deviations', async (_req, res) => {
  if (!pool) return res.json([]);
  try {
    const { rows } = await pool.query(
      'SELECT * FROM deviations ORDER BY created_at DESC LIMIT 50'
    );
    res.json(rows);
  } catch (err) {
    log.error('deviations query failed', { error: String(err) });
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/api/dashboard/kpis', async (_req, res) => {
  if (!pool) {
    return res.json({
      batchesToday: 0, activeWorkOrders: 0, openDeviations: 0, equipmentFaults: 0,
      recentBatches: [], recentActivity: [],
    });
  }
  try {
    const kpiRes = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM batch_records WHERE created_at >= CURRENT_DATE)     AS "batchesToday",
        (SELECT COUNT(*)::int FROM work_orders  WHERE status = 'in_progress')          AS "activeWorkOrders",
        (SELECT COUNT(*)::int FROM deviations   WHERE status = 'open')                 AS "openDeviations",
        (SELECT COUNT(*)::int FROM equipment    WHERE status = 'fault')                AS "equipmentFaults"
    `);
    const batchRes = await pool.query(
      'SELECT * FROM batch_records ORDER BY created_at DESC LIMIT 10'
    );
    const activityRes = await pool.query(`
      (SELECT 'batch'     AS type, batch_id     AS ref, status, created_at FROM batch_records ORDER BY created_at DESC LIMIT 5)
      UNION ALL
      (SELECT 'deviation' AS type, reference_id AS ref, status, created_at FROM deviations    ORDER BY created_at DESC LIMIT 5)
      ORDER BY created_at DESC LIMIT 5
    `);
    res.json({
      ...kpiRes.rows[0],
      recentBatches: batchRes.rows,
      recentActivity: activityRes.rows,
    });
  } catch (err) {
    log.error('kpis query failed', { error: String(err) });
    res.status(500).json({ error: 'query failed' });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'nova-mes-web' }));

async function callJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `downstream ${res.status} from ${url}`);
  return json;
}

initDatabase(pool)
  .catch((err) => log.warn('db init failed, continuing without DB', { error: String(err) }))
  .finally(() => app.listen(PORT, () => log.info(`nova-mes-web listening on :${PORT}`)));
