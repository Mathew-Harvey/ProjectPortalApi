const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const pool = require('./db');
const { createSchema } = require('./schema');

// Idempotent schema migration. Safe to re-run. Mirrors AppHub's single
// migrate.js (no migration framework, no versioned files).
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await createSchema(client);
    await client.query('COMMIT');
    console.log('Migration complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error('Migration failed:', err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = migrate;
