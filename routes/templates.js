const express = require('express');
const pool = require('../config/db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// GET /api/templates?method=&kind= — template-driven form/layout definitions.
// Any authenticated role may read templates (they drive the UI for everyone).
router.get('/', auth, async (req, res) => {
  const { method, kind } = req.query;
  const clauses = [];
  const params = [];
  if (method) {
    params.push(method);
    clauses.push(`method = $${params.length}`);
  }
  if (kind) {
    params.push(kind);
    clauses.push(`kind = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  try {
    const result = await pool.query(
      `SELECT method, kind, definition FROM template ${where} ORDER BY method, kind`,
      params
    );
    res.json({ templates: result.rows });
  } catch (err) {
    console.error('List templates error:', err);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

module.exports = router;
