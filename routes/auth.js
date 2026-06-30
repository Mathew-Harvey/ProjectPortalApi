const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { auth, signToken, getCookieOptions, getClearCookieOptions } = require('../middleware/auth');

const router = express.Router();

const ROLES = ['admin_pm', 'engineer', 'field', 'client'];

function validatePassword(password) {
  if (!password || password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}

function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name, role: row.role, orgId: row.org_id };
}

// POST /api/auth/register — self-registration. New users attach to the single
// seeded organisation and pick a role from the enum (no tenant management).
router.post('/register', async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || !name || !role) {
    return res.status(400).json({ error: 'email, password, name and role are required' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters with one uppercase letter and one number' });
  }
  const cleanEmail = String(email).toLowerCase().trim();

  try {
    const org = await pool.query('SELECT id FROM organisation ORDER BY created_at ASC LIMIT 1');
    if (org.rows.length === 0) {
      return res.status(400).json({ error: 'No organisation is configured yet' });
    }
    const orgId = org.rows[0].id;

    const existing = await pool.query('SELECT id FROM app_user WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO app_user (org_id, email, name, role, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, role, org_id`,
      [orgId, cleanEmail, String(name).trim(), role, passwordHash]
    );

    const user = result.rows[0];
    const token = signToken({ id: user.id, email: user.email, org_id: user.org_id, role: user.role });
    res.cookie('token', token, getCookieOptions());
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const cleanEmail = String(email).toLowerCase().trim();

  try {
    const result = await pool.query(
      'SELECT id, email, name, role, org_id, password_hash, is_active FROM app_user WHERE email = $1',
      [cleanEmail]
    );
    const row = result.rows[0];
    if (!row || row.is_active === false) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({ id: row.id, email: row.email, org_id: row.org_id, role: row.role });
    res.cookie('token', token, getCookieOptions());
    res.json({ user: publicUser(row) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token', getClearCookieOptions());
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const org = await pool.query('SELECT id, name FROM organisation WHERE id = $1', [req.user.orgId]);
    res.json({
      user: req.user,
      organisation: org.rows[0] || null,
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

module.exports = router;
