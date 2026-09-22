// routes/payments.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { getSettings, safe } = require('../services/util');
const { verifyRegistrationPayment } = require('../services/payments');

// ── Public: payment config (public keys only) ─────────────────────────
router.get('/config', async (req, res) => {
  try {
    const s = await getSettings();
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

// ── Verify a payment (used by the registration form before submit) ────
// Verifies with the provider AND checks amount/currency against the configured fee.
// Registration re-verifies server-side, so this endpoint is advisory for the UI.
router.post('/verify', async (req, res) => {
  try {
    const { reference, provider, email } = req.body || {};
    const v = await verifyRegistrationPayment({ provider, reference });
    if (!v.ok) return res.status(400).json({ error: v.error || 'Payment verification failed.' });

    await safe(supabase.from('payments').upsert({
      reference: String(reference), provider, email: email || v.email || null,
      amount: v.amount, status: 'success', paid_at: new Date().toISOString(),
    }, { onConflict: 'reference', ignoreDuplicates: true }), 'payments');

    res.json({ success: true, verified: true, amount: v.amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification error.' });
  }
});

module.exports = router;
