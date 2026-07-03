'use strict';

let _pool = null;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (_pool) return _pool;
  const { Pool } = require('pg');
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 3000,
  });
  _pool.on('error', (err) => {
    process.stderr.write(
      JSON.stringify({ level: 'ERROR', msg: 'pg pool error', error: String(err) }) + '\n'
    );
  });
  return _pool;
}

module.exports = { getPool };
