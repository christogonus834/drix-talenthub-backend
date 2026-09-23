// services/points.js — award points atomically (falls back to read-modify-write)
const supabase = require('../config/supabase');
const { syncBadges } = require('./badges');

async function addPoints(fellowId, amount) {
  amount = parseInt(amount, 10);
  if (!fellowId || !amount) return false;
  let ok = false;
  try {
    const { error } = await supabase.rpc('increment_points', { fellow_id: fellowId, amount });
    ok = !error;
  } catch (e) { /* fall through */ }
  if (!ok) {
    try {
      const { data: f } = await supabase.from('fellows').select('points').eq('id', fellowId).single();
      await supabase.from('fellows').update({ points: (f?.points || 0) + amount }).eq('id', fellowId);
      ok = true;
    } catch (e) {
      console.error('[points] failed:', e.message);
      return false;
    }
  }
  // Best-effort — a badge-sync hiccup should never fail the points award itself.
  supabase.from('fellows').select('points').eq('id', fellowId).single()
    .then(({ data }) => { if (data) return syncBadges(fellowId, data.points); })
    .catch(e => console.error('[points->badges]', e.message));
  return ok;
}

module.exports = { addPoints };
