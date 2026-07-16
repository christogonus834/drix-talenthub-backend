// routes/certificates.js
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
    const { data: cert, error } = await supabase
      .from('certificates')
      .select('*, fellows(full_name, fellow_id, state, tracks(name, icon)), tracks(name, icon)')
      .eq('certificate_id', req.params.certId.toUpperCase())
      .single();

    if (error || !cert) return res.status(404).json({ valid: false, error: 'Certificate not found.' });

    // Get signature settings
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
        track: cert.fellows?.tracks?.name || cert.tracks?.name,
        track_icon: cert.fellows?.tracks?.icon || cert.tracks?.icon,
        grade: cert.grade,
        issued_at: cert.issued_at,
        issued_manually: cert.issued_manually,
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

    // Get settings for signatures
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

// ── FELLOW: Request a certificate (when progress = 100%) ──────────────
router.post('/request', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;

    const { data: fellow } = await supabase
      .from('fellows')
      .select('*, tracks(*)')
      .eq('id', fellowId)
      .single();

    if (!fellow) return res.status(404).json({ error: 'Fellow not found.' });

    // Check 100% progress
    const { data: courses } = await supabase
      .from('courses')
      .select('id')
      .eq('track_id', fellow.track_id)
      .eq('is_active', true);

    const { data: progress } = await supabase
      .from('fellow_progress')
      .select('id')
      .eq('fellow_id', fellowId)
      .eq('completed', true);

    if (!courses?.length || (progress?.length || 0) < courses.length) {
      return res.status(400).json({ error: 'You must complete all courses before requesting a certificate.' });
    }

    // Check no existing approved cert for this track
    const { data: existing } = await supabase
      .from('certificates')
      .select('id')
      .eq('fellow_id', fellowId)
      .eq('track_id', fellow.track_id)
      .single();

    if (existing) return res.status(400).json({ error: 'Certificate already issued for this track.' });

    // Check no pending request
    const { data: pendingReq } = await supabase
      .from('certificate_requests')
      .select('id')
      .eq('fellow_id', fellowId)
      .eq('track_id', fellow.track_id)
      .eq('status', 'pending')
      .single();

    if (pendingReq) return res.status(400).json({ error: 'You already have a pending certificate request.' });

    const { error } = await supabase.from('certificate_requests').insert({
      fellow_id: fellowId,
      track_id: fellow.track_id,
    });

    if (error) throw error;

    // Notify admins via notifications (optional)
    res.json({ success: true, message: 'Certificate request submitted. Admin will review shortly.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit request.' });
  }
});

// ── FELLOW: Enrol in new track (after completing current one) ─────────
router.post('/enrol-new-track', authMiddleware, async (req, res) => {
  try {
    const { track_id } = req.body;
    const fellowId = req.user.id;
    if (!track_id) return res.status(400).json({ error: 'Track ID required.' });

    const { data: fellow } = await supabase.from('fellows').select('track_id, cohort_id').eq('id', fellowId).single();

    // Log old track in history
    await supabase.from('fellow_track_history').insert({
      fellow_id: fellowId,
      track_id: fellow.track_id,
      cohort_id: fellow.cohort_id,
      completed: true,
      completed_at: new Date(),
    }).catch(() => {});

    // Update fellow to new track
    await supabase.from('fellows').update({ track_id }).eq('id', fellowId);

    // Clear old progress so they start fresh
    await supabase.from('fellow_progress').delete().eq('fellow_id', fellowId);

    res.json({ success: true, message: 'You have been enrolled in the new track!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to switch track.' });
  }
});

// ── ADMIN: Get all certificate requests ──────────────────────────────
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

// ── ADMIN: Approve certificate request ───────────────────────────────
router.post('/requests/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const { grade, title } = req.body;
    const { data: reqData, error: reqErr } = await supabase
      .from('certificate_requests')
      .select('*, fellows(full_name, profile_photo, track_id)')
      .eq('id', req.params.id)
      .single();

    if (reqErr || !reqData) return res.status(404).json({ error: 'Request not found.' });
    if (reqData.status !== 'pending') return res.status(400).json({ error: 'Request already reviewed.' });

    const certId = generateCertId();

    const { error: certErr } = await supabase.from('certificates').insert({
      certificate_id: certId,
      fellow_id: reqData.fellow_id,
      track_id: reqData.track_id,
      title: title || 'Certificate of Completion',
      grade: grade || 'Pass',
      fellow_photo: reqData.fellows?.profile_photo || null,
      issued_manually: false,
      issued_at: new Date(),
    });

    if (certErr) throw certErr;

    // Update request status
    await supabase.from('certificate_requests')
      .update({ status: 'approved', reviewed_at: new Date(), reviewed_by: req.admin?.id || null })
      .eq('id', req.params.id);

    // Notify fellow
    await supabase.from('notifications').insert({
      fellow_id: reqData.fellow_id,
      title: '🏆 Certificate Approved!',
      message: `Your certificate request has been approved! Certificate ID: ${certId}. Visit your certificates page to download it.`,
      type: 'success'
    });

    res.json({ success: true, certificate_id: certId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve.' });
  }
});

// ── ADMIN: Reject certificate request ────────────────────────────────
router.post('/requests/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const { data: reqData } = await supabase
      .from('certificate_requests')
      .select('fellow_id')
      .eq('id', req.params.id)
      .single();

    if (!reqData) return res.status(404).json({ error: 'Request not found.' });

    await supabase.from('certificate_requests')
      .update({ status: 'rejected', reviewed_at: new Date(), reject_reason: reason || 'Not approved.' })
      .eq('id', req.params.id);

    await supabase.from('notifications').insert({
      fellow_id: reqData.fellow_id,
      title: '❌ Certificate Request Rejected',
      message: `Your certificate request was not approved. Reason: ${reason || 'Please contact admin.'}`,
      type: 'error'
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject.' });
  }
});

// ── ADMIN: Manually issue certificate ────────────────────────────────
router.post('/issue', adminMiddleware, async (req, res) => {
  try {
    const { fellow_id, title, grade, track_id } = req.body;
    if (!fellow_id) return res.status(400).json({ error: 'Fellow ID required.' });

    let trackId = track_id;
    if (!trackId) {
      const { data: fellow } = await supabase.from('fellows').select('track_id').eq('id', fellow_id).single();
      trackId = fellow?.track_id;
    }

    const certId = generateCertId();

    const { data: cert, error } = await supabase
      .from('certificates')
      .insert({
        certificate_id: certId,
        fellow_id,
        track_id: trackId,
        title: title || 'Certificate of Completion',
        grade: grade || 'Pass',
        fellow_photo: req.body.fellow_photo || null,
        issued_manually: true,
        issued_at: new Date(),
      })
      .select().single();

    if (error) throw error;

    await supabase.from('notifications').insert({
      fellow_id,
      title: '🏆 Certificate Issued!',
      message: `An admin has issued you a certificate. Certificate ID: ${certId}. Visit your certificates page to download it.`,
      type: 'success'
    });

    res.json({ success: true, certificate_id: certId, cert });
  } catch (err) {
    res.status(500).json({ error: 'Failed to issue certificate.' });
  }
});

// ── ADMIN: Get all certificates ───────────────────────────────────────
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

// ── ADMIN: Revoke certificate ─────────────────────────────────────────
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    await supabase.from('certificates').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

module.exports = router;