const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const crypto = require('crypto');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { safe, getSettings } = require('../services/util');
const { getEligibility } = require('../services/progress');
const { sendToFellow } = require('../services/email');

function generateCertId() {
  const year = new Date().getFullYear();
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
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

    const s = await getSettings();

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

    const s = await getSettings();

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

// ── FELLOW: Check eligibility (>= 80% lessons AND track exam passed, if the track has one) ──
router.get('/eligibility', authMiddleware, async (req, res) => {
  try {
    res.json(await getEligibility(req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check eligibility.' });
  }
});

// ── FELLOW: Request certificate ───────────────────────────────────────
router.post('/request', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    const el = await getEligibility(fellowId);

    if (!el.track_id) return res.status(400).json({ error: el.reason || 'No track assigned.' });
    if (el.has_certificate) return res.status(400).json({ error: 'Certificate already issued for this track.' });
    if (el.has_pending_request) return res.status(400).json({ error: 'You already have a pending request.' });
    if (!el.eligible) {
      return res.status(400).json({
        error: el.reason
          ? `${el.reason} Your lesson completion is ${el.score ?? 0}%.`
          : 'You are not eligible for a certificate yet.'
      });
    }

    const { error } = await supabase.from('certificate_requests').insert({
      fellow_id: fellowId, track_id: el.track_id, score: el.score
    });
    if (error) throw error;

    await safe(supabase.from('notifications').insert({
      fellow_id: fellowId,
      title: 'Certificate Request Submitted',
      message: `Your certificate request has been submitted with a score of ${el.score}%. Admin will review shortly.`,
      type: 'info'
    }), 'notif');

    res.json({ success: true, score: el.score, message: `Request submitted! Score: ${el.score}%` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit request.' });
  }
});

// ── FELLOW: Enrol in new track (only after being certified in the current one) ──
router.post('/enrol-new-track', authMiddleware, async (req, res) => {
  try {
    const { track_id } = req.body;
    const fellowId = req.user.id;
    if (!track_id) return res.status(400).json({ error: 'Track ID required.' });

    const { data: fellow } = await supabase.from('fellows').select('track_id, cohort_id').eq('id', fellowId).single();
    if (!fellow) return res.status(404).json({ error: 'Fellow not found.' });
    if (fellow.track_id === track_id) return res.status(400).json({ error: 'You are already on this track.' });

    const { data: certs } = await supabase.from('certificates').select('id')
      .eq('fellow_id', fellowId).eq('track_id', fellow.track_id).limit(1);
    if (!certs?.length) return res.status(400).json({ error: 'Complete and earn your certificate on the current track before switching.' });

    const { data: track } = await supabase.from('tracks').select('id').eq('id', track_id).eq('is_active', true).maybeSingle();
    if (!track) return res.status(400).json({ error: 'That track is not available.' });

    await safe(supabase.from('fellow_track_history').insert({
      fellow_id: fellowId, track_id: fellow.track_id, cohort_id: fellow.cohort_id,
      completed: true, completed_at: new Date(),
    }), 'history');

    await supabase.from('fellows').update({ track_id }).eq('id', fellowId);

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
      .select('*, fellows(id, full_name, email, profile_photo)')
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
    await safe(supabase.from('notifications').insert({
      fellow_id: reqData.fellow_id,
      title: 'Certificate Approved!',
      message: `Your certificate has been approved and issued. Certificate ID: ${certId}. Visit your certificates page to download it.`,
      type: 'success'
    }), 'notif');

    // account email — always sent
    if (reqData.fellows?.email) sendToFellow('certificate_ready', reqData.fellows, { certId }).catch(() => {});

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

    await safe(supabase.from('notifications').insert({
      fellow_id: reqData.fellow_id,
      title: 'Certificate Request Rejected',
      message: `Your certificate request was not approved. Reason: ${reason || 'Please contact admin.'}`,
      type: 'alert'
    }), 'notif');

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

    await safe(supabase.from('notifications').insert({
      fellow_id,
      title: 'Certificate Issued!',
      message: `Admin has issued you a certificate. ID: ${certId}. Visit your certificates page to download it.`,
      type: 'success'
    }), 'notif');

    (async () => {
      const { data: f } = await supabase.from('fellows').select('id, full_name, email').eq('id', fellow_id).single();
      if (f) await sendToFellow('certificate_ready', f, { certId });
    })().catch(() => {});

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
