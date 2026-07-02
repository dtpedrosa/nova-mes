'use strict';
const { startTelemetry } = require('../shared/telemetry');
startTelemetry(process.env.OTEL_SERVICE_NAME || 'nova-dispensing-service');

const express = require('express');
const { metrics, trace, SpanStatusCode } = require('@opentelemetry/api');
const { makeLogger } = require('../shared/logger');
const { emitBizEvent } = require('../shared/bizevents');
const { FlagStore, flagRouter } = require('../shared/flags');

const log = makeLogger('nova-dispensing-service');
const store = new FlagStore();
const tracer = trace.getTracer('nova-dispensing-service');
const meter = metrics.getMeter('nova-dispensing-service');
const PORT = Number(process.env.PORT || 4002);

const weighLatency = meter.createHistogram('nova.dispense.latency', {
  description: 'Weigh-and-dispense step latency', unit: 'ms',
});
const netWeight = meter.createHistogram('nova.dispense.net_weight', {
  description: 'Dispensed net weight', unit: 'kg',
});

const app = express();
app.use(express.json());
app.use('/_flags', flagRouter(express, store));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post('/weigh', async (req, res) => {
  await tracer.startActiveSpan('dispense.weigh', async (span) => {
    const orderId = req.body.orderId;
    span.setAttribute('nova.order.id', orderId);
    span.setAttribute('nova.line', 'line-3');
    const t0 = Date.now();
    try {
      // Child span modelling the PLC / scale read on the shop floor.
      await tracer.startActiveSpan('plc.scale_read', async (plcSpan) => {
        plcSpan.setAttribute('device.type', 'scale');
        plcSpan.setAttribute('device.id', 'SCALE-L3-02');

        if (store.get('slow_dispensing')) {
          log.warn('slow_dispensing flag active — scale read degraded', { orderId });
          await sleep(3500 + Math.random() * 1000); // 3.5–4.5s
        } else {
          await sleep(300 + Math.random() * 120);
        }

        if (store.get('dispensing_exception')) {
          // Unhandled-style exception in the scale read path.
          const e = new Error('SCALE_TIMEOUT: no stable reading from SCALE-L3-02 within 5000ms');
          plcSpan.recordException(e);
          plcSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
          plcSpan.end();
          throw e;
        }
        plcSpan.end();
      });

      const weight = 12.5 + (Math.random() - 0.5) * 0.2;
      const dur = Date.now() - t0;
      weighLatency.record(dur, { line: 'line-3' });
      netWeight.record(weight, { line: 'line-3', material: 'API-lot-4471' });
      await emitBizEvent('dispense.weighed', { orderId, netWeightKg: Number(weight.toFixed(3)), latencyMs: dur });
      log.info('weigh ok', { orderId, netWeightKg: Number(weight.toFixed(3)), durMs: dur });
      span.setAttribute('nova.dispense.latency_ms', dur);
      span.end();
      res.json({ ok: true, orderId, netWeightKg: Number(weight.toFixed(3)), latencyMs: dur });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err.message || err) });
      await emitBizEvent('dispense.deviation', { orderId, line: 'line-3', reason: String(err.message || err) });
      log.error('weigh deviation', { orderId, error: String(err.message || err) });
      span.end();
      res.status(502).json({ ok: false, error: String(err.message || err) });
    }
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'nova-dispensing-service' }));
app.listen(PORT, () => log.info(`nova-dispensing-service listening on :${PORT}`));
