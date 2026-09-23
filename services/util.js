// services/util.js — small shared helpers
const supabase = require('../config/supabase');

// Settings keys that are safe to expose to the public / to fellows.
// Anything not on this list (secret keys, future private keys) is never returned by public endpoints.
const PUBLIC_SETTING_KEYS = [
  'site_name', 'site_logo', 'site_favicon',
  'slide_1', 'slide_2', 'slide_3', 'slide_4',
  'sig1_name', 'sig1_logo', 'sig2_name', 'sig2_logo',
  'registration_open', 'registration_fee',
  'payment_enabled', 'payment_provider', 'payment_currency',
  'flutterwave_public_key', 'paystack_public_key',
  'adsense_enabled', 'adsense_client_id', 'adsense_slot_id',
];

// Fellow columns that are safe to return. NEVER select('*') on fellows in a response — it includes password_hash.
const FELLOW_COLUMNS = [
  'id', 'full_name', 'email', 'phone', 'state', 'gender', 'date_of_birth',
  'epayybillz_user_id', 'track_id', 'cohort_id', 'status', 'fellow_id',
  'profile_photo', 'bio', 'linkedin_url', 'github_url', 'points',
  'payment_verified', 'payment_reference', 'payment_provider',
  'mentor_id', 'mentor_assigned_at', 'email_notifications',
  'created_at', 'approved_at', 'updated_at',
].join(', ');

async function getSettings() {
  const { data } = await supabase.from('settings').select('key, value');
  const map = {};
  (data || []).forEach(r => { map[r.key] = r.value; });
  return map;
}

function pickPublicSettings(map) {
  const out = {};
  PUBLIC_SETTING_KEYS.forEach(k => { if (map[k] !== undefined) out[k] = map[k]; });
  return out;
}

// Await anything (supabase builder or promise) and never throw.
async function safe(p, label = '') {
  try { return await p; }
  catch (err) { if (label) console.error(`[safe:${label}]`, err.message); return null; }
}

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Strip angle brackets from free-text identity fields (names etc.)
function cleanText(v, max = 200) {
  return String(v ?? '').replace(/[<>]/g, '').trim().slice(0, max);
}

function frontendUrl() {
  return (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '');
}
function backendUrl() {
  return (process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = s => typeof s === 'string' && UUID_RE.test(s);

function parseDate(v) {
  if (v === undefined) return undefined;          // not provided
  if (v === null || v === '') return null;        // explicitly cleared
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Monday of the ISO week containing `d` (defaults to now), as YYYY-MM-DD (UTC).
function weekStart(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

module.exports = {
  supabase, PUBLIC_SETTING_KEYS, FELLOW_COLUMNS,
  getSettings, pickPublicSettings, safe, esc, cleanText,
  frontendUrl, backendUrl, isUuid, parseDate, weekStart,
};
