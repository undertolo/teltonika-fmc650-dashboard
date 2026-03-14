// auth.js - JWT authentication middleware and helpers
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const JWT_EXPIRES_IN = '8h';

// Verify credentials and return a signed JWT
async function login(username, password) {
  const [rows] = await pool.query(
    'SELECT id, username, password_hash, role, name FROM users WHERE username = ?',
    [username]
  );

  if (rows.length === 0) throw new Error('Invalid credentials');

  const user = rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new Error('Invalid credentials');

  const payload = { id: user.id, username: user.username, role: user.role, name: user.name };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  return { token, user: payload };
}

// Middleware: require a valid JWT
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

// Middleware: require one of the given roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  };
}

module.exports = { login, requireAuth, requireRole };
