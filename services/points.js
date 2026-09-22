// services/points.js — award points atomically (falls back to read-modify-write)
const supabase = require('../config/supabase');

async function addPoints(fellowId, amount) {
  amount = parseInt(amount, 10);
  if (!fellowId || !amount) return false;
  try {
    const { error } = await supabase.rpc('increment_points', { fellow_id: fellowId, amount });
    if (!error) return true;
  } catch (e) { /* fall through */ }
  try {
    const { data: f } = await supabase.from('fellows').select('points').eq('id', fellowId).single();
    await supabase.from('fellows').update({ points: (f?.points || 0) + amount }).eq('id', fellowId);
    return true;
  } catch (e) {
    console.error('[points] failed:', e.message);
    return false;
  }
}

module.exports = { addPoints };
