// routes/capstone.js — one capstone project per fellow per track. Gates certificate eligibility
// (see services/progress.js). GitHub metadata is informational-only, fetched fire-and-forget —
// it never blocks or affects a submission, grading is always a human judgment call.
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware, adminMiddleware, requireRole, invalidateUser } = require('../middleware/auth');
const { cleanText, isUuid, safe } = require('../services/util');
const { addPoints } = require('../services/points');
const { resolveRecipients } = require('../services/recipients');
const { sendToFellow } = require('../services/email');
const { isTrackComplete } = require('../services/progress');

const _fetch = globalThis.fetch || require('node-fetch');
const GITHUB_RE = /^https?:\/\/(www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/i;

function computeGrade(total) {
  if (total >= 90) return 'Distinction';
  if (total >= 75) return 'Merit';
  if (total >= 50) return 'Pass';
  return null;
}

const HTTP_URL_RE = /^https?:\/\/[^\s]+$/i;

function validateForType(type, body) {
  const repo_url = body.repo_url ? String(body.repo_url).trim() : null;
  const live_url = body.live_url ? String(body.live_url).trim() : null;
  const video_url = body.video_url ? String(body.video_url).trim() : null;

  // Every link must be a plain http(s) URL — blocks javascript:/data: links that would run
  // script when an admin (or visitor on the public showcase) clicks them.
  for (const [label, url] of [['GitHub repo', repo_url], ['Live/portfolio', live_url], ['Video', video_url]]) {
    if (url && (url.length > 500 || !HTTP_URL_RE.test(url))) {
      return { error: `${label} link must be a valid web address starting with http:// or https://` };
    }
  }

  if (type === 'code') {
    if (!repo_url) return { error: 'A GitHub repo link is required for this track.' };
    if (!GITHUB_RE.test(repo_url)) return { error: "That doesn't look like a valid GitHub repository link (e.g. https://github.com/owner/repo)." };
  } else if (type === 'design') {
    if (!live_url) return { error: 'A portfolio/design link is required for this track.' };
  } else if (type === 'document') {
    if (!live_url) return { error: 'A report/case-study link is required for this track.' };
  }
  return { repo_url, live_url, video_url };
}

// Fire-and-forget — called without awaiting from the submit route. A private repo, malformed
// link, or GitHub rate-limit just leaves these fields blank; never touches submission status.
// Commit count/first-commit-date are best-effort estimates for repos over 100 commits (avoids
// paginating through potentially thousands of commits for a purely informational field).
async function fetchGithubMetadata(submissionId, owner, repo) {
  try {
    const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'drix-tech-talent' };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;

    const repoRes = await _fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoRes.ok) return;
    const repoData = await repoRes.json();

    const commitsRes = await _fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=100`, { headers });
    let commitCount = null, firstCommitAt = null, lastCommitAt = null;
    if (commitsRes.ok) {
      const commits = await commitsRes.json();
      if (Array.isArray(commits) && commits.length) {
        lastCommitAt = commits[0]?.commit?.author?.date || null;
        firstCommitAt = commits[commits.length - 1]?.commit?.author?.date || null;
        const link = commitsRes.headers.get('link') || '';
        const m = /page=(\d+)>;\s*rel="last"/.exec(link);
        commitCount = m ? (parseInt(m[1], 10) - 1) * 100 + commits.length : commits.length;
      }
    }

    await supabase.from('capstone_submissions').update({
      gh_commit_count: commitCount, gh_first_commit_at: firstCommitAt, gh_last_commit_at: lastCommitAt,
      gh_primary_language: repoData.language || null, gh_fetched_at: new Date().toISOString(),
    }).eq('id', submissionId);
  } catch (e) {
    console.error('[capstone] GitHub metadata fetch failed:', e.message); // never surfaced to the fellow
  }
}

const GENERIC_BRIEF = "Build a project that showcases what you've learned in this track. Be creative — there's no single right answer, just make it genuinely yours.";

// ORDER MATTERS: Express matches routes top-to-bottom, and the fellow route below is GET '/:trackId'.
// Any static single-segment GET (like /showcase) must be registered BEFORE it or it gets swallowed.
// ══════════════════════════════════════════════════════════════════════
// PUBLIC — no auth
// ══════════════════════════════════════════════════════════════════════
router.get('/showcase', async (req, res) => {
  try {
    const { track_id, page = 1, limit = 24 } = req.query;
    let q = supabase.from('capstone_submissions')
      .select('id, title, description, repo_url, live_url, video_url, grade, total_score, submitted_at, graded_at, fellows(full_name, profile_photo), tracks(name)', { count: 'exact' })
      .eq('status', 'graded').eq('is_public', true)
      .order('graded_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (track_id) q = q.eq('track_id', track_id);

    const { data, error, count } = await q;
    if (error) throw error;
    res.json({ data: data || [], count: count || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load showcase.' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// FELLOW ROUTES
// ══════════════════════════════════════════════════════════════════════
router.get('/:trackId', authMiddleware, async (req, res) => {
  try {
    const trackId = req.params.trackId;
    if (!isUuid(trackId)) return res.status(400).json({ error: 'Invalid track.' });

    const { data: fellow } = await supabase.from('fellows').select('track_id').eq('id', req.user.id).single();
    // NB: never 401/403 here — the frontend api helper treats those as "session expired" and logs the fellow out.
    if (fellow?.track_id !== trackId) return res.status(400).json({ error: 'This is not your track.' });

    const complete = await isTrackComplete(req.user.id, trackId);
    // A not-yet-unlocked capstone is a normal state, not an auth failure — 200 + locked flag.
    if (!complete) return res.json({ locked: true, message: 'Complete all modules and the track exam to unlock the capstone.' });

    const { data: cfg } = await supabase.from('capstones').select('*').eq('track_id', trackId).eq('is_active', true).maybeSingle();
    const { data: submission } = await supabase.from('capstone_submissions').select('*').eq('fellow_id', req.user.id).eq('track_id', trackId).maybeSingle();

    res.json({
      brief: cfg?.brief || GENERIC_BRIEF,
      capstone_type: cfg?.capstone_type || 'code',
      points_reward: cfg?.points_reward ?? 100,
      submission: submission || null,
    });
  } catch (err) {
    console.error('Capstone fetch error:', err);
    res.status(500).json({ error: 'Failed to load capstone.' });
  }
});

router.post('/submit', authMiddleware, async (req, res) => {
  try {
    const { data: fellow } = await supabase.from('fellows').select('track_id').eq('id', req.user.id).single();
    if (!fellow?.track_id) return res.status(400).json({ error: 'No track assigned.' });

    const complete = await isTrackComplete(req.user.id, fellow.track_id);
    if (!complete) return res.status(400).json({ error: 'Complete all modules and the track exam before submitting your capstone.' });

    const { data: cfg } = await supabase.from('capstones').select('*').eq('track_id', fellow.track_id).eq('is_active', true).maybeSingle();
    const type = cfg?.capstone_type || 'code';

    const title = cleanText(req.body?.title, 200);
    if (!title) return res.status(400).json({ error: 'A project title is required.' });
    const description = req.body?.description ? String(req.body.description).slice(0, 5000) : null;

    const validated = validateForType(type, req.body || {});
    if (validated.error) return res.status(400).json({ error: validated.error });
    const { repo_url, live_url, video_url } = validated;

    const { data: submission, error } = await supabase.from('capstone_submissions')
      .upsert({
        track_id: fellow.track_id, fellow_id: req.user.id, title, description, repo_url, live_url, video_url,
        status: 'submitted',
        score_functionality: null, score_technical: null, score_presentation: null, score_originality: null,
        total_score: null, grade: null, feedback: null,
        gh_commit_count: null, gh_first_commit_at: null, gh_last_commit_at: null, gh_primary_language: null, gh_fetched_at: null,
        graded_by: null, graded_at: null,
        submitted_at: new Date().toISOString(),
      }, { onConflict: 'track_id,fellow_id' })
      .select().single();
    if (error) throw error;

    res.json({ success: true, submission });

    // Fire-and-forget — response already sent, this continues in the background.
    if (type === 'code' && repo_url) {
      const m = GITHUB_RE.exec(repo_url);
      if (m) fetchGithubMetadata(submission.id, m[2], m[3]).catch(() => {});
    }
  } catch (err) {
    console.error('Capstone submit error:', err);
    res.status(500).json({ error: 'Failed to submit your capstone.' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════════════════════════════
router.get('/admin/brief/:trackId', adminMiddleware, async (req, res) => {
  try {
    if (!isUuid(req.params.trackId)) return res.status(400).json({ error: 'Invalid track.' });
    const { data } = await supabase.from('capstones').select('*').eq('track_id', req.params.trackId).maybeSingle();
    res.json(data || { track_id: req.params.trackId, brief: null, points_reward: 100, capstone_type: 'code', is_active: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load brief.' });
  }
});

router.post('/admin/brief/:trackId', adminMiddleware, requireRole('admin', 'super_admin'), async (req, res) => {
  try {
    const trackId = req.params.trackId;
    if (!isUuid(trackId)) return res.status(400).json({ error: 'Invalid track.' });

    const capstone_type = ['code', 'design', 'document'].includes(req.body?.capstone_type) ? req.body.capstone_type : 'code';
    const points_reward = Number.isFinite(Number(req.body?.points_reward)) ? Math.max(0, Math.min(1000, Math.round(Number(req.body.points_reward)))) : 100;
    const brief = req.body?.brief ? String(req.body.brief).slice(0, 5000) : null;

    const { data, error } = await supabase.from('capstones')
      .upsert({ track_id: trackId, brief, points_reward, capstone_type, is_active: true, updated_at: new Date().toISOString() }, { onConflict: 'track_id' })
      .select().single();
    if (error) throw error;
    res.json({ success: true, capstone: data });
  } catch (err) {
    console.error('Capstone brief save error:', err);
    res.status(500).json({ error: 'Failed to save brief.' });
  }
});

router.get('/admin/submissions', adminMiddleware, async (req, res) => {
  try {
    const { status, track_id, page = 1, limit = 20 } = req.query;
    let q = supabase.from('capstone_submissions')
      .select('*, fellows(full_name, email, fellow_id, profile_photo), tracks(name)', { count: 'exact' })
      .order('submitted_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);
    if (status === 'ungraded') q = q.eq('status', 'submitted');
    else if (status === 'graded') q = q.eq('status', 'graded');
    else if (status) q = q.eq('status', status);
    if (track_id) q = q.eq('track_id', track_id);

    const { data, error, count } = await q;
    if (error) throw error;
    res.json({ data: data || [], count: count || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submissions.' });
  }
});

router.patch('/admin/:id/grade', adminMiddleware, async (req, res) => {
  try {
    const { scores, decision, feedback } = req.body || {};
    if (!['approved', 'needs_revision'].includes(decision)) return res.status(400).json({ error: "decision must be 'approved' or 'needs_revision'." });

    const { data: sub } = await supabase.from('capstone_submissions').select('*').eq('id', req.params.id).single();
    if (!sub) return res.status(404).json({ error: 'Submission not found.' });

    const s = {};
    for (const key of ['functionality', 'technical', 'presentation', 'originality']) {
      const v = Number(scores?.[key]);
      if (!Number.isFinite(v) || v < 0 || v > 25) return res.status(400).json({ error: `${key} score must be between 0 and 25.` });
      s[key] = Math.round(v);
    }
    const total = s.functionality + s.technical + s.presentation + s.originality;
    const grade = computeGrade(total);
    const cleanFeedback = feedback ? String(feedback).trim().slice(0, 5000) : null;

    const updates = {
      score_functionality: s.functionality, score_technical: s.technical, score_presentation: s.presentation, score_originality: s.originality,
      total_score: total, grade,
      feedback: cleanFeedback,
      status: decision === 'approved' && total >= 50 ? 'graded' : 'returned',
      is_public: decision === 'approved' && total >= 50 ? true : sub.is_public,
      graded_at: new Date().toISOString(),
      graded_by: req.admin.id, graded_by_type: 'admin',
    };

    let awarded = 0;
    if (updates.status === 'graded' && !(sub.points_awarded > 0)) {
      const { data: cfg } = await supabase.from('capstones').select('points_reward').eq('track_id', sub.track_id).maybeSingle();
      awarded = cfg?.points_reward ?? 100;
      if (awarded) updates.points_awarded = awarded;
    }

    const { data, error } = await supabase.from('capstone_submissions').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    if (awarded) await addPoints(sub.fellow_id, awarded);

    await safe(supabase.from('notifications').insert({
      fellow_id: sub.fellow_id,
      title: updates.status === 'graded' ? 'Capstone approved!' : 'Capstone needs revision',
      message: updates.status === 'graded'
        ? `Your capstone "${sub.title}" was approved — ${grade} (${total}/100)!`
        : `Your capstone "${sub.title}" needs revision before it can be approved.`,
      type: updates.status === 'graded' ? 'success' : 'warning',
    }), 'notif');

    (async () => {
      const [fellow] = await resolveRecipients({ actorId: req.admin.id, actorType: 'admin', fellowIds: [sub.fellow_id], respectPrefs: true });
      if (fellow) {
        await sendToFellow('capstone_graded', fellow, {
          title: sub.title, grade, totalScore: total,
          approved: updates.status === 'graded', feedback: cleanFeedback,
        });
      }
    })().catch(e => console.error('[capstone grade email]', e.message));

    res.json({ success: true, submission: data, points_awarded: awarded });
  } catch (err) {
    console.error('Capstone grade error:', err);
    res.status(500).json({ error: 'Failed to save review.' });
  }
});

router.patch('/admin/:id/visibility', adminMiddleware, async (req, res) => {
  try {
    const is_public = !!req.body?.is_public;
    const { data, error } = await supabase.from('capstone_submissions').update({ is_public }).eq('id', req.params.id).select('id, is_public').single();
    if (error) throw error;
    res.json({ success: true, is_public: data.is_public });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update visibility.' });
  }
});

module.exports = router;
module.exports._test = { computeGrade, validateForType, fetchGithubMetadata, GITHUB_RE };
