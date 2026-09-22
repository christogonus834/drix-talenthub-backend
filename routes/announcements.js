// routes/announcements.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { cleanText, isUuid } = require('../services/util');
const { resolveRecipients } = require('../services/recipients');
const { sendBulk, DAILY_LIMIT, emailsSentToday } = require('../services/email');

const AUDIENCES = ['all', 'track', 'cohort'];

function validateAudience(audience, track_id, cohort_id) {
  if (!AUDIENCES.includes(audience)) return 'Invalid audience.';
  if (audience === 'track' && !isUuid(track_id)) return 'Pick a track for this announcement.';
  if (audience === 'cohort' && !isUuid(cohort_id)) return 'Pick a cohort for this announcement.';
  return null;
}

// ── Fellow: announcements for me (filtered server-side) ──────────────
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const { data: me } = await supabase.from('fellows').select('track_id, cohort_id, mentor_id').eq('id', req.user.id).single();
    if (!me) return res.json([]);

    const clauses = ['audience.eq.all'];
    if (isUuid(me.track_id))  clauses.push(`and(audience.eq.track,track_id.eq.${me.track_id})`);
    if (isUuid(me.cohort_id)) clauses.push(`and(audience.eq.cohort,cohort_id.eq.${me.cohort_id})`);

    const { data } = await supabase.from('announcements')
      .select('id, title, content, audience, posted_by_type, posted_by, created_at')
      .eq('is_active', true).or(clauses.join(','))
      .order('created_at', { ascending: false }).limit(30);

    // a mentor's announcement is only for that mentor's own fellows
    const visible = (data || []).filter(a => a.posted_by_type !== 'mentor' || a.posted_by === me.mentor_id);
    res.json(visible.map(({ posted_by, ...rest }) => rest));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch announcements.' });
  }
});

// ── Admin: list all ──────────────────────────────────────────────────
router.get('/admin/all', adminMiddleware, async (req, res) => {
  try {
    const { data } = await supabase.from('announcements')
      .select('*, tracks(name), cohorts(name)')
      .order('created_at', { ascending: false }).limit(200);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── Admin: how many fellows would an email reach? (drives the UI warning) ──
router.get('/admin/recipient-count', adminMiddleware, async (req, res) => {
  try {
    const { audience = 'all', track_id, cohort_id } = req.query;
    const bad = validateAudience(audience, track_id, cohort_id);
    if (bad) return res.status(400).json({ error: bad });
    const recipients = await resolveRecipients({ actorId: req.admin.id, actorType: 'admin', audience, trackId: track_id, cohortId: cohort_id, respectPrefs: true });
    const used = await emailsSentToday();
    res.json({ count: recipients.length, sent_today: used, daily_limit: DAILY_LIMIT, remaining_today: Math.max(0, DAILY_LIMIT - used) });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── Admin: create (optionally emails the audience) ───────────────────
router.post('/admin', adminMiddleware, async (req, res) => {
  try {
    const title = cleanText(req.body?.title, 200);
    const content = req.body?.content ? String(req.body.content).slice(0, 10000) : null;
    const audience = req.body?.audience || 'all';
    const { track_id, cohort_id } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const bad = validateAudience(audience, track_id, cohort_id);
    if (bad) return res.status(400).json({ error: bad });

    const send_email = req.body?.send_email !== false;
    const { data: ann, error } = await supabase.from('announcements').insert({
      title, content, audience,
      track_id: audience === 'track' ? track_id : null,
      cohort_id: audience === 'cohort' ? cohort_id : null,
      posted_by: req.admin.id, posted_by_type: 'admin',
      send_email, is_active: true,
    }).select().single();
    if (error) throw error;

    // Fellows see the announcement in their dashboard feed. Email is optional.
    let emailing = 0;
    if (send_email) {
      const recipients = await resolveRecipients({ actorId: req.admin.id, actorType: 'admin', audience, trackId: track_id, cohortId: cohort_id, respectPrefs: true });
      emailing = recipients.length;
      // background send: budget-aware, logs the count first
      sendBulk('announcement', recipients, { title, content })
        .then(r => supabase.from('announcements').update({ emailed_count: r.sent, emailed_at: new Date().toISOString() }).eq('id', ann.id))
        .catch(e => console.error('[announcement email]', e.message));
    }

    res.json({ success: true, announcement: ann, emailing });
  } catch (err) {
    console.error('announcement create:', err);
    res.status(500).json({ error: 'Failed to create announcement.' });
  }
});

// ── Admin: edit (never re-sends email) ───────────────────────────────
router.patch('/admin/:id', adminMiddleware, async (req, res) => {
  try {
    const updates = {};
    if (req.body.title !== undefined) {
      updates.title = cleanText(req.body.title, 200);
      if (!updates.title) return res.status(400).json({ error: 'Title is required.' });
    }
    if (req.body.content !== undefined) updates.content = String(req.body.content || '').slice(0, 10000);
    if (req.body.is_active !== undefined) updates.is_active = req.body.is_active === true;

    if (req.body.audience !== undefined) {
      const audience = req.body.audience;
      const bad = validateAudience(audience, req.body.track_id, req.body.cohort_id);
      if (bad) return res.status(400).json({ error: bad });
      updates.audience = audience;
      updates.track_id = audience === 'track' ? req.body.track_id : null;
      updates.cohort_id = audience === 'cohort' ? req.body.cohort_id : null;
    }

    const { data, error } = await supabase.from('announcements').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, announcement: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update announcement.' });
  }
});

// ── Admin: delete ────────────────────────────────────────────────────
router.delete('/admin/:id', adminMiddleware, async (req, res) => {
  try {
    await supabase.from('announcements').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

module.exports = router;
