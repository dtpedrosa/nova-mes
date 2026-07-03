'use strict';
/*
 * Deterministic pharma-domain enrichment.
 *
 * There is no real ERP/MES master-data behind this demo, so we derive stable,
 * realistic business dimensions from the batch/order id (same id -> same
 * product, value, material every time). This gives business dashboards clean,
 * non-jittering dimensions to group and sum by:
 *   - product (code / name / form) and batch value in USD + quantity
 *   - material, target weight and tolerance for dispensing quality
 *
 * All keys use the stable `nova.*` business namespace so they are easy to find
 * and aggregate in Dynatrace (DQL / dashboards) across logs, spans and events.
 */

const SITE = process.env.NOVA_SITE || 'Northgate';

const PRODUCTS = [
  { code: 'NVX-100', name: 'Novaxil 100mg Tablet',        form: 'tablet',     unitValueUsd: 4.20 },
  { code: 'NVX-250', name: 'Novaxil 250mg Capsule',       form: 'capsule',    unitValueUsd: 6.85 },
  { code: 'CRD-050', name: 'Cardizen 50mg Tablet',        form: 'tablet',     unitValueUsd: 3.10 },
  { code: 'IMU-010', name: 'Immunova 10mg/mL Injectable', form: 'injectable', unitValueUsd: 18.40 },
];

const MATERIALS = [
  { code: 'API-4471', name: 'Active API Lot 4471', targetKg: 12.5, toleranceKg: 0.15 },
  { code: 'EXC-2210', name: 'Excipient MCC 2210',  targetKg: 8.0,  toleranceKg: 0.20 },
  { code: 'API-3308', name: 'Active API Lot 3308', targetKg: 15.0, toleranceKg: 0.25 },
];

// FNV-1a: cheap, stable string hash so enrichment is deterministic per id.
function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function productForBatch(batchId) { return PRODUCTS[hash(batchId) % PRODUCTS.length]; }
function batchQuantityUnits(batchId) { return 20000 + (hash(batchId) % 81) * 1000; } // 20k–100k units
function materialForOrder(orderId) { return MATERIALS[hash(`${orderId}#mat`) % MATERIALS.length]; }

// Stable business context for a batch-release journey.
function batchContext(batchId) {
  const p = productForBatch(batchId);
  const units = batchQuantityUnits(batchId);
  return {
    'nova.site': SITE,
    'nova.line': 'line-2',
    'nova.batch.id': batchId,
    'nova.product.code': p.code,
    'nova.product.name': p.name,
    'nova.product.form': p.form,
    'nova.batch.quantity_units': units,
    'nova.batch.value_usd': Number((units * p.unitValueUsd).toFixed(2)),
  };
}

// Stable business context for a dispensing journey.
function orderContext(orderId) {
  const m = materialForOrder(orderId);
  return {
    'nova.site': SITE,
    'nova.line': 'line-3',
    'nova.order.id': orderId,
    'nova.material.code': m.code,
    'nova.material.name': m.name,
    'nova.dispense.target_kg': m.targetKg,
    'nova.dispense.tolerance_kg': m.toleranceKg,
  };
}

module.exports = {
  SITE, PRODUCTS, MATERIALS,
  productForBatch, batchQuantityUnits, materialForOrder,
  batchContext, orderContext,
};
