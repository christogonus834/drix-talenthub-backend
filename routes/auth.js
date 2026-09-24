const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const supabase = require('../config/supabase');
const { getSettings, cleanText, isUuid, safe } = require('../services/util');
const { verifyRegistrationPayment } = require('../services/payments');
const { sendToFellow, sendEmail, templates } = require('../services/email');
const { invalidateUser } = require('../middleware/auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Used to keep response time constant when the email doesn't exist (prevents account enumeration by timing)
const DUMMY_HASH = bcrypt.hashSync('drix-dummy-password', 12);

// ─── FELLOW REGISTER ───────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const b = req.body || {};
    const full_name = cleanText(b.full_name, 120);
    const email = String(b.email || '').trim().toLowerCase();
    const { password, track_id, cohort_id } = b;
    const epayybillz_user_id = cleanText(b.epayybillz_user_id, 80);

    if (!full_name || !email || !password || !epayybillz_user_id || !track_id) {
      return res.status(400).json({ error: 'All required fields must be filled.' });
    }
    if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 100) {
      return res.status(400).json({ error: 'Password must be between 8 and 100 characters.' });
    }
    if (!isUuid(track_id)) return res.status(400).json({ error: 'Invalid track.' });

    const settings = await getSettings();
    if (settings.registration_open === 'false') {
      return res.status(403).json({ error: 'Registration is currently closed.' });
    }

    const { data: track } = await supabase.from('tracks').select('id').eq('id', track_id).eq('is_active', true).maybeSingle();
    if (!track) return res.status(400).json({ error: 'Selected track is not available.' });

    const { data: existing } = await supabase.from('fellows').select('id').eq('email', email).limit(1);
    if (existing && existing.length) return res.status(400).json({ error: 'Email already registered.' });

    // ── Payment: enforced server-side when enabled ─────────────────
    let paymentVerified = false;
    let payRef = null, payProvider = null;
    const fee = parseFloat(settings.registration_fee || '0');
    if (settings.payment_enabled === 'true' && fee > 0) {
      payRef = String(b.payment_reference || '');
      payProvider = String(b.payment_provider || '');
      if (!payRef || !payProvider) return res.status(402).json({ error: 'Payment is required to complete registration.' });

      const { data: used } = await supabase.from('fellows').select('id').eq('payment_reference', payRef).limit(1);
      if (used && used.length) return res.status(400).json({ error: 'This payment has already been used.' });

      const v = await verifyRegistrationPayment({ provider: payProvider, reference: payRef });
      if (!v.ok) return res.status(402).json({ error: v.error || 'Payment verification failed.' });
      paymentVerified = true;
    }

    let activeCohortId = isUuid(cohort_id) ? cohort_id : null;
    if (!activeCohortId) {
      const { data: cohort } = await supabase.from('cohorts').select('id').eq('is_active', true).limit(1);
      activeCohortId = cohort?.[0]?.id || null;
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { data: fellow, error } = await supabase
      .from('fellows')
      .insert({
        full_name, email,
        phone: cleanText(b.phone, 40) || null,
        state: cleanText(b.state, 60) || null,
        gender: cleanText(b.gender, 20) || null,
        date_of_birth: b.date_of_birth || null,
        epayybillz_user_id, password_hash, track_id,
        cohort_id: activeCohortId,
        profile_photo: typeof b.profile_photo === 'string' && b.profile_photo.startsWith('data:image/') ? b.profile_photo : null,
        payment_reference: payRef, payment_provider: payProvider, payment_verified: paymentVerified,
        status: 'pending',
      })
      .select('id, full_name, email').single();

    if (error) {
      if (String(error.code) === '23505') return res.status(400).json({ error: 'Email or payment already registered.' });
      throw error;
    }

    if (paymentVerified) {
      await safe(supabase.from('payments').upsert({ reference: payRef, provider: payProvider, email, status: 'success', paid_at: new Date().toISOString(), fellow_id: fellow.id }, { onConflict: 'reference' }), 'payments');
    }

    await safe(supabase.from('notifications').insert({
      fellow_id: fellow.id, title: '🎉 Registration Successful!',
      message: 'Your registration is under review. You will be notified once approved.', type: 'info',
    }), 'notif');

    // Email: fire-and-forget — must never affect the response
    sendToFellow('application_received', { ...fellow, email_notifications: true }).catch(() => {});

    res.status(201).json({ success: true, message: 'Registration successful! Awaiting admin approval.' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─── FELLOW LOGIN ───────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;
    if (!email || !password || typeof password !== 'string') return res.status(400).json({ error: 'Email and password required.' });

    let { data: fellow } = await supabase.from('fellows').select('*, tracks(name, slug)').eq('email', email).maybeSingle();
    if (!fellow) {
      // legacy accounts registered before emails were lower-cased
      const typed = String(req.body.email).trim();
      if (typed !== email) ({ data: fellow } = await supabase.from('fellows').select('*, tracks(name, slug)').eq('email', typed).maybeSingle());
    }

    const valid = await bcrypt.compare(password, fellow?.password_hash || DUMMY_HASH);
    if (!fellow || !valid) return res.status(401).json({ error: 'Invalid email or password.' });

    if (fellow.status === 'pending')   return res.status(403).json({ error: 'Your account is pending admin approval.' });
    if (fellow.status === 'rejected')  return res.status(403).json({ error: 'Your application was not approved. Contact admin.' });
    if (fellow.status === 'suspended') return res.status(403).json({ error: 'Your account has been suspended. Contact admin.' });

    const token = jwt.sign(
      { id: fellow.id, email: fellow.email, role: 'fellow', name: fellow.full_name },
      process.env.JWT_SECRET, { expiresIn: '7d' }
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
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;
    if (!email || !password || typeof password !== 'string') return res.status(400).json({ error: 'Email and password required.' });

    const { data: admin } = await supabase.from('admins').select('*').eq('email', email).eq('is_active', true).maybeSingle();
    const valid = await bcrypt.compare(password, admin?.password_hash || DUMMY_HASH);
    if (!admin || !valid) return res.status(401).json({ error: 'Invalid credentials.' });

    await safe(supabase.from('admins').update({ last_login: new Date() }).eq('id', admin.id), 'last_login');

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role, name: admin.full_name },
      process.env.JWT_SECRET, { expiresIn: '1d' }
    );
    res.json({ success: true, token, redirect: '/admin/dashboard' });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─── MENTOR LOGIN ───────────────────────────────────────────────────
router.post('/mentor/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;
    if (!email || !password || typeof password !== 'string') return res.status(400).json({ error: 'Email and password required.' });

    const { data: mentor } = await supabase.from('mentors').select('*').eq('email', email).eq('is_active', true).maybeSingle();
    const valid = await bcrypt.compare(password, mentor?.password_hash || DUMMY_HASH);
    if (!mentor || !valid) return res.status(401).json({ error: 'Invalid credentials.' });

    await safe(supabase.from('mentors').update({ last_login: new Date() }).eq('id', mentor.id), 'last_login');

    const token = jwt.sign(
      { id: mentor.id, email: mentor.email, role: 'mentor', name: mentor.full_name },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ success: true, token, redirect: '/mentor/dashboard' });
  } catch (err) {
    console.error('Mentor login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─── FORGOT / RESET PASSWORD (fellow, admin, mentor) — OTP-based ────
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_OTP_ATTEMPTS = 5;
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const GENERIC_FORGOT_RESPONSE = { success: true, message: 'If an account exists with that email, a code has been sent.' };

const RESET_AUDIENCES = {
  fellow: { table: 'fellows', loginPath: '/login' },
  admin:  { table: 'admins',  loginPath: '/admin/login' },
  mentor: { table: 'mentors', loginPath: '/mentor/login' },
};

function genOtp() { return String(crypto.randomInt(100000, 1000000)); } // 6 digits, zero-safe range

// Looks up the OTP row for (email, audience) and validates it against `otp`. Returns the person
// row on success, or null. Increments the attempt counter on a wrong OTP so it can't be brute-forced
// (a fresh code resets the counter).
async function checkOtp(cfg, email, otp) {
  const { data: person } = await supabase.from(cfg.table)
    .select('id, full_name, email, reset_token_hash, reset_token_expires, reset_otp_attempts')
    .eq('email', email).maybeSingle();
  if (!person || !person.reset_token_hash || !person.reset_token_expires) return { error: 'No code was requested for this email.' };
  if (new Date(person.reset_token_expires) < new Date()) return { error: 'This code has expired. Please request a new one.' };
  if ((person.reset_otp_attempts || 0) >= MAX_OTP_ATTEMPTS) return { error: 'Too many incorrect attempts. Please request a new code.' };

  if (hashToken(otp) !== person.reset_token_hash) {
    await supabase.from(cfg.table).update({ reset_otp_attempts: (person.reset_otp_attempts || 0) + 1 }).eq('id', person.id);
    return { error: 'Incorrect code. Please try again.' };
  }
  return { person };
}

// Same handler for all three audiences — only the table differs. Always responds with the same
// generic message whether or not the email exists, so this can't be used to enumerate accounts.
async function handleForgotPassword(req, res, audience) {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.json(GENERIC_FORGOT_RESPONSE);

    const cfg = RESET_AUDIENCES[audience];
    let query = supabase.from(cfg.table).select('id, full_name, email').eq('email', email);
    query = audience === 'fellow' ? query.eq('status', 'approved') : query.eq('is_active', true);
    const { data: person } = await query.maybeSingle();

    if (person) {
      const otp = genOtp();
      await supabase.from(cfg.table).update({
        reset_token_hash: hashToken(otp),
        reset_token_expires: new Date(Date.now() + OTP_TTL_MS).toISOString(),
        reset_otp_attempts: 0,
      }).eq('id', person.id);

      if (audience === 'fellow') {
        await sendToFellow('password_reset', person, { otp });
      } else {
        const { subject, html } = templates.password_reset(person, { otp });
        await sendEmail({ to: person.email, toName: person.full_name, subject, html, type: 'password_reset' });
      }
    }
    res.json(GENERIC_FORGOT_RESPONSE);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json(GENERIC_FORGOT_RESPONSE); // never leak errors here either
  }
}

router.post('/forgot-password', (req, res) => handleForgotPassword(req, res, 'fellow'));
router.post('/admin/forgot-password', (req, res) => handleForgotPassword(req, res, 'admin'));
router.post('/mentor/forgot-password', (req, res) => handleForgotPassword(req, res, 'mentor'));

// Checks the OTP without consuming it, so the frontend can move to the "choose a new password"
// step. The final /reset-password call below re-checks it for real before touching anything.
router.post('/verify-otp', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '').trim();
    const audience = RESET_AUDIENCES[req.body?.audience] ? req.body.audience : null;
    if (!email || !otp || !audience) return res.status(400).json({ error: 'Invalid request.' });

    const result = await checkOtp(RESET_AUDIENCES[audience], email, otp);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '').trim();
    const password = req.body?.password;
    const audience = RESET_AUDIENCES[req.body?.audience] ? req.body.audience : null;
    if (!email || !otp || !audience) return res.status(400).json({ error: 'Invalid request.' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const cfg = RESET_AUDIENCES[audience];
    const result = await checkOtp(cfg, email, otp);
    if (result.error) return res.status(400).json({ error: result.error });

    const password_hash = await bcrypt.hash(password, 12);
    await supabase.from(cfg.table)
      .update({ password_hash, reset_token_hash: null, reset_token_expires: null, reset_otp_attempts: 0 })
      .eq('id', result.person.id);
    invalidateUser(result.person.id);
    res.json({ success: true, redirect: cfg.loginPath });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// ─── LOGOUT ─────────────────────────────────────────────────────────
router.post('/logout', (req, res) => res.json({ success: true }));

module.exports = router;
