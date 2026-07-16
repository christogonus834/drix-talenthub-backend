const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { adminMiddleware } = require('../middleware/auth');

// Add this BEFORE the router.use(adminMiddleware) line in routes/admin.js
router.get('/settings/public', async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('*');
    const s = {};
    data?.forEach(row => s[row.key] = row.value);
    res.json(s);
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
      .select('*, tracks(name), cohorts(name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (status) query = query.eq('status', status);
    if (track_id) query = query.eq('track_id', track_id);
    if (cohort_id) query = query.eq('cohort_id', cohort_id);
    if (search) query = query.ilike('full_name', `%${search}%`);

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
      .select('*, tracks(*), cohorts(*)')
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

    const updateData = { status };
    if (status === 'approved') updateData.approved_at = new Date();

    const { data, error } = await supabase
      .from('fellows')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // Notify fellow
    const messages = {
      approved: { title: '🎉 Application Approved!', message: 'Congratulations! Your application has been approved. You can now access your dashboard.', type: 'success' },
      rejected: { title: 'Application Update', message: 'Unfortunately, your application was not approved at this time.', type: 'warning' },
      suspended: { title: 'Account Suspended', message: 'Your account has been suspended. Please contact support.', type: 'alert' },
    };

    if (messages[status]) {
      await supabase.from('notifications').insert({ fellow_id: req.params.id, ...messages[status] });
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
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update fellow.' });
  }
});

router.delete('/fellows/:id', async (req, res) => {
  try {
    await supabase.from('fellows').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete fellow.' });
  }
});

// Bulk approve
router.post('/fellows/bulk-approve', async (req, res) => {
  try {
    const { ids } = req.body;
    await supabase.from('fellows').update({ status: 'approved', approved_at: new Date() }).in('id', ids);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
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

// ─── SETTINGS ────────────────────────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('*');
    const map = {};
    data?.forEach(s => { map[s.key] = s.value; });
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

router.patch('/settings', adminMiddleware, async (req, res) => {
  try {
    const updates = req.body;
    const promises = Object.entries(updates).map(([key, value]) =>
      supabase
        .from('settings')
        .upsert({ key, value: String(value), updated_at: new Date() }, { onConflict: 'key' })
    );
    await Promise.all(promises);
    res.json({ success: true });
  } catch (err) {
    console.error('Settings save error:', err);
    res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// ─── NOTIFICATIONS (broadcast) ───────────────────────────────────────
router.post('/notifications/broadcast', async (req, res) => {
  try {
    const { title, message, type, track_id } = req.body;
    let query = supabase.from('fellows').select('id').eq('status', 'approved');
    if (track_id) query = query.eq('track_id', track_id);
    const { data: fellows } = await query;

    const notifications = fellows.map(f => ({ fellow_id: f.id, title, message, type: type || 'info' }));
    await supabase.from('notifications').insert(notifications);
    res.json({ success: true, sent: notifications.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to broadcast.' });
  }
});

// ─── ADMINS CRUD (super_admin only) ──────────────────────────────────
router.get('/admins', async (req, res) => {
  if (req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
  try {
    const { data } = await supabase.from('admins').select('id, full_name, email, role, is_active, last_login, created_at');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

router.post('/admins', async (req, res) => {
  if (req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
  try {
    const { full_name, email, password, role } = req.body;
    const password_hash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase.from('admins').insert({ full_name, email, password_hash, role }).select('id, full_name, email, role').single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create admin.' });
  }
});

router.delete('/admins/:id', async (req, res) => {
  if (req.admin.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
  try {
    await supabase.from('admins').update({ is_active: false }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});
module.exports = router;
