const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { auth, signToken, getCookieOptions, getClearCookieOptions, verifyInviteToken } = require('../middleware/auth');

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

// Derive a display name from an email local-part: "dee.diver@x" -> "Dee Diver".
function nameFromEmail(email) {
  const local = String(email).split('@')[0] || '';
  const parts = local.split(/[._+-]+/).filter(Boolean);
  if (parts.length === 0) return email;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

// POST /api/auth/claim-invite — complete an emailed step invite.
// If the email already has an account, this is a sign-in (verify password).
// Otherwise it creates an account with the invite's role and signs in.
router.post('/claim-invite', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) {
    return res.status(400).json({ error: 'token and password are required' });
  }
  const decoded = verifyInviteToken(token);
  if (!decoded || !ROLES.includes(decoded.role)) {
    return res.status(400).json({ error: 'invalid_invite', message: 'This invite link is invalid or has expired.' });
  }
  const email = String(decoded.email).toLowerCase().trim();

  try {
    const existing = await pool.query(
      'SELECT id, email, name, role, org_id, password_hash, is_active FROM app_user WHERE email = $1',
      [email]
    );

    // Existing account -> sign in (verify password).
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.is_active === false) {
        return res.status(401).json({ error: 'account_inactive', message: 'This account is no longer active.' });
      }
      const ok = await bcrypt.compare(password, row.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'invalid_password', message: 'Incorrect password.', exists: true });
      }
      const t = signToken({ id: row.id, email: row.email, org_id: row.org_id, role: row.role });
      res.cookie('token', t, getCookieOptions());
      return res.json({ user: publicUser(row), created: false });
    }

    // New account -> create with the invite's role, attached to the work item's org.
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters with one uppercase letter and one number' });
    }
    const wi = await pool.query('SELECT org_id FROM work_item WHERE id = $1', [decoded.workItemId]);
    if (wi.rows.length === 0) {
      return res.status(400).json({ error: 'invalid_invite', message: 'The work item for this invite no longer exists.' });
    }
    const orgId = wi.rows[0].org_id;
    const passwordHash = await bcrypt.hash(password, 12);
    const inserted = await pool.query(
      `INSERT INTO app_user (org_id, email, name, role, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role, org_id`,
      [orgId, email, nameFromEmail(email), decoded.role, passwordHash]
    );
    const user = inserted.rows[0];
    const t = signToken({ id: user.id, email: user.email, org_id: user.org_id, role: user.role });
    res.cookie('token', t, getCookieOptions());
    res.status(201).json({ user: publicUser(user), created: true });
  } catch (err) {
    console.error('Claim invite error:', err);
    res.status(500).json({ error: 'Failed to complete invite' });
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
