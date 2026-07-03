'use strict';
const { startTelemetry } = require('../shared/telemetry');
startTelemetry(process.env.OTEL_SERVICE_NAME || 'nova-batch-service');

const express = require('express');
const { metrics, trace, SpanStatusCode } = require('@opentelemetry/api');
const { makeLogger } = require('../shared/logger');
const { emitBizEvent } = require('../shared/bizevents');
const { FlagStore, flagRouter } = require('../shared/flags');
const { batchContext } = require('../shared/domain');

const log = makeLogger('nova-batch-service');
const store = new FlagStore();
const tracer = trace.getTracer('nova-batch-service');
const meter = metrics.getMeter('nova-batch-service');
const PORT = Number(process.env.PORT || 4001);

const reviewExceptions = meter.createHistogram('nova.review.exceptions', {
  description: 'Number of process-parameter exceptions surfaced per review',
});
const dbCommitLatency = meter.createHistogram('nova.db.commit_latency', {
  description: 'Simulated Oracle commit latency', unit: 'ms',
});

const app = express();
app.use(express.json());
app.use('/_flags', flagRouter(express, store));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Step 2 of Journey 1: automated review-by-exception.
app.post('/review', async (req, res) => {
  await tracer.startActiveSpan('batch.review_by_exception', async (span) => {
    const batchId = req.body.batchId;
    const bctx = batchContext(batchId);
    const rlog = log.child(bctx);
    span.setAttributes(bctx);
    const t0 = Date.now();
    try {
      const degraded = store.get('slow_review');
      if (degraded) {
        rlog.warn('review-by-exception degraded (slow_review flag)', { 'nova.review.degraded': true });
        await sleep(2500 + Math.random() * 500);
      }
      // Simulate scanning 400 process parameters against the golden batch.
      const parametersScanned = 400;
      const exceptions = 3;
      const dur = Date.now() - t0;
      reviewExceptions.record(exceptions, { batch: batchId });
      await emitBizEvent('batch.review.completed', { ...bctx, parametersScanned, exceptions });
      rlog.event('batch.review.completed', {
        'event.outcome': 'completed',
        'nova.review.parameters_scanned': parametersScanned,
        'nova.review.exceptions': exceptions,
        'nova.review.first_pass': exceptions === 0,
        'nova.review.degraded': degraded,
        'nova.review.duration_ms': dur,
      });
      span.setAttribute('nova.review.exceptions', exceptions);
      span.end();
      res.json({ ok: true, exceptions, parametersScanned });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      rlog.event('batch.review.failed', { 'event.outcome': 'failed', 'nova.failure.reason': String(err.message || err) });
      span.end();
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });
});

// Step 3 of Journey 1: commit to Oracle + push to SAP ERP and LIMS.
app.post('/gxp-release', async (req, res) => {
  await tracer.startActiveSpan('batch.gxp_release', async (span) => {
    const batchId = req.body.batchId;
    const bctx = batchContext(batchId);
    const glog = log.child(bctx);
    span.setAttributes(bctx);
    const t0 = Date.now();
    let stage = 'oracle_commit';
    try {
      // Simulated Oracle commit — a child span models the DB call.
      await tracer.startActiveSpan('oracle.commit', async (dbSpan) => {
        dbSpan.setAttribute('db.system', 'oracle');
        dbSpan.setAttribute('db.operation', 'INSERT');
        const c0 = Date.now();
        if (store.get('db_error_batch_release')) {
          const e = new Error('ORA-00060: deadlock detected while acquiring batch-release lock');
          dbSpan.recordException(e);
          dbSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
          dbSpan.end();
          throw e;
        }
        await sleep(30 + Math.random() * 40);
        dbCommitLatency.record(Date.now() - c0, { table: 'batch_release' });
        dbSpan.end();
      });

      // Downstream GxP systems.
      stage = 'sap_integration';
      const sap = await callSystem('SAP', 120, span);
      stage = 'lims_integration';
      const lims = await callSystem('LIMS', 210, span);

      const dur = Date.now() - t0;
      await emitBizEvent('batch.gxp.released', { ...bctx, sap, lims });
      glog.event('batch.gxp.released', {
        'event.outcome': 'released',
        'nova.gxp.sap_status': sap && sap.status,
        'nova.gxp.lims_status': lims && lims.status,
        'nova.gxp.duration_ms': dur,
      });
      span.end();
      res.json({ ok: true, sap, lims });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err.message || err) });
      glog.event('batch.gxp.failed', {
        'event.outcome': 'failed',
        'nova.failure.stage': stage,
        'nova.failure.reason': String(err.message || err),
        'nova.gxp.duration_ms': Date.now() - t0,
      });
      span.end();
      res.status(502).json({ ok: false, error: String(err.message || err) });
    }
  });
});

async function callSystem(name, baseMs, parent) {
  return tracer.startActiveSpan(`gxp.${name.toLowerCase()}.call`, async (span) => {
    span.setAttribute('peer.service', name);
    try {
      if (name === 'SAP' && store.get('gxp_integration_failure')) {
        const e = new Error(`${name} integration returned 503 Service Unavailable`);
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
        throw e;
      }
      await sleep(baseMs + Math.random() * 40);
      span.end();
      return { system: name, status: 200 };
    } catch (e) {
      span.end();
      throw e;
    }
  });
}

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'nova-batch-service' }));
app.listen(PORT, () => log.info(`nova-batch-service listening on :${PORT}`));
