const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const { TEMPLATES } = require('./templates');

// Idempotent seed data for job one. Safe to run on every startup and as a
// script (`npm run db:seed`). Uses existence checks (not ON CONFLICT) so it runs
// identically on real Postgres and pg-mem.

const ORG_NAME = 'Franmarine';
const PROJECT_NAME = 'Berth 3 Jetty Remediation';
const PROJECT_ASSET_REF = 'JETTY-B3';

// One user per role. The shared demo password is documented in the README and
// overridable via SEED_PASSWORD. These are demo logins, not production secrets.
const DEMO_USERS = [
  { email: 'pm@franmarine.com.au', name: 'Sam Project', role: 'admin_pm' },
  { email: 'engineer@franmarine.com.au', name: 'Dr. Indira Engineer', role: 'engineer' },
  { email: 'field@franmarine.com.au', name: 'Dee Diver', role: 'field' },
  { email: 'client@franmarine.com.au', name: 'Casey Client', role: 'client' },
];

async function seedTemplates(runner) {
  for (const t of TEMPLATES) {
    const existing = await runner.query(
      'SELECT id FROM template WHERE method = $1 AND kind = $2',
      [t.method, t.kind]
    );
    if (existing.rows.length === 0) {
      await runner.query(
        'INSERT INTO template (method, kind, definition) VALUES ($1, $2, $3::jsonb)',
        [t.method, t.kind, JSON.stringify(t.definition)]
      );
    } else {
      // Keep definitions in sync with config on redeploy. Templates are config,
      // so refreshing them is expected; it never touches captured work data.
      await runner.query(
        'UPDATE template SET definition = $3::jsonb, updated_at = NOW() WHERE method = $1 AND kind = $2',
        [t.method, t.kind, JSON.stringify(t.definition)]
      );
    }
  }
}

async function seedDemo(runner) {
  // Organisation
  let org = await runner.query('SELECT id FROM organisation WHERE name = $1', [ORG_NAME]);
  if (org.rows.length === 0) {
    org = await runner.query(
      'INSERT INTO organisation (name) VALUES ($1) RETURNING id',
      [ORG_NAME]
    );
  }
  const orgId = org.rows[0].id;

  // Project (the jetty asset)
  let project = await runner.query(
    'SELECT id FROM project WHERE org_id = $1 AND name = $2',
    [orgId, PROJECT_NAME]
  );
  if (project.rows.length === 0) {
    project = await runner.query(
      'INSERT INTO project (org_id, name, asset_ref) VALUES ($1, $2, $3) RETURNING id',
      [orgId, PROJECT_NAME, PROJECT_ASSET_REF]
    );
  }
  const projectId = project.rows[0].id;

  // One user per role. These are seeded demo accounts, so we keep their
  // password in sync with SEED_PASSWORD on every run — otherwise changing
  // SEED_PASSWORD after the first deploy would silently have no effect.
  const password = process.env.SEED_PASSWORD || 'Password123';
  const passwordHash = await bcrypt.hash(password, 12);
  const users = {};
  for (const u of DEMO_USERS) {
    let row = await runner.query('SELECT id, role FROM app_user WHERE email = $1', [u.email]);
    if (row.rows.length === 0) {
      row = await runner.query(
        `INSERT INTO app_user (org_id, email, name, role, password_hash)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, role`,
        [orgId, u.email, u.name, u.role, passwordHash]
      );
    } else {
      await runner.query(
        'UPDATE app_user SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [passwordHash, row.rows[0].id]
      );
    }
    users[u.role] = row.rows[0].id;
  }

  return { orgId, projectId, users };
}

async function seedAll(runner) {
  await seedTemplates(runner);
  const demo = await seedDemo(runner);
  return demo;
}

if (require.main === module) {
  const pool = require('./db');
  seedAll(pool)
    .then((demo) => {
      console.log('Seed complete:', demo);
      return pool.end();
    })
    .catch((err) => {
      console.error('Seed failed:', err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = {
  seedAll,
  seedTemplates,
  seedDemo,
  ORG_NAME,
  PROJECT_NAME,
  PROJECT_ASSET_REF,
  DEMO_USERS,
};
