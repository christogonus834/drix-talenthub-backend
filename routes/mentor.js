// routes/mentor.js — mentor's own dashboard. Every query here is scoped to req.mentor.id so a
// mentor can only ever see or act on their own mentees (fellows.mentor_id = req.mentor.id).
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { mentorMiddleware, invalidateUser } = require('../middleware/auth');
const { safe, cleanText, isUuid } = require('../services/util');
const { addPoints } = require('../services/points');
const { resolveRecipients } = require('../services/recipients');
const { sendToFellow } = require('../services/email');

router.use(mentorMiddleware);

// ── My profile ─────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const { data } = await supabase.from('mentors')
      .select('id, full_name, email, bio, profile_photo, track_id, tracks(name)')
      .eq('id', req.mentor.id).single();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

router.patch('/me', async (req, res) => {
  try {
    const updates = {};
    if (req.body?.bio !== undefined) updates.bio = String(req.body.bio).trim().slice(0, 500) || null;
    if (typeof req.body?.profile_photo === 'string' && req.body.profile_photo.startsWith('data:image/')) {
      updates.profile_photo = req.body.profile_photo;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update.' });
    const { data, error } = await supabase.from('mentors').update(updates).eq('id', req.mentor.id)
      .select('id, full_name, email, bio, profile_photo').single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// ── My mentees ───────────────────────────────────────────────────────
router.get('/mentees', async (req, res) => {
  try {
    const { data } = await supabase.from('fellows')
      .select('id, full_name, email, fellow_id, points, profile_photo, mentor_assigned_at, tracks(name)')
      .eq('mentor_id', req.mentor.id).eq('status', 'approved')
      .order('full_name');
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch mentees.' });
  }
});

// Quick counts for the dashboard header
router.get('/stats', async (req, res) => {
  try {
    const { data: mentees } = await supabase.from('fellows').select('id, points').eq('mentor_id', req.mentor.id).eq('status', 'approved');
    const ids = (mentees || []).map(m => m.id);
    let pending = 0;
    if (ids.length) {
      const { count } = await supabase.from('assignment_submissions').select('id', { count: 'exact', head: true })
        .eq('status', 'submitted').in('fellow_id', ids);
      pending = count || 0;
    }
    res.json({
      mentee_count: ids.length,
      pending_submissions: pending,
      avg_points: ids.length ? Math.round((mentees || []).reduce((s, m) => s + (m.points || 0), 0) / ids.length) : 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats.' });
  }
});

// ── Submissions from my mentees only ─────────────────────────────────
router.get('/submissions', async (req, res) => {
  try {
    const { status } = req.query;
    const { data: mentees } = await supabase.from('fellows').select('id').eq('mentor_id', req.mentor.id);
    const ids = (mentees || []).map(m => m.id);
    if (!ids.length) return res.json([]);

    let q = supabase.from('assignment_submissions')
      .select('*, fellows(full_name, fellow_id, profile_photo), assignments(title, max_score, points_reward)')
      .in('fellow_id', ids)
      .order('submitted_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submissions.' });
  }
});

// ── Grade a mentee's submission (mirrors admin grading; scoped to own mentees) ──
router.patch('/submissions/:id/grade', async (req, res) => {
  try {
    const { decision, feedback } = req.body || {};
    if (!['approved', 'needs_revision'].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'approved' or 'needs_revision'." });
    }

    const { data: sub } = await supabase.from('assignment_submissions')
      .select('*, fellows(mentor_id), assignments(title, max_score, points_reward)').eq('id', req.params.id).single();
    if (!sub) return res.status(404).json({ error: 'Submission not found.' });
    if (sub.fellows?.mentor_id !== req.mentor.id) return res.status(403).json({ error: 'This fellow is not one of your mentees.' });

    const max = sub.assignments?.max_score || 100;
    let grade = req.body.grade;
    if (grade === '' || grade === undefined) grade = null;
    if (grade !== null) {
      grade = Number(grade);
      if (!Number.isFinite(grade) || grade < 0 || grade > max) {
        return res.status(400).json({ error: `Points must be a number between 0 and ${max}.` });
      }
      grade = Math.round(grade);
    }
    if (decision === 'approved' && grade === null) {
      return res.status(400).json({ error: 'Enter the points scored to approve a submission.' });
    }

    const cleanFeedback = feedback ? String(feedback).trim().slice(0, 5000) : null;
    const updates = {
      grade, feedback: cleanFeedback,
      status: decision === 'approved' ? 'graded' : 'returned',
      graded_at: new Date().toISOString(),
      graded_by: req.mentor.id, graded_by_type: 'mentor',
    };

    let awarded = 0;
    if (decision === 'approved' && !(sub.points_awarded > 0)) {
      awarded = sub.assignments?.points_reward || 0;
      if (awarded) updates.points_awarded = awarded;
    }

    const { data, error } = await supabase.from('assignment_submissions')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    if (awarded) await addPoints(sub.fellow_id, awarded);

    await safe(supabase.from('notifications').insert({
      fellow_id: sub.fellow_id,
      title: decision === 'approved' ? 'Assignment approved' : 'Revision needed',
      message: `"${sub.assignments?.title}" was reviewed by your mentor${grade !== null ? ` — ${grade}/${max}` : ''}. ${decision === 'approved' ? 'Well done!' : 'Please revise and resubmit.'}`,
      type: decision === 'approved' ? 'success' : 'warning',
    }), 'notif');

    (async () => {
      const [fellow] = await resolveRecipients({ actorId: req.mentor.id, actorType: 'mentor', fellowIds: [sub.fellow_id], respectPrefs: true });
      if (fellow) {
        await sendToFellow('assignment_graded', fellow, {
          assignmentTitle: sub.assignments?.title, grade, maxScore: max,
          approved: decision === 'approved', feedback: cleanFeedback,
        });
      }
    })().catch(e => console.error('[mentor grade email]', e.message));

    res.json({ success: true, submission: data, points_awarded: awarded });
  } catch (err) {
    console.error('Mentor grade error:', err);
    res.status(500).json({ error: 'Failed to save review.' });
  }
});

// ── Messages from my mentees ─────────────────────────────────────────
router.get('/messages', async (req, res) => {
  try {
    const { data } = await supabase.from('messages')
      .select('*, fellows(full_name, email, profile_photo, fellow_id), message_replies(*)')
      .eq('mentor_id', req.mentor.id).eq('recipient_type', 'mentor')
      .order('sent_at', { ascending: false });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load messages.' });
  }
});

router.post('/messages/:messageId/reply', async (req, res) => {
  try {
    const reply = String(req.body?.reply || '').trim().slice(0, 5000);
    if (!reply) return res.status(400).json({ error: 'Reply is required.' });

    const { data: msg } = await supabase.from('messages')
      .select('fellow_id, mentor_id, subject').eq('id', req.params.messageId).single();
    if (!msg || msg.mentor_id !== req.mentor.id) return res.status(404).json({ error: 'Message not found.' });

    const { data, error } = await supabase.from('message_replies').insert({
      message_id: req.params.messageId, mentor_id: req.mentor.id, reply, replied_at: new Date(),
    }).select().single();
    if (error) throw error;

    await supabase.from('messages').update({ status: 'replied' }).eq('id', req.params.messageId);

    await safe(supabase.from('notifications').insert({
      fellow_id: msg.fellow_id, title: 'Your mentor replied to your message',
      message: 'Your mentor has replied. Check your inbox.', type: 'info',
    }), 'notif');

    (async () => {
      const [fellow] = await resolveRecipients({ actorId: req.mentor.id, actorType: 'mentor', fellowIds: [msg.fellow_id], respectPrefs: true });
      if (fellow) await sendToFellow('message_reply', fellow, { reply, fromMentor: true });
    })().catch(e => console.error('[mentor reply email]', e.message));

    res.json({ success: true, reply: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send reply.' });
  }
});

// ── Post an announcement to my mentees only ──────────────────────────
router.post('/announcements', async (req, res) => {
  try {
    const title = cleanText(req.body?.title, 200);
    const content = req.body?.content ? String(req.body.content).slice(0, 10000) : null;
    if (!title) return res.status(400).json({ error: 'Title is required.' });

    const { data: ann, error } = await supabase.from('announcements').insert({
      title, content, audience: 'all',
      posted_by: req.mentor.id, posted_by_type: 'mentor',
      send_email: req.body?.send_email !== false, is_active: true,
    }).select().single();
    if (error) throw error;

    let emailing = 0;
    if (ann.send_email) {
      const recipients = await resolveRecipients({ actorId: req.mentor.id, actorType: 'mentor', respectPrefs: true });
      emailing = recipients.length;
      const { sendBulk } = require('../services/email');
      sendBulk('announcement', recipients, { title, content })
        .then(r => supabase.from('announcements').update({ emailed_count: r.sent, emailed_at: new Date().toISOString() }).eq('id', ann.id))
        .catch(e => console.error('[mentor announcement email]', e.message));
    }

    res.json({ success: true, announcement: ann, emailing });
  } catch (err) {
    res.status(500).json({ error: 'Failed to post announcement.' });
  }
});

module.exports = router;
