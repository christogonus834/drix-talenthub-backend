const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');

// ─── FELLOW REGISTER ───────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const {
      full_name, email, phone, state, gender, date_of_birth,
      epayybillz_user_id, password, track_id, cohort_id,
      profile_photo, payment_reference, payment_provider,
    } = req.body;

    if (!full_name || !email || !password || !epayybillz_user_id || !track_id) {
      return res.status(400).json({ error: 'All required fields must be filled.' });
    }

    // Check if email exists
    const { data: existing } = await supabase
      .from('fellows').select('id').eq('email', email).single();
    if (existing) return res.status(400).json({ error: 'Email already registered.' });

    // Check registration open
    const { data: regSetting } = await supabase
      .from('settings').select('value').eq('key', 'registration_open').single();
    if (regSetting?.value === 'false') {
      return res.status(403).json({ error: 'Registration is currently closed.' });
    }

    // Get active cohort
    let activeCohortId = cohort_id;
    if (!activeCohortId) {
      const { data: cohort } = await supabase
        .from('cohorts').select('id').eq('is_active', true).single();
      activeCohortId = cohort?.id;
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { data: fellow, error } = await supabase
      .from('fellows')
      .insert({
        full_name, email, phone, state, gender, date_of_birth,
        epayybillz_user_id, password_hash, track_id,
        cohort_id: activeCohortId,
        profile_photo: profile_photo || null,
        payment_reference: payment_reference || null,
        payment_provider: payment_provider || null,
        status: 'pending'
      })
      .select().single();

    if (error) throw error;

    await supabase.from('notifications').insert({
      fellow_id: fellow.id,
      title: '🎉 Registration Successful!',
      message: 'Your registration is under review. You will be notified once approved.',
      type: 'info'
    }).catch(() => {});

    res.status(201).json({ success: true, message: 'Registration successful! Awaiting admin approval.' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─── FELLOW LOGIN ───────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const { data: fellow, error } = await supabase
      .from('fellows').select('*, tracks(name, slug)').eq('email', email).single();

    if (error || !fellow) return res.status(401).json({ error: 'Invalid email or password.' });

    // Check password FIRST
    const valid = await bcrypt.compare(password, fellow.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });

    // Then check status
    if (fellow.status === 'pending')   return res.status(403).json({ error: 'Your account is pending admin approval.' });
    if (fellow.status === 'rejected')  return res.status(403).json({ error: 'Your application was not approved. Contact admin.' });
    if (fellow.status === 'suspended') return res.status(403).json({ error: 'Your account has been suspended. Contact admin.' });

    // Generate token — returned in response body (no cookie needed)
    const token = jwt.sign(
      { id: fellow.id, email: fellow.email, role: 'fellow', name: fellow.full_name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ success: true, token, redirect: '/dashboard' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─── ADMIN LOGIN ────────────────────────────────────────────────────
router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const { data: admin, error } = await supabase
      .from('admins').select('*').eq('email', email).eq('is_active', true).single();

    if (error || !admin) return res.status(401).json({ error: 'Invalid credentials.' });

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });

    await supabase.from('admins').update({ last_login: new Date() }).eq('id', admin.id);

    // Generate token — returned in response body (no cookie needed)
    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role, name: admin.full_name },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.json({ success: true, token, redirect: '/admin/dashboard' });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─── LOGOUT ─────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.json({ success: true });
});

module.exports = router;
