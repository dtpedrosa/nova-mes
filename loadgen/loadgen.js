'use strict';
/*
 * Nova MES load generator.
 *
 * Drives continuous, realistic traffic through the two journeys against the
 * mes-web frontend so Dynatrace has a live stream of traces, metrics, logs,
 * and business events to show. Server-side spans are produced by the services;
 * this generator is the "operators on shift".
 *
 * Config via env:
 *   TARGET        base URL of mes-web         (default http://localhost:4000)
 *   RPS           approx requests per second  (default 2)
 *   RELEASE_MIX   fraction that are batch releases vs dispenses (default 0.4)
 *   DURATION_S    stop after N seconds        (default 0 = run forever)
 *
 * For RUM traffic (real browser sessions), point a headless browser or a
 * synthetic monitor at TARGET instead — this generator exercises the backend.
 */

const TARGET = process.env.TARGET || 'http://localhost:4000';
const RPS = Number(process.env.RPS || 2);
const RELEASE_MIX = Number(process.env.RELEASE_MIX || 0.4);
const DURATION_S = Number(process.env.DURATION_S || 0);

let sent = 0;
let ok = 0;
let failed = 0;
const started = Date.now();

async function fire() {
  const isRelease = Math.random() < RELEASE_MIX;
  const url = isRelease ? `${TARGET}/api/journey/batch-release` : `${TARGET}/api/journey/dispense`;
  const body = isRelease
    ? { batchId: `NX-${88000 + Math.floor(Math.random() * 999)}` }
    : { orderId: `WO-${5000 + Math.floor(Math.random() * 999)}` };

  sent++;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) ok++; else failed++;
  } catch (_e) {
    failed++;
  }
}

function tick() {
  // Poisson-ish: fire RPS requests spread across the second with jitter.
  for (let i = 0; i < RPS; i++) {
    setTimeout(fire, Math.random() * 1000);
  }
}

console.log(`[loadgen] target=${TARGET} rps=${RPS} releaseMix=${RELEASE_MIX} duration=${DURATION_S || 'infinite'}s`);
const iv = setInterval(tick, 1000);
const stats = setInterval(() => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`[loadgen] t=${elapsed}s sent=${sent} ok=${ok} failed=${failed}`);
}, 5000);

if (DURATION_S > 0) {
  setTimeout(() => {
    clearInterval(iv); clearInterval(stats);
    console.log(`[loadgen] done. sent=${sent} ok=${ok} failed=${failed}`);
    process.exit(0);
  }, DURATION_S * 1000);
}

process.on('SIGINT', () => { clearInterval(iv); clearInterval(stats); process.exit(0); });
