// routes/payments.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

// FIX #6 — polyfill fetch for Node < 18
const _fetch = globalThis.fetch || require('node-fetch').default || require('node-fetch');

// ── Public: Get payment config ────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('*');
    const s = {};
    data?.forEach(row => s[row.key] = row.value);
    res.json({
      payment_enabled:    s.payment_enabled === 'true',
      payment_provider:   s.payment_provider || 'flutterwave',
      registration_fee:   parseFloat(s.registration_fee || '0'),
      payment_currency:   s.payment_currency || 'NGN',
      flutterwave_public_key: s.flutterwave_public_key || '',
      paystack_public_key:    s.paystack_public_key || '',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment config.' });
  }
});

// ── Verify payment after success callback ─────────────────────────────
router.post('/verify', async (req, res) => {
  try {
    const { reference, provider, email } = req.body;
    if (!reference || !provider) return res.status(400).json({ error: 'Missing reference or provider.' });

    const { data: settings } = await supabase.from('settings').select('*');
    const s = {};
    settings?.forEach(row => s[row.key] = row.value);

    let verified = false;
    let amount = 0;

    if (provider === 'paystack') {
      const resp = await _fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${s.paystack_secret_key}` }
      });
      const data = await resp.json();
      if (data.data?.status === 'success') {
        verified = true;
        amount = data.data.amount / 100; // kobo → naira
      }
    } else if (provider === 'flutterwave') {
      const resp = await _fetch(`https://api.flutterwave.com/v3/transactions/${reference}/verify`, {
        headers: { Authorization: `Bearer ${s.flutterwave_secret_key}` }
      });
      const data = await resp.json();
      if (data.data?.status === 'successful') {
        verified = true;
        amount = data.data.amount;
      }
    }

    if (!verified) return res.status(400).json({ error: 'Payment verification failed.' });

    // Log payment
    await supabase.from('payments').insert({
      reference, provider, email, amount,
      status: 'success',
      paid_at: new Date(),
    }).catch(() => {});

    res.json({ success: true, verified: true, amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification error.' });
  }
});

module.exports = router;
