require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();

// ─── SECURITY ─────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: true, credentials: true }));

// ─── RATE LIMITING ────────────────────────────────────────────────────
const globalLimiter = rateLimit({ windowMs: 15*60*1000, max: 300, message: { error: 'Too many requests.' } });
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });
const uploadLimiter = rateLimit({ windowMs: 60*60*1000, max: 30, message: { error: 'Upload limit reached.' } });

app.use(globalLimiter);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// ─── AUTH RATE LIMIT ──────────────────────────────────────────────────
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/admin/login', authLimiter);

// ─── API ROUTES ──────────────────────────────────────────────────────
app.use('/api/auth',               require('./routes/auth'));
app.use('/api/fellows',            require('./routes/fellows'));
app.use('/api/admin',              require('./routes/admin'));
app.use('/api/payments',           require('./routes/payments'));
app.use('/api/certificates',       require('./routes/certificates'));
app.use('/api/admin/certificates', require('./routes/certificates'));
app.use('/api/modules',            require('./routes/modules'));
app.use('/api/messages',           require('./routes/messages'));
app.use('/api/upload',             uploadLimiter, require('./routes/upload'));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', timestamp: new Date() }));

// ─── DEBUG (remove after confirming JWT works) ────────────────────────
app.get('/api/debug/env', (req, res) => res.json({
  jwt_set: !!process.env.JWT_SECRET,
  jwt_length: process.env.JWT_SECRET?.length,
  supabase_set: !!process.env.SUPABASE_URL,
  node_env: process.env.NODE_ENV
}));

// ─── 404 + ERROR ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found.' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error.' }); });

// ─── START ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Drix Tech Talent API v2.0 — port ${PORT}`);
  console.log(`   JWT loaded: ${!!process.env.JWT_SECRET}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL?.slice(0,40)}\n`);
});
