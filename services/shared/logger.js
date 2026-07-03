'use strict';
/*
 * Structured JSON logger with trace correlation.
 *
 * Each call does two things:
 *   1. Writes a JSON line to stdout/stderr (human + `kubectl logs` visibility,
 *      carrying dt.trace_id / dt.span_id for correlation if logs are also
 *      scraped by a filelog receiver or OneAgent).
 *   2. Emits an OTel LogRecord through the global LoggerProvider, which the
 *      shared telemetry bootstrap wires to the OTLP log exporter -> Dynatrace.
 *      The active span's trace context is captured automatically, so these logs
 *      link to their traces natively in Dynatrace.
 *
 * Levels: debug, info, warn, error
 */

const { trace, context } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL || 'info'] || 20;

const SEVERITY = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

function make(service) {
  // Resolved against the global provider registered by startTelemetry().
  const otelLogger = logs.getLogger(service);
  const log = {};
  for (const [name, sev] of Object.entries(LEVELS)) {
    log[name] = (msg, fields = {}) => {
      if (sev < MIN) return;

      const span = trace.getSpan(context.active());
      const sctx = span ? span.spanContext() : null;

      // 1. stdout/stderr line
      const line = {
        timestamp: new Date().toISOString(),
        level: name.toUpperCase(),
        'service.name': service,
        ...(sctx ? { 'dt.trace_id': sctx.traceId, 'dt.span_id': sctx.spanId } : {}),
        msg,
        ...fields,
      };
      const out = name === 'error' || name === 'warn' ? process.stderr : process.stdout;
      out.write(JSON.stringify(line) + '\n');

      // 2. OTLP log record -> Dynatrace (trace context captured from active context)
      otelLogger.emit({
        severityNumber: SEVERITY[name],
        severityText: name.toUpperCase(),
        body: msg,
        attributes: { 'service.name': service, ...fields },
      });
    };
  }
  return log;
}

module.exports = { makeLogger: make };
