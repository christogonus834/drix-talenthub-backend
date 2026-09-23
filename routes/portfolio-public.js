// routes/portfolio-public.js — public-facing, read-only. No auth: this is meant to be shared with
// employers. Only returns data for fellows who have explicitly opted in (portfolio_public = true),
// and only submissions they've individually marked is_public = true.
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');

router.get('/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').toLowerCase().trim().slice(0, 60);
    if (!slug) return res.status(404).json({ error: 'Not found.' });

    const { data: fellow } = await supabase.from('fellows')
      .select('id, full_name, profile_photo, points, portfolio_public, tracks(name)')
      .eq('portfolio_slug', slug).eq('portfolio_public', true).eq('status', 'approved').maybeSingle();
    if (!fellow) return res.status(404).json({ error: 'This portfolio is not available.' });

    const { data: submissions } = await supabase.from('assignment_submissions')
      .select('content, file_url, grade, feedback, submitted_at, assignments(title, max_score)')
      .eq('fellow_id', fellow.id).eq('status', 'graded').eq('is_public', true)
      .order('submitted_at', { ascending: false });

    res.json({
      full_name: fellow.full_name, profile_photo: fellow.profile_photo,
      track: fellow.tracks?.name || null, points: fellow.points || 0,
      submissions: submissions || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load portfolio.' });
  }
});

module.exports = router;
