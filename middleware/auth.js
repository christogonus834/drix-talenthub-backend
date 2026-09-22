const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');

// Short-lived cache so suspending a fellow / deactivating an admin takes effect within seconds
// without a DB round-trip on every single request.
const CACHE_MS = 30 * 1000;
const cache = new Map(); // key -> { ok, exp }

function invalidateUser(id) { cache.delete(`fellow:${id}`); cache.delete(`admin:${id}`); }

async function stillValid(kind, id) {
  const key = `${kind}:${id}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.ok;

  let ok = false;
  try {
    if (kind === 'fellow') {
      const { data } = await supabase.from('fellows').select('status').eq('id', id).single();
      ok = data?.status === 'approved';
    } else {
      const { data } = await supabase.from('admins').select('is_active').eq('id', id).single();
      ok = data?.is_active === true;
    }
  } catch (e) { ok = false; }

  cache.set(key, { ok, exp: Date.now() + CACHE_MS });
  if (cache.size > 5000) { for (const [k, v] of cache) if (v.exp < Date.now()) cache.delete(k); }
  return ok;
}

function readToken(req) {
  const h = req.headers['authorization'];
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Fellow auth middleware
const authMiddleware = async (req, res, next) => {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'fellow') return res.status(403).json({ error: 'Access denied.' });

    if (!(await stillValid('fellow', decoded.id))) {
      return res.status(401).json({ error: 'Your session is no longer valid. Please login again.' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please login again.' });
  }
};

// Admin auth middleware
const adminMiddleware = async (req, res, next) => {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!['admin', 'super_admin', 'moderator'].includes(decoded.role)) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    if (!(await stillValid('admin', decoded.id))) {
      return res.status(401).json({ error: 'Your session is no longer valid. Please login again.' });
    }
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please login again.' });
  }
};

// Role gate: requireRole('admin', 'super_admin') — moderators are blocked from sensitive actions.
const requireRole = (...roles) => (req, res, next) => {
  if (!req.admin || !roles.includes(req.admin.role)) {
    return res.status(403).json({ error: 'You do not have permission to do this.' });
  }
  next();
};

module.exports = { authMiddleware, adminMiddleware, requireRole, invalidateUser };
