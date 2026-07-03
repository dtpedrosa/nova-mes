'use strict';
/*
 * Structured, business-aware logger with trace correlation.
 *
 * Each call:
 *   1. Writes one JSON line to stdout/stderr (kubectl + filelog visibility,
 *      carrying dt.trace_id / dt.span_id).
 *   2. Emits an OTel LogRecord through the global LoggerProvider -> OTLP
 *      exporter -> Dynatrace, with the active span's trace context captured
 *      automatically so logs link to their traces.
 *
 * Logging best practices applied here:
 *   - Stable attribute schema in the `nova.*` business namespace + OTel
 *     `event.name` / `event.outcome` so logs are queryable and dashboard-able.
 *   - Bound context via log.child({...}) so every line in a journey carries the
 *     same business dimensions (site, line, product, ids) without repetition.
 *   - log.event(name, fields) for authoritative business events; severity is
 *     derived from event.outcome (bad outcomes -> error).
 *   - Attribute values kept to OTLP-safe primitives (objects flattened to JSON).
 *   - Levels gated by LOG_LEVEL; no secrets or tokens are ever logged.
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

// Business outcomes that should raise the log to error severity.
const BAD_OUTCOMES = new Set(['failed', 'deviation', 'blocked', 'rejected', 'error', 'timeout']);

// Dimensions attached to every log for filtering and dashboards.
const GLOBAL = {
  'nova.site': process.env.NOVA_SITE || 'Northgate',
  'deployment.environment': process.env.DEPLOY_ENV || 'demo',
};

// OTel log attributes must be primitives (string/number/boolean); flatten the rest.
function sanitize(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  }
  return out;
}

function make(service, bindings = {}) {
  const otelLogger = logs.getLogger(service);
  const bound = { 'service.name': service, ...GLOBAL, ...bindings };

  function emit(level, msg, fields) {
    if (LEVELS[level] < MIN) return;
    const span = trace.getSpan(context.active());
    const sctx = span ? span.spanContext() : null;
    const attrs = { ...bound, ...sanitize(fields) };

    // 1. stdout/stderr
    const line = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      msg,
      ...attrs,
      ...(sctx ? { 'dt.trace_id': sctx.traceId, 'dt.span_id': sctx.spanId } : {}),
    };
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(JSON.stringify(line) + '\n');

    // 2. OTLP log record -> Dynatrace
    otelLogger.emit({
      severityNumber: SEVERITY[level],
      severityText: level.toUpperCase(),
      body: msg,
      attributes: attrs,
    });
  }

  const log = {};
  for (const level of Object.keys(LEVELS)) {
    log[level] = (msg, fields = {}) => emit(level, msg, fields);
  }

  // Bind additional business context for the life of a request/journey.
  log.child = (extra) => make(service, { ...bindings, ...extra });

  // Authoritative business event; severity derived from event.outcome.
  log.event = (eventName, fields = {}) => {
    const outcome = fields['event.outcome'];
    const level = BAD_OUTCOMES.has(outcome) ? 'error' : 'info';
    emit(level, eventName, { 'event.name': eventName, ...fields });
  };

  return log;
}

module.exports = { makeLogger: make };
