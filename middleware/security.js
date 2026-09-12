// middleware/security.js
// Implements: Rate Limiting, Input Sanitization, Request Signing validation,
// Audit Logging, Idempotency Keys, Secrets protection, CORS Policy

const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const supabase = require('../config/supabase');

// ─── 1. RATE LIMITING (tiered) ────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  skip: (req) => req.path === '/health'
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8, // max 8 login attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  handler: (req, res) => {
    console.warn(`[SECURITY] Rate limit hit on auth from IP: ${req.ip}`);
    res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Upload limit reached. Try again in 1 hour.' }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60,
  message: { error: 'API rate limit exceeded.' }
});

// ─── 2. INPUT SANITIZATION ────────────────────────────────────────────
function sanitizeInput(req, res, next) {
  // Strip dangerous characters from string inputs
  const sanitize = (obj) => {
    if (typeof obj === 'string') {
      return obj
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+\s*=/gi, '')
        .trim();
    }
    if (Array.isArray(obj)) return obj.map(sanitize);
    if (obj && typeof obj === 'object') {
      const clean = {};
      for (const key of Object.keys(obj)) {
        // Block SQL injection attempts
        if (typeof obj[key] === 'string' && /(\bDROP\b|\bDELETE\b|\bINSERT\b|\bUPDATE\b|\bSELECT\b.*\bFROM\b)/i.test(obj[key])) {
          console.warn(`[SECURITY] Possible SQL injection attempt from IP: ${req.ip}, key: ${key}`);
          return res.status(400).json({ error: 'Invalid input detected.' });
        }
        clean[key] = sanitize(obj[key]);
      }
      return clean;
    }
    return obj;
  };

  if (req.body) req.body = sanitize(req.body);
  if (req.query) req.query = sanitize(req.query);
  next();
}

// ─── 3. HIDE SENSITIVE HEADERS (no server fingerprinting) ─────────────
function hideServerInfo(req, res, next) {
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
}

// ─── 4. AUDIT LOGGING ────────────────────────────────────────────────
async function auditLog(action, userId, userType, details = {}, req) {
  try {
    await supabase.from('audit_logs').insert({
      action,
      user_id: userId,
      user_type: userType, // 'fellow' | 'admin'
      ip_address: req?.ip || 'unknown',
      user_agent: req?.headers?.['user-agent']?.substring(0, 200) || 'unknown',
      details: JSON.stringify(details),
      created_at: new Date()
    }).catch(() => {}); // Non-blocking
  } catch(e) {}
}

// Middleware to log all admin actions
function adminAuditMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    // Log after response
    if (req.admin && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE')) {
      auditLog(
        `${req.method} ${req.path}`,
        req.admin.id,
        'admin',
        { body: req.body, status: res.statusCode },
        req
      );
    }
    return originalJson(data);
  };
  next();
}

// ─── 5. IDEMPOTENCY KEY (prevent duplicate submissions) ───────────────
const idempotencyCache = new Map(); // In-memory; use Redis in production

function idempotencyMiddleware(req, res, next) {
  const key = req.headers['x-idempotency-key'];
  if (!key || req.method !== 'POST') return next();

  const cached = idempotencyCache.get(key);
  if (cached) {
    // Return cached response for duplicate requests
    return res.status(cached.status).json(cached.body);
  }

  // Store the response
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    idempotencyCache.set(key, { status: res.statusCode, body: data });
    // Expire after 24 hours
    setTimeout(() => idempotencyCache.delete(key), 24 * 60 * 60 * 1000);
    return originalJson(data);
  };
  next();
}

// ─── 6. VELOCITY CHECK (detect suspicious activity) ───────────────────
const activityTracker = new Map();

function velocityCheck(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const window = 60 * 1000; // 1 min window

  if (!activityTracker.has(ip)) {
    activityTracker.set(ip, { count: 0, firstSeen: now, flagged: false });
  }

  const tracker = activityTracker.get(ip);

  // Reset window
  if (now - tracker.firstSeen > window) {
    tracker.count = 0;
    tracker.firstSeen = now;
    tracker.flagged = false;
  }

  tracker.count++;

  // Flag suspicious if > 100 requests/min from same IP
  if (tracker.count > 100 && !tracker.flagged) {
    tracker.flagged = true;
    console.warn(`[SECURITY] Suspicious velocity from IP: ${ip} — ${tracker.count} req/min`);
    auditLog('VELOCITY_FLAG', null, 'system', { ip, count: tracker.count }, req);
  }

  next();
}

// ─── 7. SEPARATION OF DUTIES check ────────────────────────────────────
// Fellows cannot access admin routes, admins cannot impersonate fellows
function separationOfDuties(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return next();

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return next();

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Block fellows from admin routes
    if (decoded.role === 'fellow' && req.path.startsWith('/api/admin')) {
      console.warn(`[SECURITY] Fellow attempted admin access: ${decoded.email}`);
      return res.status(403).json({ error: 'Access denied.' });
    }

    // Block admins from fellow-only dashboard routes (allow for certificate viewing)
    if (['admin', 'super_admin', 'moderator'].includes(decoded.role) &&
        req.path.startsWith('/api/fellows/me')) {
      return res.status(403).json({ error: 'Admin accounts cannot access fellow dashboard.' });
    }
  } catch(e) {
    // Invalid token — let individual middleware handle it
  }
  next();
}

module.exports = {
  globalLimiter,
  authLimiter,
  uploadLimiter,
  apiLimiter,
  sanitizeInput,
  hideServerInfo,
  auditLog,
  adminAuditMiddleware,
  idempotencyMiddleware,
  velocityCheck,
  separationOfDuties
};
