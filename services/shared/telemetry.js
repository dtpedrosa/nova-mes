'use strict';
/*
 * Shared OpenTelemetry bootstrap for all Nova MES services.
 *
 * Emits to an OTLP endpoint (Dynatrace ActiveGate / OTel collector):
 *   - Traces  (spans)         -> /v1/traces
 *   - Metrics (OTLP metrics)  -> /v1/metrics   (DELTA temporality: Dynatrace-native)
 *   - Logs    (OTLP logs)     -> /v1/logs      (trace-correlated)
 *
 * Environment variables (all optional; sensible defaults for local run):
 *   OTEL_EXPORTER_OTLP_ENDPOINT   e.g. https://<env>.live.dynatrace.com/api/v2/otlp
 *   OTEL_EXPORTER_OTLP_HEADERS    e.g. Authorization=Api-Token dt0c01.XXXX
 *   OTEL_SERVICE_NAME             overridden per-service below
 *   DT_TENANT_URL                 base tenant URL, used for the bizevents ingest helper
 *   DT_API_TOKEN                  token with bizevents.ingest + metrics.ingest scopes
 *
 * NOTE on metric temporality:
 *   Dynatrace ingests DELTA temporality natively. We set
 *   OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta so we do NOT need a
 *   cumulativetodelta processor in the collector for THIS app's OTLP metrics.
 *   (The collector-side cumulativetodelta processor in otel/ remains available
 *    for third-party cumulative sources such as the Astronomy Shop demo.)
 */

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { PeriodicExportingMetricReader, AggregationTemporality } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { Resource } = require('@opentelemetry/resources');
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} = require('@opentelemetry/semantic-conventions');
const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');

function startTelemetry(serviceName) {
  if (process.env.OTEL_DIAG === '1') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

  // Parse OTEL_EXPORTER_OTLP_HEADERS ("k1=v1,k2=v2") into an object.
  const headers = {};
  (process.env.OTEL_EXPORTER_OTLP_HEADERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx > 0) headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    });

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.APP_VERSION || '1.0.0',
    'deployment.environment': process.env.DEPLOY_ENV || 'demo',
    'nova.site': process.env.NOVA_SITE || 'Northgate',
    'nova.line': process.env.NOVA_LINE || 'line-2',
  });

  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers,
  });

  // DELTA temporality — Dynatrace-native, avoids cumulative rejection.
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${endpoint}/v1/metrics`,
      headers,
      temporalityPreference: AggregationTemporality.DELTA,
    }),
    exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 15000),
  });

  const logRecordProcessor = new BatchLogRecordProcessor(
    new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers })
  );

  const sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    logRecordProcessors: [logRecordProcessor],
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
  process.on('SIGINT', () => sdk.shutdown().finally(() => process.exit(0)));

  return sdk;
}

module.exports = { startTelemetry };
