const express = require('express');
const pool = require('../config/db');
const { auth, validateId } = require('../middleware/auth');
const events = require('../services/events');

const router = express.Router();

// All routes are org-scoped: a user only ever sees their organisation's data.
async function projectInOrg(projectId, orgId) {
  const result = await pool.query(
    'SELECT id, org_id, name, asset_ref, created_at FROM project WHERE id = $1 AND org_id = $2',
    [projectId, orgId]
  );
  return result.rows[0] || null;
}

// GET /api/projects — list projects in the caller's organisation.
router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, org_id, name, asset_ref, created_at FROM project WHERE org_id = $1 ORDER BY created_at ASC',
      [req.user.orgId]
    );
    res.json({ projects: result.rows });
  } catch (err) {
    console.error('List projects error:', err);
    res.status(500).json({ error: 'Failed to load projects' });
  }
});

// GET /api/projects/:id/work-items — the repair register.
router.get('/:id/work-items', auth, validateId('id'), async (req, res) => {
  try {
    const project = await projectInOrg(req.params.id, req.user.orgId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const result = await pool.query(
      `SELECT w.id, w.ref_code, w.location_ref, w.method, w.status, w.created_at, w.updated_at,
              (SELECT COUNT(*) FROM media m WHERE m.work_item_id = w.id) AS media_count,
              (SELECT COUNT(*) FROM hold_point h WHERE h.work_item_id = w.id) AS hold_point_count,
              (SELECT COUNT(*) FROM hold_point h WHERE h.work_item_id = w.id AND h.signed_at IS NOT NULL) AS hold_point_signed_count,
              EXISTS (SELECT 1 FROM spec s WHERE s.work_item_id = w.id AND s.status = 'approved') AS spec_approved
       FROM work_item w
       WHERE w.project_id = $1
       ORDER BY w.created_at DESC`,
      [project.id]
    );
    res.json({ project, workItems: result.rows });
  } catch (err) {
    console.error('List work items error:', err);
    res.status(500).json({ error: 'Failed to load work items' });
  }
});

// GET /api/projects/:id/events — project-wide event timeline (newest first).
router.get('/:id/events', auth, validateId('id'), async (req, res) => {
  try {
    const project = await projectInOrg(req.params.id, req.user.orgId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const rows = await events.listForProject(project.id);
    res.json({ events: rows });
  } catch (err) {
    console.error('Project events error:', err);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

module.exports = router;
