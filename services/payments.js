// services/payments.js — server-side payment verification (Paystack / Flutterwave)
const { getSettings } = require('./util');
const _fetch = globalThis.fetch || require('node-fetch');

async function verifyWithProvider(provider, reference, secrets) {
  if (provider === 'paystack') {
    if (!secrets.paystack_secret_key) return { ok: false, error: 'Paystack is not configured.' };
    const r = await _fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secrets.paystack_secret_key}` }
    });
    const body = await r.json().catch(() => ({}));
    if (body?.data?.status !== 'success') return { ok: false, error: 'Payment not successful.' };
    return { ok: true, amount: Number(body.data.amount) / 100, currency: body.data.currency, email: body.data.customer?.email || null };
  }
  if (provider === 'flutterwave') {
    if (!secrets.flutterwave_secret_key) return { ok: false, error: 'Flutterwave is not configured.' };
    const r = await _fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(reference)}/verify`, {
      headers: { Authorization: `Bearer ${secrets.flutterwave_secret_key}` }
    });
    const body = await r.json().catch(() => ({}));
    if (body?.data?.status !== 'successful') return { ok: false, error: 'Payment not successful.' };
    return { ok: true, amount: Number(body.data.amount), currency: body.data.currency, email: body.data.customer?.email || null };
  }
  return { ok: false, error: 'Unknown payment provider.' };
}

// Verifies the transaction with the provider AND checks it against the configured fee/currency.
async function verifyRegistrationPayment({ provider, reference }) {
  if (!provider || !reference) return { ok: false, error: 'Missing payment reference or provider.' };
  const s = await getSettings();
  const fee = parseFloat(s.registration_fee || '0');
  const result = await verifyWithProvider(provider, String(reference), s);
  if (!result.ok) return result;

  if (fee > 0 && result.amount + 0.0001 < fee) {
    return { ok: false, error: `Payment amount is less than the registration fee (${fee}).` };
  }
  const expectedCurrency = (s.payment_currency || 'NGN').toUpperCase();
  if (result.currency && result.currency.toUpperCase() !== expectedCurrency) {
    return { ok: false, error: `Payment must be made in ${expectedCurrency}.` };
  }
  return { ...result, fee };
}

module.exports = { verifyRegistrationPayment };
