const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware } = require('../middleware/auth');

// Get fellow profile + dashboard data
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { data: fellow } = await supabase
      .from('fellows')
      .select('*, tracks(*), cohorts(*)')
      .eq('id', req.user.id)
      .single();

    const { data: progress } = await supabase
      .from('fellow_progress')
      .select('*, courses(*)')
      .eq('fellow_id', req.user.id);

    const { data: notifications } = await supabase
      .from('notifications')
      .select('*')
      .eq('fellow_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    const { data: results } = await supabase
      .from('assessment_results')
      .select('*, assessments(title)')
      .eq('fellow_id', req.user.id)
      .order('taken_at', { ascending: false });

    res.json({ fellow, progress, notifications, results });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch data.' });
  }
});

// Get leaderboard
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

// Get community posts
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

// Create community post
router.post('/community', authMiddleware, async (req, res) => {
  try {
    const { title, content, category } = req.body;
    const { data, error } = await supabase
      .from('community_posts')
      .insert({ fellow_id: req.user.id, title, content, category })
      .select()
      .single();
    if (error) throw error;

    // Points for posting
    await supabase.rpc('increment_points', { fellow_id: req.user.id, points: 5 }).catch(() => {});
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create post.' });
  }
});

// Get courses for fellow's track
router.get('/courses', authMiddleware, async (req, res) => {
  try {
    const { data: fellow } = await supabase
      .from('fellows')
      .select('track_id')
      .eq('id', req.user.id)
      .single();

    const { data: courses } = await supabase
      .from('courses')
      .select('*')
      .eq('track_id', fellow.track_id)
      .eq('is_active', true)
      .order('order_index');

    const { data: progress } = await supabase
      .from('fellow_progress')
      .select('*')
      .eq('fellow_id', req.user.id);

    const progressMap = {};
    progress?.forEach(p => { progressMap[p.course_id] = p; });

    res.json(courses?.map(c => ({ ...c, progress: progressMap[c.id] || null })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch courses.' });
  }
});

// Mark course complete
router.post('/courses/:id/complete', authMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('fellow_progress')
      .upsert({
        fellow_id: req.user.id,
        course_id: req.params.id,
        completed: true,
        completed_at: new Date()
      })
      .select()
      .single();

    // Award points
    await supabase
      .from('fellows')
      .update({ points: supabase.raw('points + 10') })
      .eq('id', req.user.id)
      .catch(() => {});

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark complete.' });
  }
});

// Mark notification read
router.patch('/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('fellow_id', req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// Upload profile photo (base64)
router.post('/upload-photo', authMiddleware, async (req, res) => {
  try {
    const { photo_base64 } = req.body;
    if (!photo_base64) return res.status(400).json({ error: 'No photo provided.' });
    // Store base64 directly in profile_photo field (or use Supabase Storage)
    const { data, error } = await supabase
      .from('fellows')
      .update({ profile_photo: photo_base64 })
      .eq('id', req.user.id)
      .select('profile_photo')
      .single();
    if (error) throw error;
    res.json({ success: true, profile_photo: data.profile_photo });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload photo.' });
  }
});

// PUBLIC: Get all active tracks (for registration dropdown - no auth needed)
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

// Get settings (for adsense etc)
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

module.exports = router;
