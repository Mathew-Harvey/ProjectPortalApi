const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const { auth, requireRole, validateId, verifyInviteToken } = require('../middleware/auth');
const events = require('../services/events');
const mediaSvc = require('../services/media');
const notify = require('../services/notify');
const { streamDocPack } = require('../services/docpack');

const router = express.Router();

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE, 10) || 10 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

// Hardcoded lifecycle — NOT a configurable workflow engine.
//   find -> engineer -> fix -> verify -> closed
const ALLOWED = {
  find: ['engineer'],
  engineer: ['fix'],
  fix: ['verify'],
  verify: ['closed'],
  closed: [],
};

// ── helpers ────────────────────────────────────────────────────────
async function getWorkItem(id, orgId) {
  const result = await pool.query(
    'SELECT * FROM work_item WHERE id = $1 AND org_id = $2',
    [id, orgId]
  );
  return result.rows[0] || null;
}

async function getTemplate(client, method, kind) {
  const result = await client.query(
    'SELECT method, kind, definition FROM template WHERE method = $1 AND kind = $2',
    [method, kind]
  );
  return result.rows[0] || null;
}

async function hasApprovedSpec(client, workItemId) {
  const result = await client.query(
    `SELECT 1 FROM spec WHERE work_item_id = $1 AND status = 'approved' LIMIT 1`,
    [workItemId]
  );
  return result.rows.length > 0;
}

// Update work_item.status with transition + gate validation, and write the
// status-change event in the SAME transaction. Throws { httpStatus } on a bad
// transition so the gate and lifecycle can't be bypassed.
async function transitionTo(client, wi, newStatus, actorId, extra = {}) {
  if (!ALLOWED[wi.status] || !ALLOWED[wi.status].includes(newStatus)) {
    const err = new Error(`Illegal transition ${wi.status} -> ${newStatus}`);
    err.httpStatus = 409;
    err.code = 'illegal_transition';
    throw err;
  }
  // Hard gate: a work_item may not enter `fix` unless an approved spec exists.
  if (newStatus === 'fix' && !(await hasApprovedSpec(client, wi.id))) {
    const err = new Error('Cannot enter fix: no approved spec');
    err.httpStatus = 409;
    err.code = 'gate_blocked';
    throw err;
  }
  await client.query('UPDATE work_item SET status = $1, updated_at = NOW() WHERE id = $2', [newStatus, wi.id]);
  await events.log(client, {
    projectId: wi.project_id,
    workItemId: wi.id,
    orgId: wi.org_id,
    actorId,
    type: 'work_item.status_changed',
    payload: { from: wi.status, to: newStatus, ...extra },
  });
  return newStatus;
}

// Run an async handler inside a transaction; translate thrown { httpStatus }.
async function withTx(res, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.httpStatus) {
      return res.status(err.httpStatus).json({ error: err.code || 'conflict', message: err.message });
    }
    console.error('Transaction error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

// ── create from RDS (find) ─────────────────────────────────────────
// POST /api/work-items  (admin_pm)
router.post('/', auth, requireRole('admin_pm'), async (req, res) => {
  const { projectId, refCode, locationRef, method, inspection } = req.body || {};
  if (!projectId || !refCode || !method) {
    return res.status(400).json({ error: 'projectId, refCode and method are required' });
  }
  if (!['weld', 'composite'].includes(method)) {
    return res.status(400).json({ error: "method must be 'weld' or 'composite'" });
  }
  // Per-step assignees: { engineer, field, client } email addresses. Each is
  // emailed only at their own step, with an invite that creates their account
  // in that role — so the person you send a step to can actually do it.
  const assignees = notify.cleanAssignees(req.body?.assignees);

  const project = await pool.query('SELECT id, org_id FROM project WHERE id = $1 AND org_id = $2', [projectId, req.user.orgId]);
  if (project.rows.length === 0) {
    return res.status(404).json({ error: 'Project not found' });
  }
  const orgId = req.user.orgId;

  const created = await withTx(res, async (client) => {
    // Unique ref_code per project
    const dup = await client.query('SELECT 1 FROM work_item WHERE project_id = $1 AND ref_code = $2', [projectId, refCode]);
    if (dup.rows.length > 0) {
      const err = new Error('A work item with this ref_code already exists in the project');
      err.httpStatus = 409; err.code = 'duplicate_ref_code';
      throw err;
    }

    const wiResult = await client.query(
      `INSERT INTO work_item (project_id, org_id, ref_code, location_ref, method, status, assignees, created_by)
       VALUES ($1, $2, $3, $4, $5, 'find', $6::jsonb, $7) RETURNING *`,
      [projectId, orgId, refCode, locationRef || null, method, JSON.stringify(assignees), req.user.id]
    );
    const wi = wiResult.rows[0];

    // Instantiate ITP hold points from the method's itp template.
    const itp = await getTemplate(client, method, 'itp');
    const holdPoints = (itp?.definition?.holdPoints) || [];
    for (const hp of holdPoints) {
      await client.query(
        'INSERT INTO hold_point (work_item_id, org_id, label, sequence) VALUES ($1, $2, $3, $4)',
        [wi.id, orgId, hp.label, hp.sequence || 0]
      );
    }

    await events.log(client, {
      projectId, workItemId: wi.id, orgId, actorId: req.user.id,
      type: 'work_item.created',
      payload: { refCode, method, locationRef: locationRef || null, holdPoints: holdPoints.length },
    });

    // Optional RDS intake captured at creation (the `find` step).
    if (inspection && inspection.data) {
      const templateKey = inspection.templateKey || `${method}.rds`;
      await client.query(
        `INSERT INTO inspection (work_item_id, org_id, template_key, data, captured_by)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [wi.id, orgId, templateKey, JSON.stringify(inspection.data), req.user.id]
      );
      await events.log(client, {
        projectId, workItemId: wi.id, orgId, actorId: req.user.id,
        type: 'inspection.captured',
        payload: { templateKey },
      });
    }

    return wi;
  });

  if (created && !res.headersSent) {
    res.status(201).json({ workItem: created });
    // Notify the engineer (+ any extra emails) that a spec is required. Fire-
    // and-forget so email never blocks or breaks the response.
    notify.steps.specRequired(created);
  }
});

// Assemble the full work-item card (inspection/specs/hold points/qa/media/events).
// Shared by the authenticated GET and the invite-view (guest) read.
async function buildCard(wi) {
  const [inspection, specs, holdPoints, qa, media] = await Promise.all([
    pool.query('SELECT * FROM inspection WHERE work_item_id = $1 ORDER BY captured_at DESC LIMIT 1', [wi.id]),
    pool.query(
      `SELECT s.*, e.name AS engineer_name, a.name AS approver_name
       FROM spec s
       LEFT JOIN app_user e ON s.engineer_id = e.id
       LEFT JOIN app_user a ON s.approved_by = a.id
       WHERE s.work_item_id = $1 ORDER BY s.created_at ASC`, [wi.id]),
    pool.query(
      `SELECT h.*, u.name AS signer_name
       FROM hold_point h LEFT JOIN app_user u ON h.signed_by = u.id
       WHERE h.work_item_id = $1 ORDER BY h.sequence ASC`, [wi.id]),
    pool.query('SELECT * FROM qa_record WHERE work_item_id = $1 ORDER BY created_at DESC LIMIT 1', [wi.id]),
    pool.query(
      `SELECT id, work_item_id, url, mime, sha256, exif, byte_size, original_filename, captured_at, uploaded_by, created_at
       FROM media WHERE work_item_id = $1 ORDER BY created_at ASC`, [wi.id]),
  ]);
  const timeline = await events.listForWorkItem(wi.id);
  return {
    workItem: wi,
    inspection: inspection.rows[0] || null,
    specs: specs.rows,
    holdPoints: holdPoints.rows,
    qa: qa.rows[0] || null,
    media: media.rows,
    events: timeline,
  };
}

// ── full card ──────────────────────────────────────────────────────
// GET /api/work-items/:id
router.get('/:id', auth, validateId('id'), async (req, res) => {
  try {
    const wi = await getWorkItem(req.params.id, req.user.orgId);
    if (!wi) return res.status(404).json({ error: 'Work item not found' });
    res.json(await buildCard(wi));
  } catch (err) {
    console.error('Get work item error:', err);
    res.status(500).json({ error: 'Failed to load work item' });
  }
});

// ── invite preview (no session) ────────────────────────────────────
// GET /api/work-items/:id/invite-view?token=...
// Lets a person who was emailed a step view the work item read-only before they
// have an account. The token is bound to this work item id.
router.get('/:id/invite-view', validateId('id'), async (req, res) => {
  const decoded = verifyInviteToken(req.query.token);
  if (!decoded || decoded.workItemId !== req.params.id) {
    return res.status(401).json({ error: 'invalid_invite', message: 'This invite link is invalid or has expired.' });
  }
  try {
    const wiRes = await pool.query('SELECT * FROM work_item WHERE id = $1', [req.params.id]);
    const wi = wiRes.rows[0];
    if (!wi) return res.status(404).json({ error: 'Work item not found' });
    const card = await buildCard(wi);
    const existing = await pool.query('SELECT 1 FROM app_user WHERE email = $1', [decoded.email.toLowerCase()]);
    res.json({ ...card, invite: { email: decoded.email, role: decoded.role, exists: existing.rows.length > 0 } });
  } catch (err) {
    console.error('Invite view error:', err);
    res.status(500).json({ error: 'Failed to load work item' });
  }
});

// GET /api/work-items/:id/events
router.get('/:id/events', auth, validateId('id'), async (req, res) => {
  try {
    const wi = await getWorkItem(req.params.id, req.user.orgId);
    if (!wi) return res.status(404).json({ error: 'Work item not found' });
    res.json({ events: await events.listForWorkItem(wi.id) });
  } catch (err) {
    console.error('Work item events error:', err);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

// ── RDS intake (find) ──────────────────────────────────────────────
// POST /api/work-items/:id/inspection  (admin_pm, field)
router.post('/:id/inspection', auth, validateId('id'), requireRole('admin_pm', 'field'), async (req, res) => {
  const wi = await getWorkItem(req.params.id, req.user.orgId);
  if (!wi) return res.status(404).json({ error: 'Work item not found' });
  const { data, templateKey } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'data object is required' });
  }
  const key = templateKey || `${wi.method}.rds`;

  const out = await withTx(res, async (client) => {
    const ins = await client.query(
      `INSERT INTO inspection (work_item_id, org_id, template_key, data, captured_by)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING *`,
      [wi.id, wi.org_id, key, JSON.stringify(data), req.user.id]
    );
    await events.log(client, {
      projectId: wi.project_id, workItemId: wi.id, orgId: wi.org_id, actorId: req.user.id,
      type: 'inspection.captured', payload: { templateKey: key },
    });
    return ins.rows[0];
  });
  if (out && !res.headersSent) res.status(201).json({ inspection: out });
});

// ── spec submit (find/engineer -> engineer) ────────────────────────
// POST /api/work-items/:id/spec  (engineer)
router.post('/:id/spec', auth, validateId('id'), requireRole('engineer'), async (req, res) => {
  const wi = await getWorkItem(req.params.id, req.user.orgId);
  if (!wi) return res.status(404).json({ error: 'Work item not found' });
  if (!['find', 'engineer'].includes(wi.status)) {
    return res.status(409).json({ error: 'illegal_state', message: `Cannot submit a spec while status is ${wi.status}` });
  }
  const { notes, docMediaId } = req.body || {};

  const out = await withTx(res, async (client) => {
    // Supersede any prior draft so there is one active draft to approve.
    await client.query(
      `UPDATE spec SET status = 'superseded' WHERE work_item_id = $1 AND status = 'draft'`,
      [wi.id]
    );
    const spec = await client.query(
      `INSERT INTO spec (work_item_id, org_id, engineer_id, doc_media_id, status, notes)
       VALUES ($1, $2, $3, $4, 'draft', $5) RETURNING *`,
      [wi.id, wi.org_id, req.user.id, docMediaId || null, notes || null]
    );
    await events.log(client, {
      projectId: wi.project_id, workItemId: wi.id, orgId: wi.org_id, actorId: req.user.id,
      type: 'spec.submitted', payload: { specId: spec.rows[0].id, docMediaId: docMediaId || null },
    });
    if (wi.status === 'find') {
      await transitionTo(client, wi, 'engineer', req.user.id, { reason: 'spec.submitted' });
    }
    return spec.rows[0];
  });
  if (out && !res.headersSent) res.status(201).json({ spec: out });
});

// ── spec approve (the gate; engineer -> fix) ───────────────────────
// POST /api/work-items/:id/spec/:specId/approve  (engineer)
router.post('/:id/spec/:specId/approve', auth, validateId('id'), validateId('specId'), requireRole('engineer'), async (req, res) => {
  const wi = await getWorkItem(req.params.id, req.user.orgId);
  if (!wi) return res.status(404).json({ error: 'Work item not found' });

  const out = await withTx(res, async (client) => {
    const specRes = await client.query(
      'SELECT * FROM spec WHERE id = $1 AND work_item_id = $2',
      [req.params.specId, wi.id]
    );
    const spec = specRes.rows[0];
    if (!spec) { const e = new Error('Spec not found'); e.httpStatus = 404; e.code = 'not_found'; throw e; }
    if (spec.status !== 'draft') {
      const e = new Error(`Spec is ${spec.status}, only a draft can be approved`); e.httpStatus = 409; e.code = 'illegal_state'; throw e;
    }
    await client.query(
      `UPDATE spec SET status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2`,
      [req.user.id, spec.id]
    );
    await events.log(client, {
      projectId: wi.project_id, workItemId: wi.id, orgId: wi.org_id, actorId: req.user.id,
      type: 'spec.approved', payload: { specId: spec.id },
    });
    // Now the gate opens: transition to fix (transitionTo re-checks the approved spec).
    await transitionTo(client, wi, 'fix', req.user.id, { reason: 'spec.approved' });
    return { specId: spec.id };
  });
  if (out && !res.headersSent) {
    res.json({ ok: true, specId: out.specId, status: 'fix' });
    notify.steps.executionAuthorised(wi); // field crew can now sign hold points
  }
});

// ── sign ITP hold point (fix action — blocked until approved) ──────
// POST /api/work-items/:id/hold-points/:hpId/sign  (field)
router.post('/:id/hold-points/:hpId/sign', auth, validateId('id'), validateId('hpId'), requireRole('field'), async (req, res) => {
  const wi = await getWorkItem(req.params.id, req.user.orgId);
  if (!wi) return res.status(404).json({ error: 'Work item not found' });
  if (wi.status !== 'fix') {
    return res.status(409).json({ error: 'gate_blocked', message: 'Hold points can only be signed once the spec is approved (status fix)' });
  }

  const out = await withTx(res, async (client) => {
    const hpRes = await client.query('SELECT * FROM hold_point WHERE id = $1 AND work_item_id = $2', [req.params.hpId, wi.id]);
    const hp = hpRes.rows[0];
    if (!hp) { const e = new Error('Hold point not found'); e.httpStatus = 404; e.code = 'not_found'; throw e; }
    if (hp.signed_at) { const e = new Error('Hold point already signed'); e.httpStatus = 409; e.code = 'already_signed'; throw e; }
    await client.query('UPDATE hold_point SET signed_by = $1, signed_at = NOW() WHERE id = $2', [req.user.id, hp.id]);
    await events.log(client, {
      projectId: wi.project_id, workItemId: wi.id, orgId: wi.org_id, actorId: req.user.id,
      type: 'hold_point.signed', payload: { holdPointId: hp.id, label: hp.label, sequence: hp.sequence },
    });
    return { holdPointId: hp.id };
  });
  if (out && !res.headersSent) res.json({ ok: true, holdPointId: out.holdPointId });
});

// ── capture QA (fix -> verify) ─────────────────────────────────────
// POST /api/work-items/:id/qa  (field, admin_pm)
router.post('/:id/qa', auth, validateId('id'), requireRole('field', 'admin_pm'), async (req, res) => {
  const wi = await getWorkItem(req.params.id, req.user.orgId);
  if (!wi) return res.status(404).json({ error: 'Work item not found' });
  if (wi.status !== 'fix') {
    return res.status(409).json({ error: 'illegal_state', message: `QA can only be captured from status fix (currently ${wi.status})` });
  }
  const { data, templateKey } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'data object is required' });
  }
  const key = templateKey || `${wi.method}.qa`;

  const out = await withTx(res, async (client) => {
    const qa = await client.query(
      `INSERT INTO qa_record (work_item_id, org_id, template_key, data, signed_off_by, signed_off_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW()) RETURNING *`,
      [wi.id, wi.org_id, key, JSON.stringify(data), req.user.id]
    );
    await events.log(client, {
      projectId: wi.project_id, workItemId: wi.id, orgId: wi.org_id, actorId: req.user.id,
      type: 'qa.captured', payload: { qaId: qa.rows[0].id, templateKey: key },
    });
    await transitionTo(client, wi, 'verify', req.user.id, { reason: 'qa.captured' });
    return qa.rows[0];
  });
  if (out && !res.headersSent) {
    res.status(201).json({ qa: out, status: 'verify' });
    notify.steps.clientSignOffRequired(wi); // client must sign off
  }
});

// ── client sign-off on QA (verify) ─────────────────────────────────
// POST /api/work-items/:id/qa/:qaId/client-sign  (client)
router.post('/:id/qa/:qaId/client-sign', auth, validateId('id'), validateId('qaId'), requireRole('client'), async (req, res) => {
  const wi = await getWorkItem(req.params.id, req.user.orgId);
  if (!wi) return res.status(404).json({ error: 'Work item not found' });

  const out = await withTx(res, async (client) => {
    const qaRes = await client.query('SELECT * FROM qa_record WHERE id = $1 AND work_item_id = $2', [req.params.qaId, wi.id]);
    const qa = qaRes.rows[0];
    if (!qa) { const e = new Error('QA record not found'); e.httpStatus = 404; e.code = 'not_found'; throw e; }
    if (qa.client_sign_at) { const e = new Error('QA already client-signed'); e.httpStatus = 409; e.code = 'already_signed'; throw e; }
    await client.query('UPDATE qa_record SET client_sign_by = $1, client_sign_at = NOW() WHERE id = $2', [req.user.id, qa.id]);
    await events.log(client, {
      projectId: wi.project_id, workItemId: wi.id, orgId: wi.org_id, actorId: req.user.id,
      type: 'qa.client_signed', payload: { qaId: qa.id },
    });
    return { qaId: qa.id };
  });
  if (out && !res.headersSent) {
    res.json({ ok: true, qaId: out.qaId });
    notify.steps.readyToClose(wi); // PM can close
  }
});

// ── close (verify -> closed) ───────────────────────────────────────
// POST /api/work-items/:id/close  (admin_pm)
router.post('/:id/close', auth, validateId('id'), requireRole('admin_pm'), async (req, res) => {
  const wi = await getWorkItem(req.params.id, req.user.orgId);
  if (!wi) return res.status(404).json({ error: 'Work item not found' });
  if (wi.status !== 'verify') {
    return res.status(409).json({ error: 'illegal_state', message: `Can only close from status verify (currently ${wi.status})` });
  }
  const out = await withTx(res, async (client) => {
    await transitionTo(client, wi, 'closed', req.user.id, { reason: 'closed' });
    await events.log(client, {
      projectId: wi.project_id, workItemId: wi.id, orgId: wi.org_id, actorId: req.user.id,
      type: 'work_item.closed', payload: {},
    });
    return { id: wi.id };
  });
  if (out && !res.headersSent) {
    res.json({ ok: true, status: 'closed' });
    notify.steps.closed(wi); // courtesy completion notice
  }
});

// ── media upload (sha256 + exif at capture) ────────────────────────
// POST /api/work-items/:id/media  (admin_pm, engineer, field)  multipart 'file'
router.post('/:id/media', auth, validateId('id'), requireRole('admin_pm', 'engineer', 'field'), upload.single('file'), async (req, res) => {
  const wi = await getWorkItem(req.params.id, req.user.orgId);
  if (!wi) return res.status(404).json({ error: 'Work item not found' });
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'file is required (multipart field "file")' });
  }

  const buffer = req.file.buffer;
  const mime = req.file.mimetype || 'application/octet-stream';
  const sha256 = mediaSvc.sha256(buffer);
  const exif = await mediaSvc.extractExif(buffer, mime);
  const capturedAt = mediaSvc.capturedAtFromExif(exif);

  // Generate the id (and therefore the url) up front so media is a single
  // insert — the row is immutable from the moment it lands, never UPDATEd.
  const mediaId = uuidv4();
  const url = `/api/work-items/${wi.id}/media/${mediaId}`;

  const out = await withTx(res, async (client) => {
    const inserted = await client.query(
      `INSERT INTO media (id, work_item_id, org_id, url, mime, sha256, exif, content, byte_size, original_filename, captured_at, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
       RETURNING id, work_item_id, url, mime, sha256, exif, byte_size, original_filename, captured_at, uploaded_by, created_at`,
      [mediaId, wi.id, wi.org_id, url, mime, sha256, JSON.stringify(exif), buffer, buffer.length, req.file.originalname || null, capturedAt, req.user.id]
    );
    const row = inserted.rows[0];
    await events.log(client, {
      projectId: wi.project_id, workItemId: wi.id, orgId: wi.org_id, actorId: req.user.id,
      type: 'media.uploaded',
      payload: { mediaId: row.id, sha256, mime, byteSize: buffer.length, filename: req.file.originalname || null },
    });
    return row;
  });
  if (out && !res.headersSent) res.status(201).json({ media: out });
});

// GET /api/work-items/:id/media/:mediaId — stream the stored bytes.
router.get('/:id/media/:mediaId', auth, validateId('id'), validateId('mediaId'), async (req, res) => {
  try {
    const wi = await getWorkItem(req.params.id, req.user.orgId);
    if (!wi) return res.status(404).json({ error: 'Work item not found' });
    const result = await pool.query(
      'SELECT mime, content, original_filename FROM media WHERE id = $1 AND work_item_id = $2',
      [req.params.mediaId, wi.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Media not found' });
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    if (row.original_filename) {
      res.setHeader('Content-Disposition', `inline; filename="${row.original_filename.replace(/"/g, '')}"`);
    }
    res.send(row.content);
  } catch (err) {
    console.error('Media fetch error:', err);
    res.status(500).json({ error: 'Failed to load media' });
  }
});

// ── doc-pack PDF export ────────────────────────────────────────────
// GET /api/work-items/:id/docpack  (all roles)
router.get('/:id/docpack', auth, validateId('id'), async (req, res) => {
  try {
    const wi = await getWorkItem(req.params.id, req.user.orgId);
    if (!wi) return res.status(404).json({ error: 'Work item not found' });

    const [org, project, inspection, specRes, holdPoints, qa, media, rdsTpl, qaTpl, docTpl] = await Promise.all([
      pool.query('SELECT id, name FROM organisation WHERE id = $1', [wi.org_id]),
      pool.query('SELECT id, name, asset_ref FROM project WHERE id = $1', [wi.project_id]),
      pool.query('SELECT * FROM inspection WHERE work_item_id = $1 ORDER BY captured_at DESC LIMIT 1', [wi.id]),
      pool.query(
        `SELECT s.*, e.name AS engineer_name FROM spec s LEFT JOIN app_user e ON s.engineer_id = e.id
         WHERE s.work_item_id = $1 AND s.status = 'approved' ORDER BY s.approved_at DESC LIMIT 1`, [wi.id]),
      pool.query(
        `SELECT h.*, u.name AS signer_name FROM hold_point h LEFT JOIN app_user u ON h.signed_by = u.id
         WHERE h.work_item_id = $1 ORDER BY h.sequence ASC`, [wi.id]),
      pool.query('SELECT * FROM qa_record WHERE work_item_id = $1 ORDER BY created_at DESC LIMIT 1', [wi.id]),
      pool.query('SELECT id, mime, sha256, original_filename, captured_at FROM media WHERE work_item_id = $1 ORDER BY created_at ASC', [wi.id]),
      pool.query('SELECT method, kind, definition FROM template WHERE method = $1 AND kind = $2', [wi.method, 'rds']),
      pool.query('SELECT method, kind, definition FROM template WHERE method = $1 AND kind = $2', [wi.method, 'qa']),
      pool.query('SELECT method, kind, definition FROM template WHERE method = $1 AND kind = $2', [wi.method, 'docpack']),
    ]);

    const spec = specRes.rows[0] || null;
    const filename = `docpack-${wi.ref_code}.pdf`.replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    streamDocPack(res, {
      org: org.rows[0],
      project: project.rows[0],
      workItem: wi,
      inspection: inspection.rows[0] || null,
      rdsTemplate: rdsTpl.rows[0] || null,
      spec,
      engineer: spec ? { name: spec.engineer_name } : null,
      holdPoints: holdPoints.rows,
      qa: qa.rows[0] || null,
      qaTemplate: qaTpl.rows[0] || null,
      media: media.rows,
      docpackTemplate: docTpl.rows[0] || null,
    });
  } catch (err) {
    console.error('Doc-pack error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate doc pack' });
  }
});

module.exports = router;
