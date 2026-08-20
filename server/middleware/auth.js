const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { runWithUser } = require('../utils/logger');

// Throttled last_active_at writer — authenticateToken runs on every authenticated request
// (progress autosave, polling, etc.), far too often to write on every hit. Cache the last
// write time per user in memory and only touch the DB once per ACTIVE_WRITE_THROTTLE_MS;
// that's plenty of granularity for the admin panel's "last active" display (server/routes/
// auth.js's GET /admin/users). Reset on restart — harmless, just means one extra write.
const ACTIVE_WRITE_THROTTLE_MS = 2 * 60 * 1000;
const _lastActiveWriteCache = new Map(); // userId → ms timestamp of last DB write

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (req.query?.token || req.query?._token || null);

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Verify the user still exists in the database (guards against stale tokens
    // after a database reset or user deletion)
    const user = getDb().prepare('SELECT id, username, name FROM users WHERE id = ?').get(payload.id);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = payload;
    req.user.username = user.username; // expose for handlers + logging

    const nowMs = Date.now();
    const lastWrite = _lastActiveWriteCache.get(user.id) || 0;
    if (nowMs - lastWrite > ACTIVE_WRITE_THROTTLE_MS) {
      _lastActiveWriteCache.set(user.id, nowMs);
      try {
        getDb().prepare('UPDATE users SET last_active_at = ? WHERE id = ?')
          .run(Math.floor(nowMs / 1000), user.id);
      } catch { /* best-effort — never block a request over this */ }
    }

    // Run the rest of the request within the user's logging context so every
    // console line emitted while handling it is tagged with this username.
    return runWithUser(user.username, () => next());
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticateToken };
