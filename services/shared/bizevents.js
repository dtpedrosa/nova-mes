'use strict';
/*
 * Business events (bizevents) helper.
 *
 * Sends business-flow events to the Dynatrace bizevents ingest endpoint:
 *   POST {DT_TENANT_URL}/api/v2/bizevents/ingest
 *   Content-Type: application/json; charset=utf-8   (CloudEvents batch)
 *   Authorization: Api-Token {DT_API_TOKEN}   (scope: bizevents.ingest)
 *
 * Each event carries the current trace context so business events line up
 * with the distributed trace of the journey step that produced them.
 *
 * If DT_TENANT_URL / DT_API_TOKEN are absent (local run), events are logged
 * to stdout as structured JSON so you can still see the business flow.
 */

const { trace, context } = require('@opentelemetry/api');

const TENANT = process.env.DT_TENANT_URL;      // e.g. https://<env>.live.dynatrace.com
const TOKEN = process.env.DT_API_TOKEN;

async function emitBizEvent(eventType, payload) {
  const span = trace.getSpan(context.active());
  const sctx = span ? span.spanContext() : null;

  const body = {
    'event.type': eventType,
    'event.provider': 'nova-mes',
    ...(sctx ? { 'dt.trace_id': sctx.traceId, 'dt.span_id': sctx.spanId } : {}),
    timestamp: new Date().toISOString(),
    ...payload,
  };

  // Attach a span event too, so the trace waterfall shows the business moment.
  if (span) span.addEvent(`bizevent:${eventType}`, flatten(payload));

  if (!TENANT || !TOKEN) {
    console.log(JSON.stringify({ level: 'INFO', bizevent: body }));
    return { ok: true, local: true };
  }

  try {
    const res = await fetch(`${TENANT}/api/v2/bizevents/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Api-Token ${TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.error(JSON.stringify({ level: 'ERROR', msg: 'bizevent ingest failed', error: String(err) }));
    return { ok: false, error: String(err) };
  }
}

function flatten(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

module.exports = { emitBizEvent };
