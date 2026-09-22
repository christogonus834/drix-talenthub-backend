// services/recipients.js — the ONE place that decides who may be emailed about an action.
//
// Scoping rule: a fellow only receives emails about actions taken by THEIR OWN mentor,
// plus global actions taken by an admin.
//   actorType 'admin'  → audience filter only (all / track / cohort / explicit fellowIds)
//   actorType 'mentor' → ONLY fellows where fellows.mentor_id === actorId, intersected with the audience filter
//
// Every send site (single fellow or broadcast) routes through this so mentor scoping
// (Phase 2) never needs a rewrite.

const supabase = require('../config/supabase');
const { isUuid } = require('./util');

const COLS = 'id, full_name, email, track_id, cohort_id, mentor_id, email_notifications, status';

async function resolveRecipients({
  actorId = null, actorType = 'admin',
  audience = 'all', trackId = null, cohortId = null,
  fellowIds = null,
  respectPrefs = false,      // true for activity emails (drops opted-out fellows)
} = {}) {
  if (actorType !== 'admin' && actorType !== 'mentor') return [];
  if (actorType === 'mentor' && !isUuid(actorId)) return [];
  if (audience === 'track' && !isUuid(trackId)) return [];
  if (audience === 'cohort' && !isUuid(cohortId)) return [];
  if (fellowIds && !fellowIds.length) return [];

  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('fellows').select(COLS).eq('status', 'approved').order('id').range(from, from + PAGE - 1);
    if (actorType === 'mentor') q = q.eq('mentor_id', actorId);
    if (audience === 'track') q = q.eq('track_id', trackId);
    if (audience === 'cohort') q = q.eq('cohort_id', cohortId);
    if (fellowIds) q = q.in('id', fellowIds);
    const { data, error } = await q;
    if (error) { console.error('[recipients]', error.message); break; }
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  const withEmail = rows.filter(f => f.email);
  return respectPrefs ? withEmail.filter(f => f.email_notifications !== false) : withEmail;
}

module.exports = { resolveRecipients };
