const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { adminMiddleware, requireRole, invalidateUser } = require('../middleware/auth');
const { getSettings, pickPublicSettings, FELLOW_COLUMNS, safe, isUuid, weekStart } = require('../services/util');
const { sendToFellow, sendBulk } = require('../services/email');

// PUBLIC (no auth): only whitelisted, non-secret settings. Secret keys are never returned here.
router.get('/settings/public', async (req, res) => {
  try {
    res.json(pickPublicSettings(await getSettings()));
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// Apply admin middleware to all routes
router.use(adminMiddleware);

// ─── DASHBOARD STATS ────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [fellows, pending, tracks, cohorts] = await Promise.all([
      supabase.from('fellows').select('id, status, created_at, points'),
      supabase.from('fellows').select('id').eq('status', 'pending'),
      supabase.from('tracks').select('id').eq('is_active', true),
      supabase.from('cohorts').select('id').eq('is_active', true),
    ]);

    const approved = fellows.data?.filter(f => f.status === 'approved').length || 0;
    const total = fellows.data?.length || 0;

    res.json({
      total_fellows: total,
      approved_fellows: approved,
      pending_fellows: pending.data?.length || 0,
      active_tracks: tracks.data?.length || 0,
      active_cohorts: cohorts.data?.length || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

// ─── FELLOWS CRUD ────────────────────────────────────────────────────
router.get('/fellows', async (req, res) => {
  try {
    const { status, track_id, cohort_id, search, page = 1, limit = 20 } = req.query;
    let query = supabase
      .from('fellows')
      .select(`${FELLOW_COLUMNS}, tracks(name), cohorts(name)`, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (status) query = query.eq('status', status);
    if (track_id) query = query.eq('track_id', track_id);
    if (cohort_id) query = query.eq('cohort_id', cohort_id);
    if (search) query = query.ilike('full_name', `%${String(search).replace(/[%_,()]/g, ' ').slice(0, 80)}%`);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ data, count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch fellows.' });
  }
});

router.get('/fellows/:id', async (req, res) => {
  try {
    const { data } = await supabase
      .from('fellows')
      .select(`${FELLOW_COLUMNS}, tracks(*), cohorts(*)`)
      .eq('id', req.params.id)
      .single();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Fellow not found.' });
  }
});

router.patch('/fellows/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['approved', 'rejected', 'suspended', 'pending'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status.' });

    const { data: before } = await supabase.from('fellows').select('status, approved_at').eq('id', req.params.id).single();
    if (!before) return res.status(404).json({ error: 'Fellow not found.' });

    const updateData = { status };
    if (status === 'approved' && !before.approved_at) updateData.approved_at = new Date();

    const { data, error } = await supabase
      .from('fellows')
      .update(updateData)
      .eq('id', req.params.id)
      .select(FELLOW_COLUMNS)
      .single();

    if (error) throw error;
    invalidateUser(req.params.id); // suspension / approval takes effect immediately

    const messages = {
      approved: { title: '🎉 Application Approved!', message: 'Congratulations! Your application has been approved. You can now access your dashboard.', type: 'success' },
      rejected: { title: 'Application Update', message: 'Unfortunately, your application was not approved at this time.', type: 'warning' },
      suspended: { title: 'Account Suspended', message: 'Your account has been suspended. Please contact support.', type: 'alert' },
    };
    if (messages[status] && status !== before.status) {
      await safe(supabase.from('notifications').insert({ fellow_id: req.params.id, ...messages[status] }), 'notif');
    }

    // Account emails (always sent). Welcome only on FIRST approval, not when re-instating a suspended fellow.
    if (status !== before.status) {
      if (status === 'approved' && !before.approved_at) sendToFellow('welcome', data).catch(() => {});
      if (status === 'rejected') sendToFellow('rejected', data).catch(() => {});
    }

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

router.put('/fellows/:id', async (req, res) => {
  try {
    const allowed = ['full_name', 'phone', 'state', 'gender', 'track_id', 'cohort_id', 'bio', 'points'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    const { data, error } = await supabase
      .from('fellows')
      .update(updates)
      .eq('id', req.params.id)
      .select(FELLOW_COLUMNS)
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update fellow.' });
  }
});

router.delete('/fellows/:id', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    await supabase.from('fellows').delete().eq('id', req.params.id);
    invalidateUser(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete fellow.' });
  }
});

// Bulk approve — only fellows who are not already approved, each gets a notification + welcome email
router.post('/fellows/bulk-approve', async (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(isUuid);
    if (!ids.length) return res.status(400).json({ error: 'No fellows selected.' });

    const { data: targets } = await supabase.from('fellows')
      .select('id, full_name, email, approved_at').in('id', ids).neq('status', 'approved');
    if (!targets?.length) return res.json({ success: true, approved: 0 });

    const targetIds = targets.map(t => t.id);
    await supabase.from('fellows').update({ status: 'approved', approved_at: new Date() }).in('id', targetIds);
    targetIds.forEach(invalidateUser);

    await safe(supabase.from('notifications').insert(targetIds.map(id => ({
      fellow_id: id, title: '🎉 Application Approved!',
      message: 'Congratulations! Your application has been approved. You can now access your dashboard.', type: 'success',
    }))), 'notif');

    const firstTime = targets.filter(t => !t.approved_at).map(t => ({ ...t, email_notifications: true }));
    sendBulk('welcome', firstTime).catch(() => {});

    res.json({ success: true, approved: targetIds.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ─── SUBMISSIONS (review queue) ──────────────────────────────────────
// ?status=ungraded|graded|all  &track_id=  &page=  &limit=
router.get('/submissions', async (req, res) => {
  try {
    const { status = 'ungraded', track_id } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));

    let q = supabase.from('assignment_submissions')
      .select(`id, content, file_url, submitted_at, status, grade, feedback, graded_at, graded_by, points_awarded,
        fellows(id, full_name, fellow_id, email, profile_photo),
        assignments!inner(id, title, max_score, points_reward, module_id, modules!inner(id, title, track_id, tracks(name)))`, { count: 'exact' });

    if (status === 'ungraded') q = q.eq('status', 'submitted');
    else if (status === 'graded') q = q.in('status', ['graded', 'returned']);
    if (isUuid(track_id)) q = q.eq('assignments.modules.track_id', track_id);

    q = q.order('submitted_at', { ascending: status === 'ungraded' }).range((page - 1) * limit, page * limit - 1);
    const { data, count, error } = await q;
    if (error) throw error;
    res.json({ data: data || [], total: count || 0, page, limit });
  } catch (err) {
    console.error('submissions list:', err.message);
    res.status(500).json({ error: 'Failed to load submissions.' });
  }
});

// ─── TRACKS CRUD ─────────────────────────────────────────────────────
router.get('/tracks', async (req, res) => {
  try {
    const { data } = await supabase.from('tracks').select('*').order('name');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

router.post('/tracks', async (req, res) => {
  try {
    const { name, slug, description, icon, duration_weeks, level } = req.body;
    const { data, error } = await supabase.from('tracks').insert({ name, slug, description, icon, duration_weeks, level }).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create track.' });
  }
});

router.put('/tracks/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('tracks').update(req.body).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update track.' });
  }
});

router.delete('/tracks/:id', async (req, res) => {
  try {
    await supabase.from('tracks').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ─── COHORTS CRUD ────────────────────────────────────────────────────
router.get('/cohorts', async (req, res) => {
  try {
    const { data } = await supabase.from('cohorts').select('*').order('created_at', { ascending: false });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

router.post('/cohorts', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cohorts').insert(req.body).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

router.put('/cohorts/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('cohorts').update(req.body).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

router.delete('/cohorts/:id', async (req, res) => {
  try {
    await supabase.from('cohorts').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ─── COURSES CRUD ────────────────────────────────────────────────────
router.get('/courses', async (req, res) => {
  try {
    const { track_id } = req.query;
    let query = supabase.from('courses').select('*, tracks(name)').order('order_index');
    if (track_id) query = query.eq('track_id', track_id);
    const { data } = await query;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

router.post('/courses', async (req, res) => {
  try {
    const { data, error } = await supabase.from('courses').insert(req.body).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

router.put('/courses/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('courses').update(req.body).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

router.delete('/courses/:id', async (req, res) => {
  try {
    await supabase.from('courses').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ─── SETTINGS (admin / super_admin only — includes payment secrets) ──
router.get('/settings', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

router.patch('/settings', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const updates = req.body || {};
    const entries = Object.entries(updates).filter(([k]) => /^[a-z0-9_]{1,60}$/.test(k));
    const results = await Promise.all(entries.map(([key, value]) =>
      supabase.from('settings').upsert({ key, value: String(value ?? ''), updated_at: new Date() }, { onConflict: 'key' })
    ));
    if (results.some(r => r.error)) throw new Error(results.find(r => r.error).error.message);
    res.json({ success: true });
  } catch (err) {
    console.error('Settings save error:', err.message);
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// ─── NOTIFICATIONS (broadcast) ───────────────────────────────────────
router.post('/notifications/broadcast', async (req, res) => {
  try {
    const { title, message, type, track_id } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message are required.' });
    const safeType = ['info', 'success', 'warning', 'alert'].includes(type) ? type : 'info';
    let query = supabase.from('fellows').select('id').eq('status', 'approved');
    if (track_id) query = query.eq('track_id', track_id);
    const { data: fellows } = await query;

    const notifications = (fellows || []).map(f => ({ fellow_id: f.id, title, message, type: safeType }));
    if (notifications.length) await supabase.from('notifications').insert(notifications);
    res.json({ success: true, sent: notifications.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to broadcast.' });
  }
});

const bcryptCost = 12;

// ─── WEEKLY CHECK-INS ───────────────────────────────────────────────
router.get('/checkins', async (req, res) => {
  try {
    const week = req.query.week && /^\d{4}-\d{2}-\d{2}$/.test(req.query.week) ? req.query.week : weekStart();
    const { data: checkins } = await supabase.from('weekly_checkins')
      .select('*, fellows(full_name, email, fellow_id, profile_photo, tracks(name))')
      .eq('week_start', week)
      .order('needs_help', { ascending: false })
      .order('confidence_rating', { ascending: true });
    const { count: totalApproved } = await supabase.from('fellows').select('id', { count: 'exact', head: true }).eq('status', 'approved');
    res.json({ week_start: week, checkins: checkins || [], total_approved: totalApproved || 0, submitted: (checkins || []).length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load check-ins.' });
  }
});

// Early-warning list: flagged for help this week, low confidence (<=2) this week, or no check-in
// submitted for the last 2 weeks running (among fellows who have submitted at least once before —
// so a brand-new fellow isn't flagged in week one).
router.get('/checkins/warnings', async (req, res) => {
  try {
    const thisWeek = weekStart();
    const lastWeek = weekStart(new Date(Date.now() - 7 * 86400000));

    const { data: thisWeekRows } = await supabase.from('weekly_checkins')
      .select('*, fellows(full_name, email, fellow_id, profile_photo, tracks(name))')
      .eq('week_start', thisWeek);
    const { data: lastWeekRows } = await supabase.from('weekly_checkins').select('fellow_id').eq('week_start', lastWeek);
    const { data: everSubmitted } = await supabase.from('weekly_checkins').select('fellow_id').neq('week_start', thisWeek);

    const submittedThisWeek = new Set((thisWeekRows || []).map(r => r.fellow_id));
    const submittedLastWeek = new Set((lastWeekRows || []).map(r => r.fellow_id));
    const everSubmittedSet = new Set((everSubmitted || []).map(r => r.fellow_id));

    const flaggedHelp = (thisWeekRows || []).filter(r => r.needs_help).map(r => ({ ...r, reason: 'flagged_help' }));
    const lowConfidence = (thisWeekRows || []).filter(r => !r.needs_help && r.confidence_rating <= 2).map(r => ({ ...r, reason: 'low_confidence' }));

    // Missed both this week and last week, but had submitted at some point before that
    const missedIds = [...everSubmittedSet].filter(id => !submittedThisWeek.has(id) && !submittedLastWeek.has(id));
    let missed = [];
    if (missedIds.length) {
      const { data: missedFellows } = await supabase.from('fellows')
        .select('id, full_name, email, fellow_id, profile_photo, tracks(name)')
        .in('id', missedIds.slice(0, 200)).eq('status', 'approved');
      missed = (missedFellows || []).map(f => ({ fellow_id: f.id, fellows: f, reason: 'missed_two_weeks' }));
    }

    res.json({ week_start: thisWeek, flagged_help: flaggedHelp, low_confidence: lowConfidence, missed_checkins: missed });
  } catch (err) {
    console.error('Checkin warnings error:', err);
    res.status(500).json({ error: 'Failed to load early-warning list.' });
  }
});

// ─── MENTORS ────────────────────────────────────────────────────────
router.get('/mentors', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { data: mentors } = await supabase
      .from('mentors')
      .select('id, full_name, email, bio, profile_photo, track_id, is_active, last_login, created_at, tracks(name)')
      .order('created_at', { ascending: false });
    const { data: counts } = await supabase.from('fellows').select('mentor_id').not('mentor_id', 'is', null);
    const tally = {};
    (counts || []).forEach(f => { tally[f.mentor_id] = (tally[f.mentor_id] || 0) + 1; });
    res.json((mentors || []).map(m => ({ ...m, mentee_count: tally[m.id] || 0 })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch mentors.' });
  }
});

router.post('/mentors', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const full_name = String(req.body?.full_name || '').replace(/[<>]/g, '').trim().slice(0, 120);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const { password, track_id } = req.body || {};
    const bio = String(req.body?.bio || '').trim().slice(0, 500) || null;
    if (!full_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid name and email are required.' });
    if (typeof password !== 'string' || password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    if (track_id && !isUuid(track_id)) return res.status(400).json({ error: 'Invalid track.' });

    const password_hash = await bcrypt.hash(password, bcryptCost);
    const { data, error } = await supabase.from('mentors')
      .insert({ full_name, email, password_hash, bio, track_id: track_id || null, is_active: true })
      .select('id, full_name, email, track_id').single();
    if (error) {
      if (String(error.code) === '23505') return res.status(400).json({ error: 'A mentor with that email already exists.' });
      throw error;
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create mentor.' });
  }
});

router.patch('/mentors/:id', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const updates = {};
    if (req.body?.full_name !== undefined) updates.full_name = String(req.body.full_name).replace(/[<>]/g, '').trim().slice(0, 120);
    if (req.body?.bio !== undefined) updates.bio = String(req.body.bio).trim().slice(0, 500) || null;
    if (req.body?.track_id !== undefined) updates.track_id = req.body.track_id && isUuid(req.body.track_id) ? req.body.track_id : null;
    if (req.body?.is_active !== undefined) updates.is_active = !!req.body.is_active;
    if (typeof req.body?.password === 'string' && req.body.password) {
      if (req.body.password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
      updates.password_hash = await bcrypt.hash(req.body.password, bcryptCost);
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });

    const { data, error } = await supabase.from('mentors').update(updates).eq('id', req.params.id)
      .select('id, full_name, email, is_active').single();
    if (error) throw error;
    invalidateUser(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update mentor.' });
  }
});

router.delete('/mentors/:id', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    await supabase.from('mentors').update({ is_active: false }).eq('id', req.params.id);
    invalidateUser(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate mentor.' });
  }
});

// Assign: either { track_id } (bulk — every approved fellow currently on that track) or { fellow_ids: [...] } (individual)
router.post('/mentors/:id/assign', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { track_id, fellow_ids } = req.body || {};
    const { data: mentor } = await supabase.from('mentors').select('id, is_active').eq('id', req.params.id).maybeSingle();
    if (!mentor || !mentor.is_active) return res.status(404).json({ error: 'Mentor not found.' });

    let query = supabase.from('fellows').update({ mentor_id: mentor.id, mentor_assigned_at: new Date().toISOString() });
    if (track_id) {
      if (!isUuid(track_id)) return res.status(400).json({ error: 'Invalid track.' });
      query = query.eq('track_id', track_id).eq('status', 'approved');
    } else if (Array.isArray(fellow_ids) && fellow_ids.length) {
      const ids = fellow_ids.filter(isUuid).slice(0, 500);
      if (!ids.length) return res.status(400).json({ error: 'No valid fellows provided.' });
      query = query.in('id', ids);
    } else {
      return res.status(400).json({ error: 'Provide a track_id or a list of fellow_ids.' });
    }

    const { data, error } = await query.select('id');
    if (error) throw error;
    res.json({ success: true, assigned: data?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign mentor.' });
  }
});

router.post('/mentors/:id/unassign', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { fellow_ids } = req.body || {};
    const ids = Array.isArray(fellow_ids) ? fellow_ids.filter(isUuid).slice(0, 500) : [];
    if (!ids.length) return res.status(400).json({ error: 'Provide a list of fellow_ids.' });
    const { data, error } = await supabase.from('fellows')
      .update({ mentor_id: null, mentor_assigned_at: null })
      .eq('mentor_id', req.params.id).in('id', ids).select('id');
    if (error) throw error;
    res.json({ success: true, unassigned: data?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unassign mentor.' });
  }
});

router.get('/mentors/:id/mentees', requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const { data } = await supabase.from('fellows')
      .select('id, full_name, email, fellow_id, points, profile_photo, status, mentor_assigned_at, tracks(name)')
      .eq('mentor_id', req.params.id)
      .order('full_name');
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch mentees.' });
  }
});

// ─── ADMINS CRUD (super_admin only) ──────────────────────────────────
router.get('/admins', requireRole('super_admin'), async (req, res) => {
  try {
    const { data } = await supabase.from('admins').select('id, full_name, email, role, is_active, last_login, created_at');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

router.post('/admins', requireRole('super_admin'), async (req, res) => {
  try {
    const full_name = String(req.body?.full_name || '').replace(/[<>]/g, '').trim().slice(0, 120);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const { password, role } = req.body || {};
    if (!full_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid name and email are required.' });
    if (typeof password !== 'string' || password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
    if (!['admin', 'moderator', 'super_admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });

    const password_hash = await bcrypt.hash(password, bcryptCost);
    const { data, error } = await supabase.from('admins').insert({ full_name, email, password_hash, role, is_active: true }).select('id, full_name, email, role').single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create admin.' });
  }
});

router.delete('/admins/:id', requireRole('super_admin'), async (req, res) => {
  try {
    if (req.params.id === req.admin.id) return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    await supabase.from('admins').update({ is_active: false }).eq('id', req.params.id);
    invalidateUser(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

module.exports = router;
