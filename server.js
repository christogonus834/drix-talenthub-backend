require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const sec = require('./middleware/security');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) {
  console.warn('[SECURITY] JWT_SECRET is missing or shorter than 24 characters. Set a long random value.');
}

const app = express();
app.set('trust proxy', 1); // behind a reverse proxy: rate limits must key on the real client IP

app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.disable('x-powered-by');
app.use(sec.hideServerInfo);

// CORS — only the configured frontend(s) (comma-separated FRONTEND_URL) plus localhost for development.
const allowed = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
if (!allowed.length) console.warn('[SECURITY] FRONTEND_URL is not set — CORS is open to any origin.');
app.use(cors({
  origin(origin, cb) {
    if (!origin || !allowed.length) return cb(null, true);                       // curl / server-to-server / unconfigured
    if (allowed.includes(origin.replace(/\/$/, ''))) return cb(null, true);
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    return cb(null, false);
  },
}));

app.use(sec.globalLimiter);
// JSON bodies are small now. Profile photos (base64) are the largest legitimate payload.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(sec.idempotencyMiddleware);
app.use('/api/admin', sec.adminAuditMiddleware);

// ── Rate limits on sensitive endpoints ────────────────────────────────
app.use('/api/auth/login',       sec.authLimiter);
app.use('/api/auth/admin/login', sec.authLimiter);
app.use('/api/auth/mentor/login', sec.authLimiter);
app.use('/api/auth/register',    sec.registerLimiter);
app.use('/api/payments/verify',  sec.publicWriteLimiter);
app.use('/api/messages/contact', sec.publicWriteLimiter);
app.use('/api/fellows/unsubscribe', sec.publicWriteLimiter);

// ── ROUTES ────────────────────────────────────────────────────────────
app.use('/api/auth',               require('./routes/auth'));
app.use('/api/fellows',            require('./routes/fellows'));
app.use('/api/admin',              require('./routes/admin'));
app.use('/api/mentor',             require('./routes/mentor'));
app.use('/api/portfolio',          require('./routes/portfolio-public'));
app.use('/api/payments',           require('./routes/payments'));
app.use('/api/certificates',       require('./routes/certificates'));
app.use('/api/admin/certificates', require('./routes/certificates'));
app.use('/api/modules',            require('./routes/modules'));
app.use('/api/messages',           require('./routes/messages'));
app.use('/api/blog',               require('./routes/blog'));
app.use('/api/announcements',      require('./routes/announcements'));
app.use('/api/ai',                 sec.aiLimiter, require('./routes/ai'));
app.use('/api/upload',             sec.uploadLimiter, require('./routes/upload'));

app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.3.0' }));
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => { console.error(err.message); res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'Something went wrong.' }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n Drix Tech Talent API v2.3 — port ${PORT}`);
  console.log(`   JWT: ${!!process.env.JWT_SECRET}`);
  console.log(`   Supabase: ${!!process.env.SUPABASE_URL}`);
  console.log(`   Brevo email: ${!!process.env.BREVO_API_KEY}`);
  console.log(`   AI assistant: ${!!process.env.GEMINI_API_KEY}\n`);
});
