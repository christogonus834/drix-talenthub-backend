const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

function generateCertId() {
  const year = new Date().getFullYear();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `DRIX-CERT-${year}-${rand}`;
}

// ── PUBLIC: Verify certificate ────────────────────────────────────────
router.get('/verify/:certId', async (req, res) => {
  try {
    const { data: cert } = await supabase
      .from('certificates')
      .select('*, fellows(full_name, fellow_id, state), tracks(name, icon)')
      .eq('certificate_id', req.params.certId.toUpperCase())
      .single();
    if (!cert) return res.status(404).json({ valid: false, error: 'Certificate not found.' });

    const { data: settings } = await supabase.from('settings').select('*');
    const s = {};
    settings?.forEach(r => s[r.key] = r.value);

    res.json({
      valid: true,
      certificate: {
        certificate_id: cert.certificate_id,
        title: cert.title,
        fellow_name: cert.fellows?.full_name,
        fellow_id: cert.fellows?.fellow_id,
        state: cert.fellows?.state,
        track: cert.tracks?.name,
        grade: cert.grade,
        score: cert.score,
        issued_at: cert.issued_at,
        fellow_photo: cert.fellow_photo || null,
        sig1_name: s.sig1_name || 'Drix Tech Foundation Management',
        sig1_logo: s.sig1_logo || '',
        sig2_name: s.sig2_name || 'ePayBillz Management',
        sig2_logo: s.sig2_logo || '',
      }
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: 'Verification failed.' });
  }
});

// ── FELLOW: Get my certificates ───────────────────────────────────────
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const { data: certs } = await supabase
      .from('certificates')
      .select('*, tracks(name, icon)')
      .eq('fellow_id', req.user.id)
      .order('issued_at', { ascending: false });

    const { data: requests } = await supabase
      .from('certificate_requests')
      .select('*, tracks(name, icon)')
      .eq('fellow_id', req.user.id)
      .order('requested_at', { ascending: false });

    const { data: settings } = await supabase.from('settings').select('*');
    const s = {};
    settings?.forEach(r => s[r.key] = r.value);

    res.json({
      certificates: certs || [],
      requests: requests || [],
      sig1_name: s.sig1_name || 'Drix Tech Foundation Management',
      sig1_logo: s.sig1_logo || '',
      sig2_name: s.sig2_name || 'ePayBillz Management',
      sig2_logo: s.sig2_logo || '',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── FELLOW: Check eligibility (score >= 80%) ──────────────────────────
router.get('/eligibility', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    const { data: fellow } = await supabase
      .from('fellows')
      .select('track_id, tracks(name)')
      .eq('id', fellowId)
      .single();

    if (!fellow?.track_id) return res.json({ eligible: false, reason: 'No track assigned.' });

    // Get all lessons for the track (via modules)
    const { data: modules } = await supabase
      .from('modules')
      .select('id, lessons(id)')
      .eq('track_id', fellow.track_id)
      .eq('is_active', true);

    const allLessonIds = (modules || []).flatMap(m => (m.lessons || []).map(l => l.id));
    const totalLessons = allLessonIds.length;

    if (totalLessons === 0) return res.json({ eligible: false, reason: 'No lessons added to this track yet.' });

    // Get completed lessons
    const { data: progress } = await supabase
      .from('fellow_lesson_progress')
      .select('id')
      .eq('fellow_id', fellowId)
      .eq('completed', true)
      .in('lesson_id', allLessonIds);

    const completedLessons = progress?.length || 0;
    const scorePercent = Math.round((completedLessons / totalLessons) * 100);

    // Check if cert already issued or requested
    const { data: existingCert } = await supabase
      .from('certificates')
      .select('id')
      .eq('fellow_id', fellowId)
      .eq('track_id', fellow.track_id)
      .single();

    const { data: pendingReq } = await supabase
      .from('certificate_requests')
      .select('id, status')
      .eq('fellow_id', fellowId)
      .eq('track_id', fellow.track_id)
      .in('status', ['pending', 'approved'])
      .single();

    res.json({
      eligible: scorePercent >= 80 && !existingCert && !pendingReq,
      score: scorePercent,
      completed: completedLessons,
      total: totalLessons,
      has_certificate: !!existingCert,
      has_pending_request: !!pendingReq,
      pending_status: pendingReq?.status || null,
      track_name: fellow.tracks?.name,
      minimum_score: 80
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check eligibility.' });
  }
});

// ── FELLOW: Request certificate (must have >= 80% score) ─────────────
router.post('/request', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;

    // Use eligibility check logic
    const { data: fellow } = await supabase
      .from('fellows')
      .select('track_id, profile_photo')
      .eq('id', fellowId)
      .single();

    if (!fellow?.track_id) return res.status(400).json({ error: 'No track assigned.' });

    const { data: modules } = await supabase
      .from('modules')
      .select('id, lessons(id)')
      .eq('track_id', fellow.track_id)
      .eq('is_active', true);

    const allLessonIds = (modules || []).flatMap(m => (m.lessons || []).map(l => l.id));
    const totalLessons = allLessonIds.length;

    if (totalLessons === 0) return res.status(400).json({ error: 'No lessons in your track yet.' });

    const { data: progress } = await supabase
      .from('fellow_lesson_progress')
      .select('id')
      .eq('fellow_id', fellowId)
      .eq('completed', true)
      .in('lesson_id', allLessonIds);

    const completedLessons = progress?.length || 0;
    const scorePercent = Math.round((completedLessons / totalLessons) * 100);

    if (scorePercent < 80) {
      return res.status(400).json({
        error: `You need at least 80% completion to request a certificate. Your current score is ${scorePercent}%.`
      });
    }

    // Check no existing cert or pending request
    const { data: existing } = await supabase
      .from('certificates')
      .select('id')
      .eq('fellow_id', fellowId)
      .eq('track_id', fellow.track_id)
      .single();
    if (existing) return res.status(400).json({ error: 'Certificate already issued for this track.' });

    const { data: pending } = await supabase
      .from('certificate_requests')
      .select('id')
      .eq('fellow_id', fellowId)
      .eq('track_id', fellow.track_id)
      .eq('status', 'pending')
      .single();
    if (pending) return res.status(400).json({ error: 'You already have a pending request.' });

    const { error } = await supabase.from('certificate_requests').insert({
      fellow_id: fellowId,
      track_id: fellow.track_id,
      score: scorePercent
    });
    if (error) throw error;

    // Notify admin
    await supabase.from('notifications').insert({
      fellow_id: fellowId,
      title: 'Certificate Request Submitted',
      message: `Your certificate request has been submitted with a score of ${scorePercent}%. Admin will review shortly.`,
      type: 'info'
    }).catch(() => {});

    res.json({ success: true, score: scorePercent, message: `Request submitted! Score: ${scorePercent}%` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit request.' });
  }
});

// ── FELLOW: Enrol in new track after completion ───────────────────────
router.post('/enrol-new-track', authMiddleware, async (req, res) => {
  try {
    const { track_id } = req.body;
    const fellowId = req.user.id;
    if (!track_id) return res.status(400).json({ error: 'Track ID required.' });

    const { data: fellow } = await supabase.from('fellows').select('track_id, cohort_id').eq('id', fellowId).single();

    await supabase.from('fellow_track_history').insert({
      fellow_id: fellowId,
      track_id: fellow.track_id,
      cohort_id: fellow.cohort_id,
      completed: true,
      completed_at: new Date(),
    }).catch(() => {});

    await supabase.from('fellows').update({ track_id }).eq('id', fellowId);
    await supabase.from('fellow_lesson_progress').delete().eq('fellow_id', fellowId);

    res.json({ success: true, message: 'Enrolled in new track!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to switch track.' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════════════════════════════

// ── Admin: All certificate requests with scores ───────────────────────
router.get('/requests/all', adminMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('certificate_requests')
      .select('*, fellows(full_name, fellow_id, profile_photo, tracks(name)), tracks(name, icon)')
      .order('requested_at', { ascending: false });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── Admin: Approve request → auto-issue certificate ───────────────────
router.post('/requests/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const { grade, title } = req.body;
    const { data: reqData } = await supabase
      .from('certificate_requests')
      .select('*, fellows(full_name, profile_photo)')
      .eq('id', req.params.id)
      .single();

    if (!reqData) return res.status(404).json({ error: 'Request not found.' });
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Already reviewed.' });

    const certId = generateCertId();

    const { error: certErr } = await supabase.from('certificates').insert({
      certificate_id: certId,
      fellow_id: reqData.fellow_id,
      track_id: reqData.track_id,
      title: title || 'Certificate of Completion',
      grade: grade || (reqData.score >= 90 ? 'Distinction' : reqData.score >= 80 ? 'Merit' : 'Pass'),
      score: reqData.score,
      fellow_photo: reqData.fellows?.profile_photo || null,
      issued_manually: false,
      issued_at: new Date(),
    });
    if (certErr) throw certErr;

    await supabase.from('certificate_requests')
      .update({ status: 'approved', reviewed_at: new Date(), reviewed_by: req.admin?.id || null })
      .eq('id', req.params.id);

    // Notify fellow
    await supabase.from('notifications').insert({
      fellow_id: reqData.fellow_id,
      title: 'Certificate Approved!',
      message: `Your certificate has been approved and issued. Certificate ID: ${certId}. Visit your certificates page to download it.`,
      type: 'success'
    }).catch(() => {});

    res.json({ success: true, certificate_id: certId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve.' });
  }
});

// ── Admin: Reject request ─────────────────────────────────────────────
router.post('/requests/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const { data: reqData } = await supabase
      .from('certificate_requests').select('fellow_id').eq('id', req.params.id).single();
    if (!reqData) return res.status(404).json({ error: 'Request not found.' });

    await supabase.from('certificate_requests')
      .update({ status: 'rejected', reviewed_at: new Date(), reject_reason: reason || 'Not approved.' })
      .eq('id', req.params.id);

    await supabase.from('notifications').insert({
      fellow_id: reqData.fellow_id,
      title: 'Certificate Request Rejected',
      message: `Your certificate request was not approved. Reason: ${reason || 'Please contact admin.'}`,
      type: 'error'
    }).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── Admin: Manually issue certificate ────────────────────────────────
router.post('/issue', adminMiddleware, async (req, res) => {
  try {
    const { fellow_id, title, grade, track_id } = req.body;
    if (!fellow_id) return res.status(400).json({ error: 'Fellow ID required.' });

    let trackId = track_id;
    if (!trackId) {
      const { data: f } = await supabase.from('fellows').select('track_id').eq('id', fellow_id).single();
      trackId = f?.track_id;
    }

    const certId = generateCertId();
    const { error } = await supabase.from('certificates').insert({
      certificate_id: certId,
      fellow_id,
      track_id: trackId,
      title: title || 'Certificate of Completion',
      grade: grade || 'Pass',
      fellow_photo: req.body.fellow_photo || null,
      issued_manually: true,
      issued_at: new Date(),
    });
    if (error) throw error;

    await supabase.from('notifications').insert({
      fellow_id,
      title: 'Certificate Issued!',
      message: `Admin has issued you a certificate. ID: ${certId}. Visit your certificates page to download it.`,
      type: 'success'
    }).catch(() => {});

    res.json({ success: true, certificate_id: certId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to issue certificate.' });
  }
});

// ── Admin: Get all issued certificates ───────────────────────────────
router.get('/all', adminMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('certificates')
      .select('*, fellows(full_name, fellow_id, profile_photo), tracks(name, icon)')
      .order('issued_at', { ascending: false });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── Admin: Revoke certificate ─────────────────────────────────────────
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    await supabase.from('certificates').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

module.exports = router;
