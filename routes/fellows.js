const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');
const { getSettings, pickPublicSettings, FELLOW_COLUMNS, safe, cleanText, esc, weekStart } = require('../services/util');
const { addPoints } = require('../services/points');
const { fellowBadgeView, BADGE_DEFS } = require('../services/badges');
const { verifyUnsubToken } = require('../services/email');
const { computeNextAction, loadTrackState, getEligibility, processDueUnlocks } = require('../services/progress');

// ─── PUBLIC: unsubscribe from activity emails ─────────────────────────
// GET shows a confirm page (so mail-scanner link prefetch can't unsubscribe anyone); POST performs it.
function unsubPage(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(title)}</title></head>
<body style="font-family:Arial,sans-serif;background:#f4f5fb;margin:0;padding:40px 16px;"><div style="max-width:440px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;text-align:center;">
<h2 style="margin:0 0 12px;color:#0f1020;">${esc(title)}</h2>${body}</div></body></html>`;
}
router.get('/unsubscribe', (req, res) => {
  const token = String(req.query.token || '');
  if (!verifyUnsubToken(token)) return res.status(400).send(unsubPage('Link not valid', '<p style="color:#555;">This unsubscribe link is invalid or has expired.</p>'));
  res.send(unsubPage('Unsubscribe from activity emails?',
    `<p style="color:#555;line-height:1.6;">You will stop receiving module, announcement, grading and message emails. Account emails (approval, certificate) will still be sent.</p>
     <form method="POST" action="/api/fellows/unsubscribe"><input type="hidden" name="token" value="${esc(token)}"/>
     <button style="background:#7C6EF7;color:#fff;border:0;padding:12px 26px;border-radius:8px;font-weight:600;cursor:pointer;">Unsubscribe</button></form>`));
});
router.post('/unsubscribe', async (req, res) => {
  const id = verifyUnsubToken(String(req.body?.token || ''));
  if (!id) return res.status(400).send(unsubPage('Link not valid', '<p style="color:#555;">This unsubscribe link is invalid or has expired.</p>'));
  await safe(supabase.from('fellows').update({ email_notifications: false }).eq('id', id), 'unsub');
  res.send(unsubPage('You are unsubscribed', '<p style="color:#555;line-height:1.6;">You will no longer receive activity emails. You can turn them back on any time from your dashboard.</p>'));
});

// ─── PUBLIC: tracks + settings ────────────────────────────────────────
router.get('/tracks-public', async (req, res) => {
  try {
    const { data } = await supabase
      .from('tracks')
      .select('id, name, icon, slug')
      .eq('is_active', true)
      .order('name');
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// Whitelisted public settings only — never returns secret keys
router.get('/settings', async (req, res) => {
  try {
    res.json(pickPublicSettings(await getSettings()));
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ─── Get fellow profile + dashboard data ─────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { data: fellow } = await supabase
      .from('fellows')
      .select(`${FELLOW_COLUMNS}, tracks(*), cohorts(*), mentors(id, full_name, bio, profile_photo)`)   // never password_hash
      .eq('id', req.user.id)
      .single();

    const { data: progress } = await supabase
      .from('fellow_progress').select('*, courses(*)').eq('fellow_id', req.user.id);

    const { data: notifications } = await supabase
      .from('notifications').select('*').eq('fellow_id', req.user.id)
      .order('created_at', { ascending: false }).limit(10);

    const { data: results } = await supabase
      .from('assessment_results').select('*, assessments(title)').eq('fellow_id', req.user.id)
      .order('taken_at', { ascending: false });

    const badges = await fellowBadgeView(req.user.id, fellow?.points || 0);

    res.json({ fellow, progress, notifications, results, badges });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch data.' });
  }
});

// ─── DO THIS NEXT ─────────────────────────────────────────────────────
router.get('/next-action', authMiddleware, async (req, res) => {
  try {
    const { data: fellow } = await supabase.from('fellows').select('track_id').eq('id', req.user.id).single();
    if (!fellow?.track_id) {
      return res.json({ type: 'caught_up', title: 'No track assigned yet', subtitle: 'Contact your admin to be placed on a track.', deadline: null, action_url: null, action_label: null });
    }
    processDueUnlocks(fellow.track_id);
    res.json(await computeNextAction(req.user.id, fellow.track_id));
  } catch (err) {
    console.error('next-action:', err);
    res.status(500).json({ error: 'Failed to work out your next step.' });
  }
});

// ─── DASHBOARD SUMMARY: real lesson progress + latest feedback + certificate state ──
router.get('/dashboard-summary', authMiddleware, async (req, res) => {
  try {
    const { data: fellow } = await supabase.from('fellows').select('track_id').eq('id', req.user.id).single();

    let progress = { total: 0, done: 0, percent: 0, recent: [] };
    let eligibility = null;
    if (fellow?.track_id) {
      const st = await loadTrackState(req.user.id, fellow.track_id);
      const open = st.modules.filter(m => !m.is_locked);
      progress = {
        total: st.totalLessons, done: st.doneLessons, percent: st.percent,
        recent: open.flatMap(m => m.lessons.map(l => ({ id: l.id, title: l.title, done: l.done, type: l.type, module: m.title }))).slice(0, 4),
      };
      eligibility = await getEligibility(req.user.id, st);
    }

    const { data: fb } = await supabase.from('assignment_submissions')
      .select('id, status, grade, feedback, graded_at, assignment_id, assignments(id, title, max_score, module_id)')
      .eq('fellow_id', req.user.id).in('status', ['graded', 'returned'])
      .order('graded_at', { ascending: false }).limit(1);

    const f = fb?.[0];
    const latest_feedback = f ? {
      assignment_title: f.assignments?.title, max_score: f.assignments?.max_score, grade: f.grade,
      approved: f.status === 'graded', feedback: f.feedback, graded_at: f.graded_at,
      action_url: `/dashboard/courses?module=${f.assignments?.module_id}&assignment=${f.assignment_id}`,
    } : null;

    res.json({ progress, eligibility, latest_feedback });
  } catch (err) {
    console.error('dashboard-summary:', err);
    res.status(500).json({ error: 'Failed to load summary.' });
  }
});

// ─── EMAIL PREFERENCES ────────────────────────────────────────────────
router.get('/email-preferences', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('fellows').select('email_notifications').eq('id', req.user.id).single();
  res.json({ email_notifications: data?.email_notifications !== false });
});
router.patch('/email-preferences', authMiddleware, async (req, res) => {
  try {
    const value = req.body?.email_notifications === true;
    const { error } = await supabase.from('fellows').update({ email_notifications: value }).eq('id', req.user.id);
    if (error) throw error;
    res.json({ success: true, email_notifications: value });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save preference.' });
  }
});

// ─── Weekly check-in ────────────────────────────────────────────────
router.get('/checkin', authMiddleware, async (req, res) => {
  try {
    const week = weekStart();
    const { data } = await supabase.from('weekly_checkins').select('*')
      .eq('fellow_id', req.user.id).eq('week_start', week).maybeSingle();
    res.json({ week_start: week, checkin: data || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load check-in status.' });
  }
});

router.post('/checkin', authMiddleware, async (req, res) => {
  try {
    const confidence_rating = Number(req.body?.confidence_rating);
    let hours_studied = Number(req.body?.hours_studied);
    const needs_help = !!req.body?.needs_help;
    const note = req.body?.note ? cleanText(req.body.note, 1000) : null;

    if (!Number.isFinite(confidence_rating) || confidence_rating < 1 || confidence_rating > 5) {
      return res.status(400).json({ error: 'Confidence rating must be between 1 and 5.' });
    }
    if (!Number.isFinite(hours_studied) || hours_studied < 0) hours_studied = 0;
    if (hours_studied > 168) hours_studied = 168;

    const week = weekStart();
    const { data, error } = await supabase.from('weekly_checkins')
      .upsert({ fellow_id: req.user.id, week_start: week, confidence_rating, hours_studied, needs_help, note, submitted_at: new Date().toISOString() },
        { onConflict: 'fellow_id,week_start' })
      .select().single();
    if (error) throw error;

    if (needs_help) {
      await safe(supabase.from('notifications').insert({
        fellow_id: req.user.id, title: 'We got your flag',
        message: "You marked that you need help this week. Your mentor or an admin will reach out soon.",
        type: 'info',
      }), 'notif');
    }

    res.json({ success: true, checkin: data });
  } catch (err) {
    console.error('Checkin error:', err);
    res.status(500).json({ error: 'Failed to save check-in.' });
  }
});

// ─── Portfolio ──────────────────────────────────────────────────────
router.get('/portfolio', authMiddleware, async (req, res) => {
  try {
    const { data: fellow } = await supabase.from('fellows').select('portfolio_slug, portfolio_public').eq('id', req.user.id).single();
    const { data: subs } = await supabase.from('assignment_submissions')
      .select('id, content, file_url, grade, feedback, submitted_at, is_public, assignments(title, max_score)')
      .eq('fellow_id', req.user.id).eq('status', 'graded')
      .order('submitted_at', { ascending: false });
    res.json({ portfolio_slug: fellow?.portfolio_slug || null, portfolio_public: fellow?.portfolio_public || false, submissions: subs || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load portfolio.' });
  }
});

router.patch('/portfolio-settings', authMiddleware, async (req, res) => {
  try {
    const updates = {};
    if (req.body?.portfolio_public !== undefined) updates.portfolio_public = !!req.body.portfolio_public;
    if (req.body?.slug !== undefined) {
      const slug = String(req.body.slug).toLowerCase().trim().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      if (!slug || slug.length < 3) return res.status(400).json({ error: 'Pick a slug with at least 3 letters/numbers.' });
      updates.portfolio_slug = slug;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });

    const { data, error } = await supabase.from('fellows').update(updates).eq('id', req.user.id)
      .select('portfolio_slug, portfolio_public').single();
    if (error) {
      if (String(error.code) === '23505') return res.status(400).json({ error: 'That link is already taken — try another.' });
      throw error;
    }
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update portfolio settings.' });
  }
});

router.patch('/submissions/:id/portfolio', authMiddleware, async (req, res) => {
  try {
    const is_public = !!req.body?.is_public;
    const { data: sub } = await supabase.from('assignment_submissions').select('fellow_id, status').eq('id', req.params.id).single();
    if (!sub || sub.fellow_id !== req.user.id) return res.status(404).json({ error: 'Submission not found.' });
    if (sub.status !== 'graded') return res.status(400).json({ error: 'Only approved, graded work can be added to your portfolio.' });
    const { error } = await supabase.from('assignment_submissions').update({ is_public }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, is_public });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update.' });
  }
});

// ─── Leaderboard ──────────────────────────────────────────────────────
router.get('/badge-defs', (req, res) => res.json(BADGE_DEFS));

router.get('/leaderboard', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('fellows')
      .select('id, full_name, points, fellow_id, tracks(name), profile_photo')
      .eq('status', 'approved')
      .order('points', { ascending: false })
      .limit(50);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leaderboard.' });
  }
});

// ─── Community ────────────────────────────────────────────────────────
router.get('/community', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('community_posts')
      .select('*, fellows(full_name, fellow_id, profile_photo, tracks(name))')
      .eq('is_active', true)
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(20);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch posts.' });
  }
});

router.post('/community', authMiddleware, async (req, res) => {
  try {
    const title = cleanText(req.body?.title, 200);
    const content = String(req.body?.content || '').replace(/[<>]/g, '').trim().slice(0, 5000);
    const category = cleanText(req.body?.category || 'general', 40);
    if (!title || !content) return res.status(400).json({ error: 'Title and content are required.' });

    // points only for the first 3 posts per rolling 24h (stops point farming)
    const since = new Date(Date.now() - 86400000).toISOString();
    const { count } = await supabase.from('community_posts').select('id', { count: 'exact', head: true })
      .eq('fellow_id', req.user.id).gte('created_at', since);

    const { data, error } = await supabase
      .from('community_posts')
      .insert({ fellow_id: req.user.id, title, content, category })
      .select().single();
    if (error) throw error;

    if ((count || 0) < 3) await addPoints(req.user.id, 5);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create post.' });
  }
});

// ─── Legacy course list (old `courses` table) ─────────────────────────
router.get('/courses', authMiddleware, async (req, res) => {
  try {
    const { data: fellow } = await supabase.from('fellows').select('track_id').eq('id', req.user.id).single();
    const { data: courses } = await supabase
      .from('courses').select('*').eq('track_id', fellow?.track_id)
      .eq('is_active', true).order('order_index');
    const { data: progress } = await supabase.from('fellow_progress').select('*').eq('fellow_id', req.user.id);
    const progressMap = {};
    progress?.forEach(p => { progressMap[p.course_id] = p; });
    res.json(courses?.map(c => ({ ...c, progress: progressMap[c.id] || null })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch courses.' });
  }
});

router.post('/courses/:id/complete', authMiddleware, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('fellow_progress').select('completed')
      .eq('fellow_id', req.user.id).eq('course_id', req.params.id).maybeSingle();
    if (existing?.completed) return res.json({ success: true, already_completed: true });

    const { data } = await supabase
      .from('fellow_progress')
      .upsert({ fellow_id: req.user.id, course_id: req.params.id, completed: true, completed_at: new Date() }, { onConflict: 'fellow_id,course_id' })
      .select().single();

    await addPoints(req.user.id, 10);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark complete.' });
  }
});

// ─── Notifications ────────────────────────────────────────────────────
router.patch('/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await supabase.from('notifications').update({ is_read: true })
      .eq('id', req.params.id).eq('fellow_id', req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ─── Profile photo (base64 image only) ────────────────────────────────
router.post('/upload-photo', authMiddleware, async (req, res) => {
  try {
    const { photo_base64 } = req.body;
    if (!photo_base64 || typeof photo_base64 !== 'string' || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(photo_base64)) {
      return res.status(400).json({ error: 'Please upload a PNG, JPG, WEBP or GIF image.' });
    }
    const { data, error } = await supabase
      .from('fellows').update({ profile_photo: photo_base64 })
      .eq('id', req.user.id).select('profile_photo').single();
    if (error) throw error;
    res.json({ success: true, profile_photo: data.profile_photo });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload photo.' });
  }
});

module.exports = router;
