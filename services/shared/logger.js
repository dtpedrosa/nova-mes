'use strict';
/*
 * Structured JSON logger with trace correlation.
 *
 * Every log line is JSON on stdout — Dynatrace (via OneAgent log module or the
 * OTel collector filelog receiver) ingests these and auto-links them to traces
 * through the injected dt.trace_id / dt.span_id fields.
 *
 * Levels: debug, info, warn, error
 */

const { trace, context } = require('@opentelemetry/api');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[process.env.LOG_LEVEL || 'info'] || 20;

function base(level, service) {
  const span = trace.getSpan(context.active());
  const sctx = span ? span.spanContext() : null;
  return {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    'service.name': service,
    ...(sctx ? { 'dt.trace_id': sctx.traceId, 'dt.span_id': sctx.spanId } : {}),
  };
}

function make(service) {
  const log = {};
  for (const [name, sev] of Object.entries(LEVELS)) {
    log[name] = (msg, fields = {}) => {
      if (sev < MIN) return;
      const line = { ...base(name, service), msg, ...fields };
      const out = name === 'error' || name === 'warn' ? process.stderr : process.stdout;
      out.write(JSON.stringify(line) + '\n');
    };
  }
  return log;
}

module.exports = { makeLogger: make };
