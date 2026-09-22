// routes/modules.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { safe, parseDate, isUuid } = require('../services/util');
const { addPoints } = require('../services/points');
const { resolveRecipients } = require('../services/recipients');
const { sendToFellow } = require('../services/email');
const {
  lockInfo, assignmentDeadline, canAccessTrack, loadAccessibleModule, processDueUnlocks,
} = require('../services/progress');

const EXAM_MAX_ATTEMPTS = parseInt(process.env.EXAM_MAX_ATTEMPTS || '3', 10); // 0 = unlimited
const EXAM_GRACE_SECONDS = 90;

// ══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — must be BEFORE wildcard /:moduleId
// ══════════════════════════════════════════════════════════════════════

// ── Admin: Get all modules for a track (with computed lock state) ────
router.get('/admin/track/:trackId', adminMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('modules')
      .select('*, lessons(*), assignments(*, assignment_submissions(id, grade, status))')
      .eq('track_id', req.params.trackId)
      .order('order_index');
    const now = new Date();
    res.json((data || []).map(m => ({ ...m, ...lockInfo(m, now) })));
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── Admin: Create module ──────────────────────────────────────────────
router.post('/admin/module', adminMiddleware, async (req, res) => {
  try {
    const { track_id, title, description, order_index } = req.body;
    if (!track_id || !title) return res.status(400).json({ error: 'track_id and title are required.' });
    const unlock_at = parseDate(req.body.unlock_at);
    const deadline_at = parseDate(req.body.deadline_at);
    if (unlock_at && deadline_at && new Date(deadline_at) <= new Date(unlock_at)) {
      return res.status(400).json({ error: 'Deadline must be after the unlock date.' });
    }
    const { data, error } = await supabase.from('modules').insert({
      track_id, title, description, order_index: order_index || 0, is_active: true,
      unlock_at: unlock_at || null, deadline_at: deadline_at || null,
      manual_lock: req.body.manual_lock === true,
    }).select().single();
    if (error) throw error;
    res.json({ success: true, module: data });
  } catch(err) {
    console.error('Create module error:', err);
    res.status(500).json({ error: err.message || 'Failed to create module.' });
  }
});

// ── Admin: Update module (whitelisted fields only) ───────────────────
router.patch('/admin/module/:id', adminMiddleware, async (req, res) => {
  try {
    const b = req.body || {};
    const updates = {};
    ['title', 'description', 'order_index', 'is_active'].forEach(k => { if (b[k] !== undefined) updates[k] = b[k]; });
    if (b.manual_lock !== undefined) updates.manual_lock = b.manual_lock === true;

    const { data: current } = await supabase.from('modules').select('unlock_at, deadline_at').eq('id', req.params.id).single();
    if (!current) return res.status(404).json({ error: 'Module not found.' });

    const unlock = parseDate(b.unlock_at);
    const deadline = parseDate(b.deadline_at);
    if (b.unlock_at !== undefined && unlock === undefined) return res.status(400).json({ error: 'Invalid unlock date.' });
    if (b.deadline_at !== undefined && deadline === undefined) return res.status(400).json({ error: 'Invalid deadline.' });

    if (unlock !== undefined) {
      updates.unlock_at = unlock;
      updates.unlock_email_sent = false; // schedule changed → the unlock email is due again
    }
    if (deadline !== undefined) updates.deadline_at = deadline;

    const effUnlock = unlock !== undefined ? unlock : current.unlock_at;
    const effDeadline = deadline !== undefined ? deadline : current.deadline_at;
    if (effUnlock && effDeadline && new Date(effDeadline) <= new Date(effUnlock)) {
      return res.status(400).json({ error: 'Deadline must be after the unlock date.' });
    }

    const { data, error } = await supabase.from('modules').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, module: { ...data, ...lockInfo(data) } });
  } catch(err) {
    res.status(500).json({ error: err.message || 'Failed to update module.' });
  }
});

// ── Admin: force-lock / force-unlock ─────────────────────────────────
// locked:true  → manual_lock on (stays locked regardless of date)
// locked:false → manual_lock off AND, if a future unlock date exists, the module opens now
router.post('/admin/module/:id/lock', adminMiddleware, async (req, res) => {
  try {
    const locked = req.body?.locked === true;
    const { data: m } = await supabase.from('modules').select('unlock_at').eq('id', req.params.id).single();
    if (!m) return res.status(404).json({ error: 'Module not found.' });

    const updates = { manual_lock: locked };
    if (!locked && m.unlock_at && new Date(m.unlock_at) > new Date()) {
      updates.unlock_at = new Date().toISOString(); // override the schedule: open now
      updates.unlock_email_sent = false;            // fellows get the unlock email on the next request
    }
    const { data, error } = await supabase.from('modules').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, module: { ...data, ...lockInfo(data) } });
  } catch(err) {
    res.status(500).json({ error: 'Failed to update lock.' });
  }
});

// ── Admin: Delete module ──────────────────────────────────────────────
router.delete('/admin/module/:id', adminMiddleware, async (req, res) => {
  try {
    await supabase.from('modules').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message || 'Failed to delete module.' });
  }
});

// ── Admin: Create lesson ──────────────────────────────────────────────
router.post('/admin/lesson', adminMiddleware, async (req, res) => {
  try {
    const { module_id, title, description, type, content_url, content_text,
            duration_minutes, points_reward, order_index, is_free_preview } = req.body;
    if (!module_id || !title) return res.status(400).json({ error: 'module_id and title are required.' });
    const { data, error } = await supabase.from('lessons').insert({
      module_id, title, description, type: type || 'video',
      content_url: content_url || null, content_text: content_text || null,
      duration_minutes: duration_minutes || 0,
      points_reward: points_reward || 10,
      order_index: order_index || 0,
      is_free_preview: is_free_preview || false,
      is_active: true
    }).select().single();
    if (error) throw error;
    res.json({ success: true, lesson: data });
  } catch(err) {
    console.error('Create lesson error:', err);
    res.status(500).json({ error: err.message || 'Failed to create lesson.' });
  }
});

// ── Admin: Update lesson (whitelisted) ───────────────────────────────
router.patch('/admin/lesson/:id', adminMiddleware, async (req, res) => {
  try {
    const allowed = ['title', 'description', 'type', 'content_url', 'content_text', 'duration_minutes',
                     'points_reward', 'order_index', 'is_free_preview', 'is_active'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    const { data, error } = await supabase.from('lessons')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, lesson: data });
  } catch(err) {
    res.status(500).json({ error: err.message || 'Failed to update lesson.' });
  }
});

// ── Admin: Delete lesson ──────────────────────────────────────────────
router.delete('/admin/lesson/:id', adminMiddleware, async (req, res) => {
  try {
    await supabase.from('lessons').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message || 'Failed to delete lesson.' });
  }
});

// ── Admin: Create assignment ──────────────────────────────────────────
router.post('/admin/assignment', adminMiddleware, async (req, res) => {
  try {
    const { module_id, title, description, instructions, due_days, max_score, points_reward } = req.body;
    if (!module_id || !title) return res.status(400).json({ error: 'module_id and title are required.' });
    const { data, error } = await supabase.from('assignments').insert({
      module_id, title, description, instructions,
      due_days: due_days || 7,
      max_score: max_score || 100,
      points_reward: points_reward || 20,
      is_active: true
    }).select().single();
    if (error) throw error;
    res.json({ success: true, assignment: data });
  } catch(err) {
    res.status(500).json({ error: err.message || 'Failed to create assignment.' });
  }
});

// ── Admin: Review a submission ────────────────────────────────────────
// body: { decision: 'approved' | 'needs_revision', grade: number (points), feedback: string }
//   approved        → status 'graded'   (+ assignment points_reward awarded ONCE)
//   needs_revision  → status 'returned' (fellow can resubmit)
router.patch('/admin/submission/:id/grade', adminMiddleware, async (req, res) => {
  try {
    const { decision, feedback } = req.body || {};
    if (!['approved', 'needs_revision'].includes(decision)) {
      return res.status(400).json({ error: "decision must be 'approved' or 'needs_revision'." });
    }

    const { data: sub } = await supabase.from('assignment_submissions')
      .select('*, assignments(title, max_score, points_reward)').eq('id', req.params.id).single();
    if (!sub) return res.status(404).json({ error: 'Submission not found.' });

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
      graded_by: req.admin.id, graded_by_type: 'admin',
    };

    // award assignment points exactly once, on first approval
    let awarded = 0;
    if (decision === 'approved' && !(sub.points_awarded > 0)) {
      awarded = sub.assignments?.points_reward || 0;
      if (awarded) updates.points_awarded = awarded;
    }

    const { data, error } = await supabase.from('assignment_submissions')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    if (awarded) await addPoints(sub.fellow_id, awarded);

    // in-app notification
    await safe(supabase.from('notifications').insert({
      fellow_id: sub.fellow_id,
      title: decision === 'approved' ? 'Assignment approved' : 'Revision needed',
      message: `"${sub.assignments?.title}" was reviewed${grade !== null ? ` — ${grade}/${max}` : ''}. ${decision === 'approved' ? 'Well done!' : 'Please revise and resubmit.'}`,
      type: decision === 'approved' ? 'success' : 'warning',
    }), 'notif');

    // email: only the one fellow, routed through the recipient resolver (activity email → respects opt-out)
    (async () => {
      const [fellow] = await resolveRecipients({ actorId: req.admin.id, actorType: 'admin', fellowIds: [sub.fellow_id], respectPrefs: true });
      if (fellow) {
        await sendToFellow('assignment_graded', fellow, {
          assignmentTitle: sub.assignments?.title, grade, maxScore: max,
          approved: decision === 'approved', feedback: cleanFeedback,
        });
      }
    })().catch(e => console.error('[grade email]', e.message));

    res.json({ success: true, submission: data, points_awarded: awarded });
  } catch(err) {
    console.error('Grade error:', err);
    res.status(500).json({ error: 'Failed to save review.' });
  }
});

// ── Admin: Create/update exam ─────────────────────────────────────────
router.post('/admin/exam', adminMiddleware, async (req, res) => {
  try {
    const { track_id, title, description, instructions, duration_minutes, pass_score, points_reward, questions } = req.body;
    if (!track_id || !title) return res.status(400).json({ error: 'track_id and title required.' });

    const { data: exam, error } = await supabase.from('exams').upsert({
      track_id, title, description, instructions,
      duration_minutes: duration_minutes || 60,
      pass_score: pass_score || 70,
      points_reward: points_reward || 50,
      is_active: true
    }, { onConflict: 'track_id' }).select().single();
    if (error) throw error;

    if (questions?.length) {
      await supabase.from('exam_questions').delete().eq('exam_id', exam.id);
      await supabase.from('exam_questions').insert(
        questions.map((q, i) => ({
          exam_id: exam.id,
          question: q.question,
          options: q.options,
          correct_answer: q.correct_answer,
          points: q.points || 1,
          order_index: i
        }))
      );
    }

    res.json({ success: true, exam });
  } catch(err) {
    console.error('Create exam error:', err);
    res.status(500).json({ error: err.message || 'Failed to create exam.' });
  }
});

// ── Admin: Get exam for a track ───────────────────────────────────────
router.get('/admin/exam/:trackId', adminMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('exams')
      .select('*, exam_questions(*)')
      .eq('track_id', req.params.trackId)
      .maybeSingle();
    res.json(data || null);
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// FELLOW ROUTES — wildcards AFTER all specific routes
// Locked modules answer 423 (not 403) so the frontend does not treat it as a logged-out session.
// ══════════════════════════════════════════════════════════════════════

// ── Get modules for a track (fellow) — lock state computed HERE ──────
router.get('/track/:trackId', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    const trackId = req.params.trackId;
    if (!isUuid(trackId)) return res.status(400).json({ error: 'Invalid track.' });
    if (!(await canAccessTrack(fellowId, trackId))) return res.status(403).json({ error: 'You do not have access to this track.' });

    processDueUnlocks(trackId); // lazy unlock emails (fire and forget, exactly-once via atomic claim)

    const { data: modules } = await supabase
      .from('modules')
      .select('*, lessons(*), assignments(*)')
      .eq('track_id', trackId)
      .eq('is_active', true)
      .order('order_index');

    const lessonIds = (modules || []).flatMap(m => (m.lessons || []).map(l => l.id));
    const progressByLesson = {};
    if (lessonIds.length) {
      const { data: prog } = await supabase.from('fellow_lesson_progress').select('*')
        .eq('fellow_id', fellowId).in('lesson_id', lessonIds);
      (prog || []).forEach(p => { progressByLesson[p.lesson_id] = p; });
    }

    const assignmentIds = (modules || []).flatMap(m => (m.assignments || []).map(a => a.id));
    const subs = {};
    if (assignmentIds.length) {
      const { data: rows } = await supabase.from('assignment_submissions')
        .select('id, assignment_id, submitted_at, grade, feedback, status, graded_at, content, file_url')
        .eq('fellow_id', fellowId).in('assignment_id', assignmentIds);
      (rows || []).forEach(r => { subs[r.assignment_id] = r; });
    }

    const now = new Date();
    const result = (modules || []).map(m => {
      const info = lockInfo(m, now);
      const lessons = (m.lessons || []).filter(l => l.is_active !== false)
        .sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
      const base = {
        id: m.id, track_id: m.track_id, title: m.title, description: m.description, order_index: m.order_index,
        unlock_at: m.unlock_at, deadline_at: m.deadline_at, ...info,
        lesson_count: lessons.length,
      };
      if (info.is_locked) {
        // Locked: no lesson content, no assignments — the frontend only renders what it is told.
        return { ...base, lessons: [], assignments: [] };
      }
      return {
        ...base,
        lessons: lessons.map(l => ({
          ...l,
          fellow_lesson_progress: progressByLesson[l.id] ? [progressByLesson[l.id]] : [],
        })),
        assignments: (m.assignments || []).filter(a => a.is_active !== false).map(a => ({
          id: a.id, title: a.title, description: a.description, instructions: a.instructions,
          max_score: a.max_score, points_reward: a.points_reward, due_days: a.due_days,
          deadline_at: assignmentDeadline(m, a), my_submission: subs[a.id] || null,
        })),
      };
    });

    res.json(result);
  } catch(err) {
    console.error('track modules error:', err);
    res.status(500).json({ error: 'Failed to fetch modules.' });
  }
});

// ── Get a lesson with content ─────────────────────────────────────────
router.get('/lesson/:lessonId', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    const { data: lesson } = await supabase
      .from('lessons').select('*, modules(title, track_id)')
      .eq('id', req.params.lessonId).single();
    if (!lesson || lesson.is_active === false) return res.status(404).json({ error: 'Lesson not found.' });

    const access = await loadAccessibleModule(fellowId, lesson.module_id);
    if (access.error) {
      return res.status(access.status).json({ error: access.error, locked: !!access.locked, unlocks_at: access.unlocks_at || null });
    }

    const { data: existing } = await supabase.from('fellow_lesson_progress').select('*')
      .eq('fellow_id', fellowId).eq('lesson_id', req.params.lessonId).maybeSingle();

    if (!existing) {
      await safe(supabase.from('fellow_lesson_progress').upsert({
        fellow_id: fellowId, lesson_id: req.params.lessonId, started_at: new Date(), completed: false,
      }, { onConflict: 'fellow_id,lesson_id' }), 'lesson start');
    }

    res.json({ ...lesson, progress: existing || null });
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch lesson.' });
  }
});

// ── Mark lesson complete (points awarded once) ────────────────────────
router.post('/lesson/:lessonId/complete', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    const { data: lesson } = await supabase
      .from('lessons').select('module_id, points_reward, is_active').eq('id', req.params.lessonId).single();
    if (!lesson || lesson.is_active === false) return res.status(404).json({ error: 'Lesson not found.' });

    const access = await loadAccessibleModule(fellowId, lesson.module_id);
    if (access.error) return res.status(access.status).json({ error: access.error, locked: !!access.locked });

    const { data: existing } = await supabase.from('fellow_lesson_progress').select('completed')
      .eq('fellow_id', fellowId).eq('lesson_id', req.params.lessonId).maybeSingle();
    if (existing?.completed) return res.json({ success: true, already_completed: true });

    await supabase.from('fellow_lesson_progress').upsert({
      fellow_id: fellowId, lesson_id: req.params.lessonId, completed: true, completed_at: new Date(),
    }, { onConflict: 'fellow_id,lesson_id' });

    if (lesson.points_reward) await addPoints(fellowId, lesson.points_reward);

    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to mark complete.' });
  }
});

// ── Get assignments for a module ──────────────────────────────────────
router.get('/:moduleId/assignments', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    if (!isUuid(req.params.moduleId)) return res.status(400).json({ error: 'Invalid module.' });
    const access = await loadAccessibleModule(fellowId, req.params.moduleId);
    if (access.error) return res.status(access.status).json({ error: access.error, locked: !!access.locked });

    const { data } = await supabase
      .from('assignments')
      .select('*, assignment_submissions(id, submitted_at, grade, feedback, status, fellow_id)')
      .eq('module_id', req.params.moduleId)
      .eq('is_active', true);

    const result = (data || []).map(a => ({
      ...a,
      deadline_at: assignmentDeadline(access.module, a),
      my_submission: (a.assignment_submissions || []).find(s => s.fellow_id === fellowId) || null,
      assignment_submissions: undefined
    }));
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch assignments.' });
  }
});

// ── Submit / resubmit assignment ──────────────────────────────────────
router.post('/:assignmentId/submit', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    if (!isUuid(req.params.assignmentId)) return res.status(400).json({ error: 'Invalid assignment.' });

    const content = req.body?.content ? String(req.body.content).slice(0, 20000) : null;
    const file_url = req.body?.file_url ? String(req.body.file_url).slice(0, 2000) : null;
    if (!content && !file_url) return res.status(400).json({ error: 'Add your answer or a link to your work.' });
    if (file_url && !/^https?:\/\//i.test(file_url)) return res.status(400).json({ error: 'The link must start with http:// or https://' });

    const { data: assignment } = await supabase.from('assignments')
      .select('id, module_id, is_active').eq('id', req.params.assignmentId).single();
    if (!assignment || assignment.is_active === false) return res.status(404).json({ error: 'Assignment not found.' });

    const access = await loadAccessibleModule(fellowId, assignment.module_id);
    if (access.error) return res.status(access.status).json({ error: access.error, locked: !!access.locked });

    const { data: existing } = await supabase.from('assignment_submissions').select('id, status')
      .eq('assignment_id', assignment.id).eq('fellow_id', fellowId).maybeSingle();
    if (existing?.status === 'graded') return res.status(400).json({ error: 'This assignment has already been approved.' });

    const { data, error } = await supabase.from('assignment_submissions').upsert({
      assignment_id: assignment.id, fellow_id: fellowId, content, file_url,
      submitted_at: new Date(), status: 'submitted',
      grade: null, feedback: null, graded_at: null, graded_by: null,
    }, { onConflict: 'assignment_id,fellow_id' }).select().single();
    if (error) throw error;
    res.json({ success: true, submission: data });
  } catch(err) {
    console.error('submit error:', err);
    res.status(500).json({ error: 'Failed to submit assignment.' });
  }
});

// ── Get track exam (fellow) ───────────────────────────────────────────
router.get('/exam/:trackId', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    if (!isUuid(req.params.trackId)) return res.status(400).json({ error: 'Invalid track.' });
    if (!(await canAccessTrack(fellowId, req.params.trackId))) return res.status(403).json({ error: 'You do not have access to this track.' });

    const { data: exam } = await supabase
      .from('exams')
      .select('id, title, description, duration_minutes, pass_score, instructions')
      .eq('track_id', req.params.trackId)
      .eq('is_active', true)
      .maybeSingle();
    if (!exam) return res.json(null);

    const { data: attempts } = await supabase
      .from('exam_attempts')
      .select('id, score, passed, started_at, completed_at')
      .eq('exam_id', exam.id)
      .eq('fellow_id', fellowId)
      .order('started_at', { ascending: false });

    const finished = (attempts || []).filter(a => a.completed_at);
    res.json({
      ...exam,
      my_attempt: finished[0] || null,
      attempts_used: finished.length,
      max_attempts: EXAM_MAX_ATTEMPTS || null,
    });
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch exam.' });
  }
});

// ── Start (or resume) an exam ─────────────────────────────────────────
router.post('/exam/:examId/start', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    if (!isUuid(req.params.examId)) return res.status(400).json({ error: 'Invalid exam.' });

    const { data: exam } = await supabase.from('exams')
      .select('id, track_id, duration_minutes, is_active').eq('id', req.params.examId).single();
    if (!exam || exam.is_active === false) return res.status(404).json({ error: 'Exam not found.' });
    if (!(await canAccessTrack(fellowId, exam.track_id))) return res.status(403).json({ error: 'You do not have access to this exam.' });

    const { data: attempts } = await supabase.from('exam_attempts')
      .select('id, passed, started_at, completed_at').eq('exam_id', exam.id).eq('fellow_id', fellowId);

    if ((attempts || []).some(a => a.passed)) return res.status(400).json({ error: 'You have already passed this exam.' });

    const durationMs = (exam.duration_minutes || 60) * 60 * 1000;
    const nowMs = Date.now();

    // close any open attempt whose time has fully run out (counts as a failed attempt)
    for (const a of (attempts || []).filter(x => !x.completed_at)) {
      if (nowMs > new Date(a.started_at).getTime() + durationMs + EXAM_GRACE_SECONDS * 1000) {
        await supabase.from('exam_attempts').update({ completed_at: new Date(), score: 0, passed: false }).eq('id', a.id);
        a.completed_at = new Date().toISOString();
      }
    }

    const questionsQ = () => supabase.from('exam_questions')
      .select('id, question, options, order_index').eq('exam_id', exam.id).order('order_index');

    // resume the open attempt instead of creating another
    const open = (attempts || []).find(a => !a.completed_at);
    if (open) {
      const { data: questions } = await questionsQ();
      return res.json({ questions: questions || [], attempt_id: open.id, expires_at: new Date(new Date(open.started_at).getTime() + durationMs).toISOString(), resumed: true });
    }

    const used = (attempts || []).length;
    if (EXAM_MAX_ATTEMPTS > 0 && used >= EXAM_MAX_ATTEMPTS) {
      return res.status(400).json({ error: `You have used all ${EXAM_MAX_ATTEMPTS} attempts for this exam. Contact your admin.` });
    }

    const { data: questions } = await questionsQ();
    if (!questions?.length) return res.status(400).json({ error: 'This exam has no questions yet.' });

    const startedAt = new Date();
    const { data: attempt, error } = await supabase.from('exam_attempts')
      .insert({ exam_id: exam.id, fellow_id: fellowId, started_at: startedAt }).select().single();
    if (error) throw error;

    res.json({ questions, attempt_id: attempt.id, expires_at: new Date(startedAt.getTime() + durationMs).toISOString() });
  } catch(err) {
    console.error('exam start:', err);
    res.status(500).json({ error: 'Failed to start exam.' });
  }
});

// ── Submit exam ───────────────────────────────────────────────────────
router.post('/exam/attempt/:attemptId/submit', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    const answers = req.body?.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return res.status(400).json({ error: 'Answers are required.' });

    const { data: attempt } = await supabase.from('exam_attempts')
      .select('id, exam_id, fellow_id, started_at, completed_at').eq('id', req.params.attemptId).single();
    // ownership: an attempt belongs to exactly one fellow
    if (!attempt || attempt.fellow_id !== fellowId) return res.status(404).json({ error: 'Attempt not found.' });
    if (attempt.completed_at) return res.status(400).json({ error: 'This attempt has already been submitted.' });

    const { data: exam } = await supabase.from('exams')
      .select('pass_score, points_reward, duration_minutes').eq('id', attempt.exam_id).single();

    const { data: questions } = await supabase.from('exam_questions')
      .select('id, correct_answer, points').eq('exam_id', attempt.exam_id);

    const durationMs = (exam?.duration_minutes || 60) * 60 * 1000;
    const timedOut = Date.now() > new Date(attempt.started_at).getTime() + durationMs + EXAM_GRACE_SECONDS * 1000;

    let earned = 0, total = 0;
    (questions || []).forEach(q => {
      total += (q.points || 1);
      if (!timedOut && String(answers[q.id] ?? '') === String(q.correct_answer)) earned += (q.points || 1);
    });

    const score = total > 0 ? Math.round((earned / total) * 100) : 0;
    const passScore = exam?.pass_score || 70;
    const passed = !timedOut && score >= passScore;

    // claim the attempt atomically so a double-submit can't award points twice
    const { data: claimed } = await supabase.from('exam_attempts')
      .update({ answers, score, passed, completed_at: new Date() })
      .eq('id', attempt.id).is('completed_at', null).select('id');
    if (!claimed?.length) return res.status(400).json({ error: 'This attempt has already been submitted.' });

    if (passed && exam?.points_reward) await addPoints(fellowId, exam.points_reward);

    res.json({ success: true, score, passed, pass_score: passScore, timed_out: timedOut });
  } catch(err) {
    console.error('exam submit:', err);
    res.status(500).json({ error: 'Failed to submit exam.' });
  }
});

// ── Wildcard /:moduleId — MUST be last ───────────────────────────────
router.get('/:moduleId', authMiddleware, async (req, res) => {
  try {
    if (!isUuid(req.params.moduleId)) return res.status(400).json({ error: 'Invalid module.' });
    const access = await loadAccessibleModule(req.user.id, req.params.moduleId);
    if (access.error) return res.status(access.status).json({ error: access.error, locked: !!access.locked, unlocks_at: access.unlocks_at || null });

    const { data: module } = await supabase
      .from('modules')
      .select('*, lessons(*)')
      .eq('id', req.params.moduleId)
      .single();
    if (module) {
      const ids = (module.lessons || []).map(l => l.id);
      const { data: prog } = ids.length
        ? await supabase.from('fellow_lesson_progress').select('*').eq('fellow_id', req.user.id).in('lesson_id', ids)
        : { data: [] };
      const by = {}; (prog || []).forEach(p => { by[p.lesson_id] = p; });
      module.lessons = (module.lessons || []).filter(l => l.is_active !== false)
        .map(l => ({ ...l, fellow_lesson_progress: by[l.id] ? [by[l.id]] : [] }));
    }
    res.json(module);
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch module.' });
  }
});

module.exports = router;
