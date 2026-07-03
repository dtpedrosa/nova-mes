'use strict';

async function initDatabase(pool) {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS batch_records (
        id               SERIAL PRIMARY KEY,
        batch_id         TEXT UNIQUE NOT NULL,
        product_code     TEXT,
        product_name     TEXT,
        status           TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','in_review','released','failed')),
        quantity_units   INTEGER,
        value_usd        NUMERIC(12,2),
        site             TEXT,
        line             TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        released_at      TIMESTAMPTZ,
        review_exceptions INTEGER DEFAULT 0,
        notes            TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_orders (
        id             SERIAL PRIMARY KEY,
        order_id       TEXT UNIQUE NOT NULL,
        material_code  TEXT,
        material_name  TEXT,
        target_kg      NUMERIC(8,3),
        actual_kg      NUMERIC(8,3),
        status         TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','in_progress','completed','deviation')),
        priority       TEXT DEFAULT 'normal',
        site           TEXT,
        line           TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at   TIMESTAMPTZ
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS deviations (
        id             SERIAL PRIMARY KEY,
        reference_id   TEXT NOT NULL,
        reference_type TEXT NOT NULL CHECK (reference_type IN ('batch','work_order')),
        severity       TEXT NOT NULL CHECK (severity IN ('minor','major','critical')),
        description    TEXT,
        status         TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','investigating','closed')),
        site           TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at      TIMESTAMPTZ
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS equipment (
        id                SERIAL PRIMARY KEY,
        equipment_id      TEXT UNIQUE NOT NULL,
        name              TEXT,
        type              TEXT,
        line              TEXT,
        site              TEXT,
        status            TEXT NOT NULL DEFAULT 'operational'
                            CHECK (status IN ('operational','fault','maintenance','offline')),
        last_reading_json JSONB,
        last_seen_at      TIMESTAMPTZ
      )
    `);

    await seedData(pool);
  } catch (err) {
    process.stderr.write(
      JSON.stringify({ level: 'WARN', msg: 'db schema init failed', error: String(err) }) + '\n'
    );
    throw err;
  }
}

async function seedData(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Equipment
    await client.query(`
      INSERT INTO equipment (equipment_id, name, type, line, site, status, last_reading_json, last_seen_at)
      VALUES
        ('SCALE-L3-02', 'Precision Scale L3-02', 'scale',        'Line 3', 'Northgate', 'operational',
          '{"net_kg": 12.48, "tare_kg": 0.52, "unit": "kg"}'::jsonb, NOW() - INTERVAL '2 minutes'),
        ('MIXER-L2-01', 'Granulation Mixer L2-01', 'mixer',      'Line 2', 'Northgate', 'fault',
          '{"rpm": 0, "temp_c": 22.1, "error": "motor_fault"}'::jsonb, NOW() - INTERVAL '47 minutes'),
        ('PRESS-L2-01', 'Tablet Press L2-01',     'tablet_press','Line 2', 'Northgate', 'maintenance',
          '{"punches_used": 4120000, "last_service": "2024-11-15"}'::jsonb, NOW() - INTERVAL '3 hours')
      ON CONFLICT (equipment_id) DO NOTHING
    `);

    // Batch records (7 released, 2 failed, 1 in_review)
    await client.query(`
      INSERT INTO batch_records
        (batch_id, product_code, product_name, status, quantity_units, value_usd, site, line, created_at, released_at, review_exceptions)
      VALUES
        ('NX-88201','NVX-100','Novaxil 100mg Tablet',   'released', 50000, 210000.00,'Northgate','Line 2', NOW()-INTERVAL '9 days',  NOW()-INTERVAL '9 days'+INTERVAL '4 hours', 0),
        ('NX-88215','NVX-250','Novaxil 250mg Capsule',  'released', 30000, 205500.00,'Northgate','Line 3', NOW()-INTERVAL '8 days',  NOW()-INTERVAL '8 days'+INTERVAL '3 hours', 1),
        ('NX-88229','CRD-050','Cardizen 50mg Tablet',   'released', 40000, 124000.00,'Northgate','Line 2', NOW()-INTERVAL '7 days',  NOW()-INTERVAL '7 days'+INTERVAL '5 hours', 0),
        ('NX-88244','IMU-010','Immunova 10mg/mL',        'failed',   20000,  368000.00,'Northgate','Line 3', NOW()-INTERVAL '6 days',  NULL, 2),
        ('NX-88258','NVX-100','Novaxil 100mg Tablet',   'released', 50000, 210000.00,'Northgate','Line 2', NOW()-INTERVAL '5 days',  NOW()-INTERVAL '5 days'+INTERVAL '4 hours', 0),
        ('NX-88271','CRD-050','Cardizen 50mg Tablet',   'released', 45000, 139500.00,'Northgate','Line 3', NOW()-INTERVAL '4 days',  NOW()-INTERVAL '4 days'+INTERVAL '6 hours', 3),
        ('NX-88283','NVX-250','Novaxil 250mg Capsule',  'failed',   28000, 191800.00,'Northgate','Line 2', NOW()-INTERVAL '3 days',  NULL, 4),
        ('NX-88295','IMU-010','Immunova 10mg/mL',        'released', 18000, 331200.00,'Northgate','Line 3', NOW()-INTERVAL '2 days',  NOW()-INTERVAL '2 days'+INTERVAL '5 hours', 1),
        ('NX-88307','NVX-100','Novaxil 100mg Tablet',   'released', 52000, 218400.00,'Northgate','Line 2', NOW()-INTERVAL '1 day',   NOW()-INTERVAL '1 day' +INTERVAL '4 hours', 0),
        ('NX-88319','CRD-050','Cardizen 50mg Tablet',   'in_review',48000, 148800.00,'Northgate','Line 3', NOW()-INTERVAL '2 hours', NULL, 0)
      ON CONFLICT (batch_id) DO NOTHING
    `);

    // Work orders (5 completed, 2 deviation, 1 in_progress)
    await client.query(`
      INSERT INTO work_orders
        (order_id, material_code, material_name, target_kg, actual_kg, status, priority, site, line, created_at, completed_at)
      VALUES
        ('WO-5101','API-4471','Active API Lot 4471', 12.5, 12.48, 'completed','normal',  'Northgate','Line 2', NOW()-INTERVAL '8 days', NOW()-INTERVAL '8 days'+INTERVAL '30 minutes'),
        ('WO-5108','EXC-2210','Excipient MCC 2210',   8.0,  8.02, 'completed','normal',  'Northgate','Line 3', NOW()-INTERVAL '7 days', NOW()-INTERVAL '7 days'+INTERVAL '25 minutes'),
        ('WO-5115','API-3308','Active API Lot 3308',  15.0, 14.62,'deviation','high',    'Northgate','Line 2', NOW()-INTERVAL '6 days', NOW()-INTERVAL '6 days'+INTERVAL '45 minutes'),
        ('WO-5122','API-4471','Active API Lot 4471',  12.5, 12.51,'completed','normal',  'Northgate','Line 3', NOW()-INTERVAL '5 days', NOW()-INTERVAL '5 days'+INTERVAL '28 minutes'),
        ('WO-5129','EXC-2210','Excipient MCC 2210',   8.0,  8.00, 'completed','normal',  'Northgate','Line 2', NOW()-INTERVAL '3 days', NOW()-INTERVAL '3 days'+INTERVAL '22 minutes'),
        ('WO-5136','API-3308','Active API Lot 3308',  15.0, 15.88,'deviation','high',    'Northgate','Line 3', NOW()-INTERVAL '2 days', NOW()-INTERVAL '2 days'+INTERVAL '50 minutes'),
        ('WO-5143','API-4471','Active API Lot 4471',  12.5, 12.49,'completed','normal',  'Northgate','Line 2', NOW()-INTERVAL '1 day',  NOW()-INTERVAL '1 day' +INTERVAL '31 minutes'),
        ('WO-5151','EXC-2210','Excipient MCC 2210',   8.0,  NULL, 'in_progress','urgent','Northgate','Line 3', NOW()-INTERVAL '20 minutes', NULL)
      ON CONFLICT (order_id) DO NOTHING
    `);

    // Deviations for the failed batches and deviated work orders
    await client.query(`
      INSERT INTO deviations
        (reference_id, reference_type, severity, description, status, site, created_at)
      VALUES
        ('NX-88244','batch',     'critical','Oracle deadlock during GxP release; SAP commit failed after 3 retries','investigating','Northgate', NOW()-INTERVAL '6 days'),
        ('NX-88283','batch',     'major',   'GxP integration 503 from SAP-ERP; LIMS record not created',            'open',          'Northgate', NOW()-INTERVAL '3 days'),
        ('WO-5115','work_order', 'major',   'Scale timeout: net weight 14.62 kg vs target 15.0 kg (delta -2.5%)',   'closed',        'Northgate', NOW()-INTERVAL '6 days'),
        ('WO-5136','work_order', 'minor',   'Net weight 15.88 kg vs target 15.0 kg (+5.9%); within safe range',     'open',          'Northgate', NOW()-INTERVAL '2 days')
      ON CONFLICT DO NOTHING
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { initDatabase };
