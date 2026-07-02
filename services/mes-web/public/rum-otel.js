/*
 * Browser Real User Monitoring via OpenTelemetry Web SDK (no OneAgent).
 *
 * Loaded as an ES module from the CDN (esm.sh). It instruments the browser as a
 * first-class OTel tier:
 *   - a WebTracerProvider with a Resource identifying the frontend service
 *   - documentLoad + fetch + XHR auto-instrumentation (page load, resources, calls)
 *   - W3C trace context propagation so browser spans link to backend spans in ONE
 *     distributed trace (the checkout-funnel pattern Dynatrace recommends)
 *   - custom spans for named user actions ("Release batch", "Dispense material")
 *   - a global window.novaRum API used by app.js for user actions, attributes,
 *     error reporting, and RUM business events
 *   - OTLP/HTTP export to /otlp-proxy on the web server, which forwards to the
 *     collector (keeps the browser off the tenant token and handles CORS)
 *
 * Everything degrades gracefully: if the SDK fails to load, window.novaRum falls
 * back to no-ops and the app still works.
 */

import { WebTracerProvider } from 'https://esm.sh/@opentelemetry/sdk-trace-web@1.30.1';
import { BatchSpanProcessor } from 'https://esm.sh/@opentelemetry/sdk-trace-base@1.30.1';
import { OTLPTraceExporter } from 'https://esm.sh/@opentelemetry/exporter-trace-otlp-http@0.57.1';
import { resourceFromAttributes } from 'https://esm.sh/@opentelemetry/resources@1.30.1';
import { ZoneContextManager } from 'https://esm.sh/@opentelemetry/context-zone@1.30.1';
import { registerInstrumentations } from 'https://esm.sh/@opentelemetry/instrumentation@0.57.1';
import { DocumentLoadInstrumentation } from 'https://esm.sh/@opentelemetry/instrumentation-document-load@0.44.1';
import { FetchInstrumentation } from 'https://esm.sh/@opentelemetry/instrumentation-fetch@0.57.1';
import { XMLHttpRequestInstrumentation } from 'https://esm.sh/@opentelemetry/instrumentation-xml-http-request@0.57.1';
import { trace, context, SpanStatusCode } from 'https://esm.sh/@opentelemetry/api@1.9.0';
import { W3CTraceContextPropagator } from 'https://esm.sh/@opentelemetry/core@1.30.1';

const SERVICE_NAME = 'nova-mes-frontend';

const resource = resourceFromAttributes({
  'service.name': SERVICE_NAME,
  'service.version': '1.0.0',
  'deployment.environment': 'demo',
  'telemetry.sdk.language': 'webjs',
});

const exporter = new OTLPTraceExporter({
  // Same-origin proxy on the web server forwards to the collector. Keeps the
  // Dynatrace token server-side and avoids browser CORS to the tenant.
  url: '/otlp-proxy/v1/traces',
});

const provider = new WebTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(exporter)],
});

provider.register({
  contextManager: new ZoneContextManager(),
  propagator: new W3CTraceContextPropagator(),
});

registerInstrumentations({
  instrumentations: [
    new DocumentLoadInstrumentation(),
    new FetchInstrumentation({
      // Propagate trace context to our own backend so browser + server share a trace.
      propagateTraceHeaderCorsUrls: [/.*/],
      clearTimingResources: true,
    }),
    new XMLHttpRequestInstrumentation({
      propagateTraceHeaderCorsUrls: [/.*/],
    }),
  ],
});

const tracer = trace.getTracer(SERVICE_NAME);

// Capture uncaught errors and unhandled rejections as span events on a short span.
function recordError(source, err) {
  const span = tracer.startSpan(`rum.error.${source}`);
  span.recordException(err instanceof Error ? err : new Error(String(err)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: String(err && err.message || err) });
  span.setAttribute('rum.error.source', source);
  span.end();
}
window.addEventListener('error', (e) => recordError('window', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => recordError('promise', e.reason));

/*
 * window.novaRum — the app-facing API (mirrors what we previously did with dtrum,
 * but implemented on standard OTel). Each user action becomes its own span that
 * parents the fetch spans fired inside it, so the whole click is one sub-trace
 * that stitches into the backend trace via context propagation.
 */
window.novaRum = {
  ready: true,
  // Run an async user action inside a named span. Returns fn()'s result.
  async action(name, attributes, fn) {
    const span = tracer.startSpan(`user_action:${name}`, {
      attributes: { 'rum.action.name': name, ...(attributes || {}) },
    });
    try {
      return await context.with(trace.setSpan(context.active(), span), fn);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err && err.message || err) });
      throw err;
    } finally {
      span.end();
    }
  },
  // Fire-and-forget business event as a span with a bizevent marker event.
  bizEvent(type, data) {
    const span = tracer.startSpan(`bizevent:${type}`, {
      attributes: { 'event.type': type, 'event.provider': 'nova-mes-frontend' },
    });
    span.addEvent(type, flatten(data || {}));
    span.end();
  },
  reportError(err) { recordError('custom', err); },
};

function flatten(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return out;
}

console.log('[novaRum] OpenTelemetry browser instrumentation active for', SERVICE_NAME);
