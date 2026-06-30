const path = require('path');
const { Pool } = require('pg');
// Load .env from the project root regardless of where node was launched
// (e.g. `node config/migrate.js` from inside config/).
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const isTest = process.env.NODE_ENV === 'test';

// SSL in production, or whenever DATABASE_SSLMODE is set. `no-verify` accepts
// self-signed certs (Render's managed Postgres).
const useSsl = process.env.NODE_ENV === 'production' || process.env.DATABASE_SSLMODE;

const DEFAULT_POOL_MAX = 30;
const poolMax = isTest
  ? 5
  : Math.max(5, parseInt(process.env.DB_POOL_MAX, 10) || DEFAULT_POOL_MAX);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl
    ? { rejectUnauthorized: process.env.DATABASE_SSLMODE !== 'no-verify' }
    : false,
  max: poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: isTest ? 10000 : 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client:', err.message);
});

module.exports = pool;
