// services/badges.js — simple point-threshold badges. Defined here (not in the DB) so adding a
// new tier is a one-line change; `fellow_badges` just tracks which ones a fellow has already been
// awarded/notified about, so we don't re-notify on every points update.
const supabase = require('../config/supabase');

const BADGE_DEFS = [
  { key: 'points_100',  label: 'First Steps',        icon: '🌱', min_points: 100 },
  { key: 'points_300',  label: 'Building Momentum',  icon: '🔥', min_points: 300 },
  { key: 'points_750',  label: 'Consistent Fellow',  icon: '⭐', min_points: 750 },
  { key: 'points_1500', label: 'Top Performer',      icon: '🏆', min_points: 1500 },
  { key: 'points_3000', label: 'Drix Elite',         icon: '💎', min_points: 3000 },
];

// Call after a fellow's points change. Awards any newly-crossed badges and fires an in-app
// notification for each. Safe to call often — it's a no-op once all eligible badges are recorded.
async function syncBadges(fellowId, points) {
  try {
    const eligible = BADGE_DEFS.filter(b => points >= b.min_points).map(b => b.key);
    if (!eligible.length) return [];

    const { data: existing } = await supabase.from('fellow_badges').select('badge_key').eq('fellow_id', fellowId);
    const have = new Set((existing || []).map(r => r.badge_key));
    const newKeys = eligible.filter(k => !have.has(k));
    if (!newKeys.length) return eligible;

    await supabase.from('fellow_badges').insert(newKeys.map(badge_key => ({ fellow_id: fellowId, badge_key })));
    for (const key of newKeys) {
      const def = BADGE_DEFS.find(b => b.key === key);
      await supabase.from('notifications').insert({
        fellow_id: fellowId, title: `Badge earned: ${def.label}`,
        message: `You unlocked the ${def.icon} ${def.label} badge — ${def.min_points}+ points!`,
        type: 'success',
      });
    }
    return eligible;
  } catch (e) {
    console.error('[badges] sync failed:', e.message);
    return [];
  }
}

// For display: all defs annotated with whether this fellow has earned them.
async function fellowBadgeView(fellowId, points) {
  const { data: earned } = await supabase.from('fellow_badges').select('badge_key, earned_at').eq('fellow_id', fellowId);
  const earnedMap = new Map((earned || []).map(r => [r.badge_key, r.earned_at]));
  return BADGE_DEFS.map(b => ({ ...b, earned: points >= b.min_points, earned_at: earnedMap.get(b.key) || null }));
}

module.exports = { BADGE_DEFS, syncBadges, fellowBadgeView };
