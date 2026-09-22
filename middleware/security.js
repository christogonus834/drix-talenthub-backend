// middleware/security.js — wired into server.js.
//
// NOTE: the old regex "sanitizeInput" was removed on purpose. It rejected any text containing the words
// SELECT…FROM / DELETE / UPDATE / INSERT / DROP (i.e. every SQL lesson, exam question and message about
// databases) and silently rewrote other input. Supabase queries are parameterised, so SQL injection is not
// handled by keyword blocking; XSS is handled by escaping on output (esc() in the frontend, esc() in emails).

const rateLimit = require('express-rate-limit');
const supabase = require('../config/supabase');

const json429 = msg => ({ error: msg });

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false,
  message: json429('Too many requests. Please slow down.'),
  skip: req => req.path === '/health',
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: json429('Too many login attempts. Try again in 15 minutes.'),
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
  message: json429('Too many registration attempts. Try again later.'),
});
const publicWriteLimiter = rateLimit({          // contact form, payment verify, unsubscribe
  windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: json429('Too many requests. Try again later.'),
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: json429('Upload limit reached. Try again in 1 hour.'),
});
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: json429('AI assistant limit reached. Try again later.'),
});

function hideServerInfo(req, res, next) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
}

// ─── AUDIT LOG ───────────────────────────────────────────────────────
const SENSITIVE = /(pass|secret|token|key|hash|photo|base64)/i;
function redact(v, depth = 0) {
  if (v === null || typeof v !== 'object' || depth > 3) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map(x => redact(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : (typeof v[k] === 'string' && v[k].length > 300 ? v[k].slice(0, 300) + '…' : redact(v[k], depth + 1));
  }
  return out;
}

async function auditLog(action, userId, userType, details = {}, req) {
  try {
    await supabase.from('audit_logs').insert({
      action, user_id: userId, user_type: userType,
      ip_address: req?.ip || 'unknown',
      user_agent: req?.headers?.['user-agent']?.substring(0, 200) || 'unknown',
      details: JSON.stringify(redact(details)),
    });
  } catch (e) { /* never block the request */ }
}

// Logs every admin write (POST/PATCH/PUT/DELETE) once the response is sent, with secrets redacted.
function adminAuditMiddleware(req, res, next) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  res.on('finish', () => {
    if (req.admin) {
      auditLog(`${req.method} ${req.originalUrl.split('?')[0]}`, req.admin.id, 'admin', { body: req.body, status: res.statusCode }, req);
    }
  });
  next();
}

// Bounded, TTL-based idempotency for POSTs that send X-Idempotency-Key
const idem = new Map();
function idempotencyMiddleware(req, res, next) {
  const key = req.headers['x-idempotency-key'];
  if (!key || req.method !== 'POST') return next();
  const hit = idem.get(key);
  if (hit && hit.exp > Date.now()) return res.status(hit.status).json(hit.body);
  const orig = res.json.bind(res);
  res.json = body => {
    if (idem.size > 2000) { for (const [k, v] of idem) if (v.exp < Date.now()) idem.delete(k); }
    idem.set(key, { status: res.statusCode, body, exp: Date.now() + 10 * 60 * 1000 });
    return orig(body);
  };
  next();
}

module.exports = {
  globalLimiter, authLimiter, registerLimiter, publicWriteLimiter, uploadLimiter, aiLimiter,
  hideServerInfo, auditLog, adminAuditMiddleware, idempotencyMiddleware,
};
