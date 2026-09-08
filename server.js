require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');

const app = express();

// ─── CORS — open to all origins (JWT in header, not cookie) ──────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ─── API ROUTES ──────────────────────────────────────────────────────
app.use('/api/auth',               require('./routes/auth'));
app.use('/api/fellows',            require('./routes/fellows'));
app.use('/api/admin',              require('./routes/admin'));
app.use('/api/payments',           require('./routes/payments'));
app.use('/api/certificates',       require('./routes/certificates'));
app.use('/api/admin/certificates', require('./routes/certificates'));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ─── 404 ──────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ─── START ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Drix Tech Talent API running on port ${PORT}\n`);
});
