const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { auth, requireRole, validateId } = require('../middleware/auth');

const router = express.Router();

const ROLES = ['admin_pm', 'engineer', 'field', 'client'];

function validatePassword(password) {
  return !!password && password.length >= 8 && /[A-Z]/.test(password) && /[0-9]/.test(password);
}
function publicUser(row) {
  return {
    id: row.id, email: row.email, name: row.name, role: row.role,
    isActive: row.is_active, createdAt: row.created_at,
  };
}

// Count active admin_pm users in an org (used to protect the last admin).
async function activeAdminCount(orgId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM app_user WHERE org_id = $1 AND role = 'admin_pm' AND is_active = true`,
    [orgId]
  );
  return r.rows[0].n;
}

// All routes require a PM/Integrator (the app's admin role).
// GET /api/users — list everyone in the caller's organisation.
router.get('/', auth, requireRole('admin_pm'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, role, is_active, created_at
       FROM app_user WHERE org_id = $1 ORDER BY role, name`,
      [req.user.orgId]
    );
    res.json({ users: result.rows.map(publicUser) });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// POST /api/users — create a user directly.
router.post('/', auth, requireRole('admin_pm'), async (req, res) => {
  const { email, name, role, password } = req.body || {};
  if (!email || !name || !role || !password) {
    return res.status(400).json({ error: 'email, name, role and password are required' });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters with one uppercase letter and one number' });
  }
  const cleanEmail = String(email).toLowerCase().trim();
  try {
    const existing = await pool.query('SELECT id FROM app_user WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'An account with this email already exists' });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO app_user (org_id, email, name, role, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role, is_active, created_at`,
      [req.user.orgId, cleanEmail, String(name).trim(), role, hash]
    );
    res.status(201).json({ user: publicUser(result.rows[0]) });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PUT /api/users/:id — update name / role / active / password.
router.put('/:id', auth, requireRole('admin_pm'), validateId('id'), async (req, res) => {
  const { name, role, isActive, password } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  }
  if (password !== undefined && !validatePassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters with one uppercase letter and one number' });
  }
  try {
    const target = await pool.query(
      'SELECT id, email, name, role, is_active, org_id FROM app_user WHERE id = $1 AND org_id = $2',
      [req.params.id, req.user.orgId]
    );
    if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const t = target.rows[0];

    const demoting = role !== undefined && t.role === 'admin_pm' && role !== 'admin_pm';
    const deactivating = isActive === false && t.is_active === true;

    // Never lock the org out: keep at least one active admin_pm.
    if ((demoting || deactivating) && t.role === 'admin_pm') {
      if ((await activeAdminCount(req.user.orgId)) <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last active PM / Integrator' });
      }
    }
    // Don't let an admin deactivate themselves (avoids self-lockout surprises).
    if (deactivating && t.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }

    const sets = [];
    const params = [];
    const push = (frag, val) => { params.push(val); sets.push(`${frag} = $${params.length}`); };
    if (name !== undefined) push('name', String(name).trim());
    if (role !== undefined) push('role', role);
    if (isActive !== undefined) push('is_active', !!isActive);
    if (password !== undefined) push('password_hash', await bcrypt.hash(password, 12));
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    params.push(req.user.orgId);
    const result = await pool.query(
      `UPDATE app_user SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length - 1} AND org_id = $${params.length}
       RETURNING id, email, name, role, is_active, created_at`,
      params
    );
    res.json({ user: publicUser(result.rows[0]) });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

module.exports = router;
