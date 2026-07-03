'use strict';
/*
 * Shared OpenTelemetry bootstrap for all Nova MES services.
 *
 * Sends traces, metrics, and logs via OTLP/HTTP+Protobuf directly to Dynatrace.
 * Dynatrace requires protobuf encoding; the *-otlp-proto packages handle this.
 *
 * Required env vars (injected by Helm):
 *   OTEL_EXPORTER_OTLP_ENDPOINT  e.g. https://<env>.sprint.dynatracelabs.com/api/v2/otlp
 *   DT_API_TOKEN                  Dynatrace API token (logs.ingest, metrics.ingest, openTelemetryTrace.ingest)
 *   OTEL_SERVICE_NAME             set per-deployment in Helm template
 *
 * Optional:
 *   OTEL_EXPORTER_OTLP_HEADERS   extra headers as k=v,k2=v2 (applied after DT_API_TOKEN)
 *   OTEL_METRIC_EXPORT_INTERVAL   milliseconds, default 15000
 *   OTEL_DIAG=1                   enable verbose OTel SDK diagnostics
 */

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-proto');
const { PeriodicExportingMetricReader, AggregationTemporality } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');
const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');

function startTelemetry(serviceName) {
  if (process.env.OTEL_DIAG === '1') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

  // DT_API_TOKEN is the primary auth source; OTEL_EXPORTER_OTLP_HEADERS can add/override.
  const headers = {};
  if (process.env.DT_API_TOKEN) {
    headers['Authorization'] = `Api-Token ${process.env.DT_API_TOKEN}`;
  }
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
    // Kubernetes metadata via Downward API
    'k8s.pod.name': process.env.POD_NAME || '',
    'k8s.namespace.name': process.env.POD_NAMESPACE || '',
    'k8s.node.name': process.env.NODE_NAME || '',
  });

  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers });

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
