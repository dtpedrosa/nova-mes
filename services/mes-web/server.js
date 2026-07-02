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

const log = makeLogger('nova-mes-web');
const store = new FlagStore();
const tracer = trace.getTracer('nova-mes-web');
const meter = metrics.getMeter('nova-mes-web');

const BATCH_SVC = process.env.BATCH_SVC_URL || 'http://localhost:4001';
const DISP_SVC = process.env.DISPENSING_SVC_URL || 'http://localhost:4002';
const PORT = Number(process.env.PORT || 4000);
// Where the browser's OTLP traces are forwarded. Point at the collector's HTTP
// receiver (default 4318). Falls back to OTEL_EXPORTER_OTLP_ENDPOINT if set.
const RUM_OTLP_TARGET =
  process.env.RUM_OTLP_TARGET ||
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  'http://localhost:4318';

// ---- Custom metrics (OTLP, delta temporality via shared telemetry) ----
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
// The OTel Web SDK POSTs protobuf/JSON to /otlp-proxy/v1/traces. We forward it
// to the collector server-side. This keeps the Dynatrace token off the browser
// and sidesteps CORS to the tenant. Raw body parser is scoped to this route only.
app.post(
  '/otlp-proxy/v1/:signal',
  express.raw({ type: '*/*', limit: '4mb' }),
  async (req, res) => {
    try {
      const target = `${RUM_OTLP_TARGET.replace(/\/$/, '')}/v1/${req.params.signal}`;
      const headers = { 'Content-Type': req.headers['content-type'] || 'application/x-protobuf' };
      // Attach tenant auth here if forwarding straight to Dynatrace instead of a collector.
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

// Fan-out flag changes to backend services so one toggle flips the whole system.
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
  log.warn('feature flag changed', { flag, value });
  if (flag === 'scenario') await fanout('/scenario', { scenario: value });
  else if (flag === '*') await fanout('/reset', {});
  else await fanout('', { flag, value });
}));

// ---- Journey 1: Electronic batch record release ----
app.post('/api/journey/batch-release', async (req, res) => {
  const t0 = Date.now();
  const batchId = (req.body && req.body.batchId) || `NX-${88000 + Math.floor(Math.random() * 999)}`;
  await tracer.startActiveSpan('journey.batch_release', async (span) => {
    span.setAttribute('nova.batch.id', batchId);
    try {
      log.info('batch release started', { batchId });
      await emitBizEvent('batch.release.started', { batchId, line: 'line-2' });

      // Step: automated review-by-exception (may be slowed by flag on the batch svc).
      const review = await callJson(`${BATCH_SVC}/review`, { batchId });
      // Step: GxP integration to SAP + LIMS (may fail by flag).
      const gxp = await callJson(`${BATCH_SVC}/gxp-release`, { batchId });

      const dur = Date.now() - t0;
      journeyCounter.add(1, { journey: 'batch_release', outcome: 'released' });
      journeyDuration.record(dur, { journey: 'batch_release' });
      await emitBizEvent('batch.released', {
        batchId, line: 'line-2', exceptions: review.exceptions,
        cycleTimeDays: 2.1, sap: gxp.sap, lims: gxp.lims,
      });
      log.info('batch released', { batchId, durMs: dur });
      span.end();
      res.json({ ok: true, batchId, review, gxp, durMs: dur });
    } catch (err) {
      journeyErrors.add(1, { journey: 'batch_release' });
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err.message || err) });
      await emitBizEvent('batch.release.failed', { batchId, reason: String(err.message || err) });
      log.error('batch release failed', { batchId, error: String(err.message || err) });
      span.end();
      res.status(502).json({ ok: false, batchId, error: String(err.message || err) });
    }
  });
});

// ---- Journey 2: Shop-floor deviation (weigh & dispense) ----
app.post('/api/journey/dispense', async (req, res) => {
  const t0 = Date.now();
  const orderId = (req.body && req.body.orderId) || `WO-${5000 + Math.floor(Math.random() * 999)}`;
  await tracer.startActiveSpan('journey.dispense', async (span) => {
    span.setAttribute('nova.order.id', orderId);
    try {
      log.info('dispense started', { orderId });
      await emitBizEvent('dispense.started', { orderId, line: 'line-3', material: 'API-lot-4471' });

      const weigh = await callJson(`${DISP_SVC}/weigh`, { orderId });

      const dur = Date.now() - t0;
      journeyCounter.add(1, { journey: 'dispense', outcome: 'ok' });
      journeyDuration.record(dur, { journey: 'dispense' });
      await emitBizEvent('dispense.completed', { orderId, line: 'line-3', netWeightKg: weigh.netWeightKg, durMs: dur });
      log.info('dispense completed', { orderId, durMs: dur });
      span.end();
      res.json({ ok: true, orderId, weigh, durMs: dur });
    } catch (err) {
      journeyErrors.add(1, { journey: 'dispense' });
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err.message || err) });
      await emitBizEvent('dispense.deviation', { orderId, line: 'line-3', reason: String(err.message || err) });
      log.error('dispense deviation raised', { orderId, error: String(err.message || err) });
      span.end();
      res.status(502).json({ ok: false, orderId, error: String(err.message || err) });
    }
  });
});

// RUM error-injection probe: the frontend reads this flag to decide whether to
// throw a JS error inside a user action (see public/app.js).
app.get('/api/flags/rum', (_req, res) => res.json({ rum_js_error: store.get('rum_js_error') }));

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

app.listen(PORT, () => log.info(`nova-mes-web listening on :${PORT}`));
