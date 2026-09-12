require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const app = express();

// ─── SECURITY ─────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false, contentSecurityPolicy: false }));
app.disable('x-powered-by');
app.use(cors({ origin: true, credentials: true }));

// ─── RATE LIMITING ─────────────────────────────────────────────────────
const globalLimit  = rateLimit({ windowMs: 15*60*1000, max: 300, message: { error: 'Too many requests.' } });
const authLimit    = rateLimit({ windowMs: 15*60*1000, max: 8,   message: { error: 'Too many login attempts. Try again in 15 minutes.' } });
const uploadLimit  = rateLimit({ windowMs: 60*60*1000, max: 20,  message: { error: 'Upload limit reached.' } });

app.use(globalLimit);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// ─── AUTH RATE LIMIT ───────────────────────────────────────────────────
app.use('/api/auth/login',       authLimit);
app.use('/api/auth/admin/login', authLimit);

// ─── ROUTES (order matters) ────────────────────────────────────────────
app.use('/api/auth',               require('./routes/auth'));
app.use('/api/fellows',            require('./routes/fellows'));
app.use('/api/admin',              require('./routes/admin'));
app.use('/api/payments',           require('./routes/payments'));
app.use('/api/certificates',       require('./routes/certificates'));
app.use('/api/admin/certificates', require('./routes/certificates'));
app.use('/api/modules',            require('./routes/modules'));
app.use('/api/messages',           require('./routes/messages'));
app.use('/api/upload',             uploadLimit, require('./routes/upload'));

// ─── HEALTH ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.1.0' }));

// ─── 404 ───────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// ─── ERROR ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ─── START ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n Drix Tech Talent API v2.1 — port ${PORT}`);
  console.log(`   JWT: ${!!process.env.JWT_SECRET}`);
  console.log(`   Supabase: ${!!process.env.SUPABASE_URL}\n`);
});
