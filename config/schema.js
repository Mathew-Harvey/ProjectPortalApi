// Single source of truth for the database schema.
//
// Used by config/migrate.js (against real Postgres) AND tests/setup.js (against
// pg-mem) so the two can never drift. Every statement is idempotent
// (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so re-running is safe.
//
// Conventions mirror AppHub:
//   - UUID PKs via uuid_generate_v4() (the event log uses BIGSERIAL).
//   - Enums modelled as VARCHAR + CHECK, not native PG enum types.
//   - Every table carries org_id / project_id scoping columns even though there
//     is one organisation today (durable multi-tenancy foundation).
//   - `event` and `media` are APPEND-ONLY / immutable after insert.

async function createSchema(client) {
  // organisation(id, name)
  await client.query(`
    CREATE TABLE IF NOT EXISTS organisation (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name VARCHAR(255) NOT NULL UNIQUE,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // project(id, org_id, name, asset_ref)
  await client.query(`
    CREATE TABLE IF NOT EXISTS project (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      org_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      asset_ref VARCHAR(255),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (org_id, name)
    )
  `);

  // app_user(id, org_id, email, name, role)
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_user (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      org_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL CHECK (role IN ('admin_pm', 'engineer', 'field', 'client')),
      password_hash VARCHAR(255) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // work_item(id, project_id, ref_code, location_ref, method, status)
  await client.query(`
    CREATE TABLE IF NOT EXISTS work_item (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      project_id UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
      ref_code VARCHAR(100) NOT NULL,
      location_ref VARCHAR(255),
      method VARCHAR(20) NOT NULL CHECK (method IN ('weld', 'composite')),
      status VARCHAR(20) NOT NULL DEFAULT 'find'
        CHECK (status IN ('find', 'engineer', 'fix', 'verify', 'closed')),
      created_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, ref_code)
    )
  `);

  // media(id, work_item_id, url, mime, sha256, exif, captured_at, uploaded_by)
  // APPEND-ONLY: rows are immutable after insert. Bytes are stored in `content`
  // (bytea) per the "content lives in Postgres" decision; `url` is the API path
  // used to fetch them back.
  await client.query(`
    CREATE TABLE IF NOT EXISTS media (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      work_item_id UUID NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
      url VARCHAR(500),
      mime VARCHAR(100),
      sha256 VARCHAR(64) NOT NULL,
      exif JSONB NOT NULL DEFAULT '{}'::jsonb,
      content BYTEA NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      original_filename VARCHAR(255),
      captured_at TIMESTAMP,
      uploaded_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // inspection(id, work_item_id, template_key, data jsonb, captured_by, captured_at)
  await client.query(`
    CREATE TABLE IF NOT EXISTS inspection (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      work_item_id UUID NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
      template_key VARCHAR(100) NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      captured_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
      captured_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // spec(id, work_item_id, engineer_id, doc_media_id, status, approved_by, approved_at)
  await client.query(`
    CREATE TABLE IF NOT EXISTS spec (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      work_item_id UUID NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
      engineer_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
      doc_media_id UUID REFERENCES media(id) ON DELETE SET NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'approved', 'superseded')),
      notes TEXT,
      approved_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
      approved_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // hold_point(id, work_item_id, label, sequence, signed_by, signed_at)
  await client.query(`
    CREATE TABLE IF NOT EXISTS hold_point (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      work_item_id UUID NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
      label VARCHAR(255) NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      signed_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
      signed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // qa_record(id, work_item_id, template_key, data jsonb, signed_off_by,
  //           client_sign_by, client_sign_at)
  await client.query(`
    CREATE TABLE IF NOT EXISTS qa_record (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      work_item_id UUID NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
      org_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
      template_key VARCHAR(100) NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      signed_off_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
      signed_off_at TIMESTAMP,
      client_sign_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
      client_sign_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // event(id, project_id, work_item_id NULL, actor_id, type, payload jsonb, created_at)
  // APPEND-ONLY. Never UPDATE or DELETE. work_item_id is intentionally NOT
  // FK-constrained so the audit trail survives work_item deletion (mirrors
  // AppHub's audit_log, which keeps app_id un-FK'd by design).
  await client.query(`
    CREATE TABLE IF NOT EXISTS event (
      id BIGSERIAL PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      work_item_id UUID,
      org_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
      actor_id UUID REFERENCES app_user(id) ON DELETE SET NULL,
      type VARCHAR(80) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // template(method, kind, definition jsonb) — seed/config data.
  await client.query(`
    CREATE TABLE IF NOT EXISTS template (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      method VARCHAR(20) NOT NULL CHECK (method IN ('weld', 'composite')),
      kind VARCHAR(20) NOT NULL CHECK (kind IN ('rds', 'itp', 'qa', 'docpack')),
      definition JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (method, kind)
    )
  `);

  // Helpful read indexes for the timelines and registers.
  await safeIndex(client, `CREATE INDEX IF NOT EXISTS idx_event_work_item ON event(work_item_id, id)`);
  await safeIndex(client, `CREATE INDEX IF NOT EXISTS idx_event_project ON event(project_id, id)`);
  await safeIndex(client, `CREATE INDEX IF NOT EXISTS idx_work_item_project ON work_item(project_id)`);
  await safeIndex(client, `CREATE INDEX IF NOT EXISTS idx_media_work_item ON media(work_item_id)`);
  await safeIndex(client, `CREATE INDEX IF NOT EXISTS idx_hold_point_work_item ON hold_point(work_item_id, sequence)`);
}

// pg-mem doesn't support every index form; never let an index failure abort the
// schema build there. Real Postgres executes these normally.
async function safeIndex(client, sql) {
  try {
    await client.query(sql);
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') throw err;
  }
}

module.exports = { createSchema };
