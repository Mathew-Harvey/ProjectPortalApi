const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JWT_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

function getCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: JWT_LIFETIME_SECONDS * 1000,
    path: '/api',
  };
}

function getClearCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return { path: '/api', sameSite: isProd ? 'none' : 'lax', secure: isProd };
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, orgId: user.org_id || user.orgId, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: `${JWT_LIFETIME_SECONDS}s` }
  );
}

// Invite token: emailed to a person who is "sent a step". It authorises them to
// view that one work item and to claim an account with the step's role. Signed
// with JWT_SECRET; typ:'invite' keeps it distinct from session tokens.
const INVITE_LIFETIME = '14d';
function signInviteToken({ email, role, workItemId }) {
  return jwt.sign(
    { typ: 'invite', email: String(email).toLowerCase(), role, workItemId },
    process.env.JWT_SECRET,
    { expiresIn: INVITE_LIFETIME }
  );
}
function verifyInviteToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.typ !== 'invite' || !decoded.email || !decoded.workItemId) return null;
    return decoded;
  } catch {
    return null;
  }
}

// Verify the JWT cookie, then re-read the user from the DB every request so role
// changes / deactivation take effect without re-login (mirrors AppHub).
function auth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ error: 'session_expired', message: 'Please sign in again.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    res.clearCookie('token', getClearCookieOptions());
    return res.status(401).json({ error: 'session_expired', message: 'Please sign in again.' });
  }

  pool
    .query(
      'SELECT id, email, name, role, org_id, is_active FROM app_user WHERE id = $1',
      [decoded.id]
    )
    .then((result) => {
      const row = result.rows[0];
      if (!row || row.is_active === false) {
        res.clearCookie('token', getClearCookieOptions());
        return res.status(401).json({ error: 'session_expired', message: 'Please sign in again.' });
      }
      req.user = {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        orgId: row.org_id,
      };
      next();
    })
    .catch((err) => {
      console.error('Auth lookup error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    });
}

// Role enum gate (no permissions matrix). Usage: requireRole('admin_pm', 'engineer').
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', message: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

// Guard :id-style UUID params before they hit the DB.
function validateId(param = 'id') {
  return (req, res, next) => {
    const id = req.params[param];
    if (id && !UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }
    next();
  };
}

module.exports = {
  auth,
  requireRole,
  validateId,
  signToken,
  signInviteToken,
  verifyInviteToken,
  getCookieOptions,
  getClearCookieOptions,
  UUID_REGEX,
};
