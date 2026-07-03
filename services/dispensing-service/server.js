'use strict';
const { startTelemetry } = require('../shared/telemetry');
startTelemetry(process.env.OTEL_SERVICE_NAME || 'nova-dispensing-service');

const express = require('express');
const { metrics, trace, SpanStatusCode } = require('@opentelemetry/api');
const { makeLogger } = require('../shared/logger');
const { emitBizEvent } = require('../shared/bizevents');
const { FlagStore, flagRouter } = require('../shared/flags');
const { orderContext } = require('../shared/domain');

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

const DEVICE_ID = 'SCALE-L3-02';

app.post('/weigh', async (req, res) => {
  await tracer.startActiveSpan('dispense.weigh', async (span) => {
    const orderId = req.body.orderId;
    const octx = orderContext(orderId);
    const wlog = log.child(octx);
    const target = octx['nova.dispense.target_kg'];
    const tolerance = octx['nova.dispense.tolerance_kg'];
    span.setAttributes({ ...octx, 'device.id': DEVICE_ID });
    const t0 = Date.now();
    try {
      // Child span modelling the PLC / scale read on the shop floor.
      await tracer.startActiveSpan('plc.scale_read', async (plcSpan) => {
        plcSpan.setAttribute('device.type', 'scale');
        plcSpan.setAttribute('device.id', DEVICE_ID);

        if (store.get('slow_dispensing')) {
          wlog.warn('scale read degraded (slow_dispensing flag)', { 'nova.device.id': DEVICE_ID, 'nova.dispense.degraded': true });
          await sleep(3500 + Math.random() * 1000); // 3.5–4.5s
        } else {
          await sleep(300 + Math.random() * 120);
        }

        if (store.get('dispensing_exception')) {
          // Unhandled-style exception in the scale read path.
          const e = new Error(`SCALE_TIMEOUT: no stable reading from ${DEVICE_ID} within 5000ms`);
          plcSpan.recordException(e);
          plcSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
          plcSpan.end();
          throw e;
        }
        plcSpan.end();
      });

      // Weigh around the material target; some reads land outside tolerance.
      const weight = Number((target + (Math.random() - 0.5) * tolerance * 2.4).toFixed(3));
      const deviationKg = Number((weight - target).toFixed(3));
      const withinTolerance = Math.abs(deviationKg) <= tolerance;
      const dur = Date.now() - t0;

      weighLatency.record(dur, { line: 'line-3' });
      netWeight.record(weight, { line: 'line-3', material: octx['nova.material.code'] });

      await emitBizEvent('dispense.weighed', {
        ...octx, netWeightKg: weight, deviationKg, withinTolerance, latencyMs: dur,
      });
      wlog.event('dispense.weighed', {
        'event.outcome': withinTolerance ? 'weighed' : 'out_of_tolerance',
        'nova.device.id': DEVICE_ID,
        'nova.dispense.net_weight_kg': weight,
        'nova.dispense.deviation_kg': deviationKg,
        'nova.dispense.within_tolerance': withinTolerance,
        'nova.dispense.duration_ms': dur,
      });
      span.setAttributes({
        'nova.dispense.latency_ms': dur,
        'nova.dispense.net_weight_kg': weight,
        'nova.dispense.within_tolerance': withinTolerance,
      });
      span.end();
      res.json({ ok: true, orderId, netWeightKg: weight, deviationKg, withinTolerance, latencyMs: dur });
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err.message || err) });
      await emitBizEvent('dispense.deviation', { ...octx, reason: String(err.message || err) });
      wlog.event('dispense.deviation', {
        'event.outcome': 'deviation',
        'nova.device.id': DEVICE_ID,
        'nova.failure.reason': String(err.message || err),
        'nova.dispense.duration_ms': Date.now() - t0,
      });
      span.end();
      res.status(502).json({ ok: false, error: String(err.message || err) });
    }
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'nova-dispensing-service' }));
app.listen(PORT, () => log.info(`nova-dispensing-service listening on :${PORT}`));
