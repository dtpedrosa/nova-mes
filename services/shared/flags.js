'use strict';
/*
 * Feature-flag / fault-injection system.
 *
 * A tiny in-memory flag store shared conceptually across services (each service
 * process holds its own copy; the mes-web control panel fans out toggles to the
 * backend services over HTTP so one click flips the whole system).
 *
 * Flags are the demo's "big red buttons". Each maps to a concrete failure mode
 * that lands on a specific journey step, so you can turn a green demo red on
 * command and show Dynatrace catching it.
 *
 *   FLAG                         EFFECT (where it bites)
 *   ------------------------------------------------------------------
 *   slow_dispensing              Journey 2 · weigh-and-dispense adds 3.5-4.5s latency
 *   db_error_batch_release       Journey 1 · Oracle commit throws on batch release
 *   gxp_integration_failure      Journey 1 · SAP/LIMS downstream call returns 503
 *   dispensing_exception         Journey 2 · unhandled exception in scale-read code path
 *   slow_review                  Journey 1 · review-by-exception step adds 2-3s latency
 *   rum_js_error                 RUM       · frontend throws a JS error on a user action
 *
 * Control API (mounted by each service under /_flags):
 *   GET  /_flags            -> current flag state
 *   POST /_flags            { flag: "slow_dispensing", value: true }
 *   POST /_flags/reset      -> all flags off (clean demo)
 *   POST /_flags/scenario   { scenario: "healthy" | "deviation" | "release_failure" }
 */

const DEFAULTS = {
  slow_dispensing: false,
  db_error_batch_release: false,
  gxp_integration_failure: false,
  dispensing_exception: false,
  slow_review: false,
  rum_js_error: false,
};

const SCENARIOS = {
  healthy: {},
  // Journey 2 story: dispensing line degrades then throws.
  deviation: { slow_dispensing: true, dispensing_exception: true },
  // Journey 1 story: batch release blocked by downstream failures.
  release_failure: { db_error_batch_release: true, gxp_integration_failure: true },
};

class FlagStore {
  constructor() {
    this.flags = { ...DEFAULTS };
  }
  get(name) {
    return !!this.flags[name];
  }
  all() {
    return { ...this.flags };
  }
  set(name, value) {
    if (!(name in DEFAULTS)) return false;
    this.flags[name] = !!value;
    return true;
  }
  reset() {
    this.flags = { ...DEFAULTS };
  }
  scenario(name) {
    if (!(name in SCENARIOS)) return false;
    this.reset();
    for (const [k, v] of Object.entries(SCENARIOS[name])) this.flags[k] = v;
    return true;
  }
}

// Express-style router factory for the control API.
function flagRouter(express, store, onChange) {
  const r = express.Router();
  r.get('/', (_req, res) => res.json(store.all()));
  r.post('/', (req, res) => {
    const { flag, value } = req.body || {};
    const ok = store.set(flag, value);
    if (ok && onChange) onChange(flag, store.get(flag));
    res.status(ok ? 200 : 400).json({ ok, flags: store.all() });
  });
  r.post('/reset', (_req, res) => {
    store.reset();
    if (onChange) onChange('*', false);
    res.json({ ok: true, flags: store.all() });
  });
  r.post('/scenario', (req, res) => {
    const ok = store.scenario((req.body || {}).scenario);
    if (ok && onChange) onChange('scenario', (req.body || {}).scenario);
    res.status(ok ? 200 : 400).json({ ok, flags: store.all() });
  });
  return r;
}

module.exports = { FlagStore, flagRouter, DEFAULTS, SCENARIOS };
