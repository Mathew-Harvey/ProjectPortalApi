const express = require('express');
const pool = require('../config/db');

const router = express.Router();

// GET /api/templates?method=&kind= — template-driven form/layout definitions.
// Public: templates are generic seed/config (no tenant data), and invited guests
// previewing a work item need them to render the RDS/QA forms before they have
// an account.
router.get('/', async (req, res) => {
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
