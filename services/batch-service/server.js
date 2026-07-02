'use strict';
const { startTelemetry } = require('../shared/telemetry');
startTelemetry(process.env.OTEL_SERVICE_NAME || 'nova-batch-service');

const express = require('express');
const { metrics, trace, SpanStatusCode } = require('@opentelemetry/api');
const { makeLogger } = require('../shared/logger');
const { emitBizEvent } = require('../shared/bizevents');
const { FlagStore, flagRouter } = require('../shared/flags');

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
    span.setAttribute('nova.batch.id', batchId);
    try {
      if (store.get('slow_review')) {
        log.warn('slow_review flag active', { batchId });
        await sleep(2500 + Math.random() * 500);
      }
      // Simulate scanning 400 process parameters against the golden batch.
      const exceptions = 3;
      reviewExceptions.record(exceptions, { batch: batchId });
      await emitBizEvent('batch.review.completed', { batchId, parametersScanned: 400, exceptions });
      log.info('review completed', { batchId, exceptions });
      span.setAttribute('nova.review.exceptions', exceptions);
      span.end();
      res.json({ ok: true, exceptions, parametersScanned: 400 });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });
});

// Step 3 of Journey 1: commit to Oracle + push to SAP ERP and LIMS.
app.post('/gxp-release', async (req, res) => {
  await tracer.startActiveSpan('batch.gxp_release', async (span) => {
    const batchId = req.body.batchId;
    span.setAttribute('nova.batch.id', batchId);
    try {
      // Simulated Oracle commit — a child span models the DB call.
      await tracer.startActiveSpan('oracle.commit', async (dbSpan) => {
        dbSpan.setAttribute('db.system', 'oracle');
        dbSpan.setAttribute('db.operation', 'INSERT');
        const t0 = Date.now();
        if (store.get('db_error_batch_release')) {
          const e = new Error('ORA-00060: deadlock detected while acquiring batch-release lock');
          dbSpan.recordException(e);
          dbSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
          dbSpan.end();
          throw e;
        }
        await sleep(30 + Math.random() * 40);
        dbCommitLatency.record(Date.now() - t0, { table: 'batch_release' });
        dbSpan.end();
      });

      // Downstream GxP systems.
      const sap = await callSystem('SAP', 120, span);
      const lims = await callSystem('LIMS', 210, span);

      await emitBizEvent('batch.gxp.released', { batchId, sap, lims });
      log.info('gxp release ok', { batchId, sap, lims });
      span.end();
      res.json({ ok: true, sap, lims });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err.message || err) });
      log.error('gxp release failed', { batchId, error: String(err.message || err) });
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
