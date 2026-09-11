// routes/modules.js
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// ══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — must be BEFORE wildcard /:moduleId
// ══════════════════════════════════════════════════════════════════════

// ── Admin: Get all modules for a track ───────────────────────────────
router.get('/admin/track/:trackId', adminMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('modules')
      .select('*, lessons(*), assignments(*, assignment_submissions(id, grade, status))')
      .eq('track_id', req.params.trackId)
      .order('order_index');
    res.json(data || []);
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ── Admin: Create module ──────────────────────────────────────────────
router.post('/admin/module', adminMiddleware, async (req, res) => {
  try {
    const { track_id, title, description, order_index } = req.body;
    if (!track_id || !title) return res.status(400).json({ error: 'track_id and title are required.' });
    const { data, error } = await supabase.from('modules').insert({
      track_id, title, description, order_index: order_index || 0, is_active: true
    }).select().single();
    if (error) throw error;
    res.json({ success: true, module: data });
  } catch(err) {
    console.error('Create module error:', err);
    res.status(500).json({ error: 'Failed to create module.' });
  }
});

// ── Admin: Update module ──────────────────────────────────────────────
router.patch('/admin/module/:id', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('modules')
      .update(req.body).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, module: data });
  } catch(err) {
    res.status(500).json({ error: 'Failed to update module.' });
  }
});

// ── Admin: Delete module ──────────────────────────────────────────────
router.delete('/admin/module/:id', adminMiddleware, async (req, res) => {
  try {
    await supabase.from('modules').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to delete module.' });
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
    res.status(500).json({ error: 'Failed to create lesson.' });
  }
});

// ── Admin: Update lesson ──────────────────────────────────────────────
router.patch('/admin/lesson/:id', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from('lessons')
      .update(req.body).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, lesson: data });
  } catch(err) {
    res.status(500).json({ error: 'Failed to update lesson.' });
  }
});

// ── Admin: Delete lesson ──────────────────────────────────────────────
router.delete('/admin/lesson/:id', adminMiddleware, async (req, res) => {
  try {
    await supabase.from('lessons').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to delete lesson.' });
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
    res.status(500).json({ error: 'Failed to create assignment.' });
  }
});

// ── Admin: Grade assignment submission ────────────────────────────────
router.patch('/admin/submission/:id/grade', adminMiddleware, async (req, res) => {
  try {
    const { grade, feedback } = req.body;
    const { data, error } = await supabase.from('assignment_submissions')
      .update({ grade, feedback, status: 'graded', graded_at: new Date() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, submission: data });
  } catch(err) {
    res.status(500).json({ error: 'Failed to grade submission.' });
  }
});

// ── Admin: Create/update exam ─────────────────────────────────────────
router.post('/admin/exam', adminMiddleware, async (req, res) => {
  try {
    const { track_id, title, description, instructions, duration_minutes, pass_score, points_reward, questions } = req.body;
    if (!track_id || !title) return res.status(400).json({ error: 'track_id and title required.' });

    // Upsert exam (one exam per track)
    const { data: exam, error } = await supabase.from('exams').upsert({
      track_id, title, description, instructions,
      duration_minutes: duration_minutes || 60,
      pass_score: pass_score || 70,
      points_reward: points_reward || 50,
      is_active: true
    }, { onConflict: 'track_id' }).select().single();
    if (error) throw error;

    // Replace questions if provided
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
    res.status(500).json({ error: 'Failed to create exam.' });
  }
});

// ── Admin: Get exam for a track ───────────────────────────────────────
router.get('/admin/exam/:trackId', adminMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('exams')
      .select('*, exam_questions(*)')
      .eq('track_id', req.params.trackId)
      .single();
    res.json(data || null);
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// FELLOW ROUTES — wildcards AFTER all specific routes
// ══════════════════════════════════════════════════════════════════════

// ── Get modules for a track (fellow) ─────────────────────────────────
router.get('/track/:trackId', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    const { data: modules } = await supabase
      .from('modules')
      .select('*, lessons(*, fellow_lesson_progress(*))')
      .eq('track_id', req.params.trackId)
      .eq('is_active', true)
      .order('order_index');

    // Filter progress to only this fellow's
    const result = (modules || []).map(m => ({
      ...m,
      lessons: (m.lessons || []).map(l => ({
        ...l,
        fellow_lesson_progress: (l.fellow_lesson_progress || []).filter(p => p.fellow_id === fellowId)
      }))
    }));

    res.json(result);
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch modules.' });
  }
});

// ── Get a lesson with content ─────────────────────────────────────────
router.get('/lesson/:lessonId', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    const { data: lesson } = await supabase
      .from('lessons')
      .select('*, modules(title, track_id)')
      .eq('id', req.params.lessonId)
      .single();
    if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });

    const { data: progress } = await supabase
      .from('fellow_lesson_progress')
      .select('*')
      .eq('fellow_id', fellowId)
      .eq('lesson_id', req.params.lessonId)
      .single();

    // Mark as started
    await supabase.from('fellow_lesson_progress').upsert({
      fellow_id: fellowId,
      lesson_id: req.params.lessonId,
      started_at: new Date(),
      completed: progress?.completed || false
    }, { onConflict: 'fellow_id,lesson_id' });

    res.json({ ...lesson, progress: progress || null });
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch lesson.' });
  }
});

// ── Mark lesson complete ──────────────────────────────────────────────
router.post('/lesson/:lessonId/complete', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    const { data: lesson } = await supabase
      .from('lessons').select('points_reward').eq('id', req.params.lessonId).single();

    await supabase.from('fellow_lesson_progress').upsert({
      fellow_id: fellowId,
      lesson_id: req.params.lessonId,
      completed: true,
      completed_at: new Date()
    }, { onConflict: 'fellow_id,lesson_id' });

    // Award points
    if (lesson?.points_reward) {
      await supabase.rpc('increment_points', {
        fellow_id: fellowId,
        amount: lesson.points_reward
      }).catch(async () => {
        const { data: f } = await supabase.from('fellows').select('points').eq('id', fellowId).single();
        await supabase.from('fellows').update({ points: (f?.points || 0) + lesson.points_reward }).eq('id', fellowId);
      });
    }

    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed to mark complete.' });
  }
});

// ── Get assignments for a module ──────────────────────────────────────
router.get('/:moduleId/assignments', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    const { data } = await supabase
      .from('assignments')
      .select('*, assignment_submissions(id, submitted_at, grade, feedback, status, fellow_id)')
      .eq('module_id', req.params.moduleId)
      .eq('is_active', true);

    const result = (data || []).map(a => ({
      ...a,
      my_submission: (a.assignment_submissions || []).find(s => s.fellow_id === fellowId) || null,
      assignment_submissions: undefined
    }));
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch assignments.' });
  }
});

// ── Submit assignment ─────────────────────────────────────────────────
router.post('/:assignmentId/submit', authMiddleware, async (req, res) => {
  try {
    const { content, file_url } = req.body;
    const fellowId = req.user.id;
    const { data, error } = await supabase.from('assignment_submissions').upsert({
      assignment_id: req.params.assignmentId,
      fellow_id: fellowId,
      content: content || null,
      file_url: file_url || null,
      submitted_at: new Date(),
      status: 'submitted'
    }, { onConflict: 'assignment_id,fellow_id' }).select().single();
    if (error) throw error;
    res.json({ success: true, submission: data });
  } catch(err) {
    res.status(500).json({ error: 'Failed to submit assignment.' });
  }
});

// ── Get track exam (fellow) ───────────────────────────────────────────
router.get('/exam/:trackId', authMiddleware, async (req, res) => {
  try {
    const { data: exam } = await supabase
      .from('exams')
      .select('id, title, description, duration_minutes, pass_score, instructions')
      .eq('track_id', req.params.trackId)
      .eq('is_active', true)
      .single();
    if (!exam) return res.json(null);

    const { data: attempt } = await supabase
      .from('exam_attempts')
      .select('id, score, passed, completed_at')
      .eq('exam_id', exam.id)
      .eq('fellow_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    res.json({ ...exam, my_attempt: attempt || null });
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch exam.' });
  }
});

// ── Start exam ────────────────────────────────────────────────────────
router.post('/exam/:examId/start', authMiddleware, async (req, res) => {
  try {
    const fellowId = req.user.id;
    const { data: attempts } = await supabase
      .from('exam_attempts')
      .select('id, passed')
      .eq('exam_id', req.params.examId)
      .eq('fellow_id', fellowId);

    if (attempts?.some(a => a.passed)) return res.status(400).json({ error: 'You have already passed this exam.' });

    const { data: questions } = await supabase
      .from('exam_questions')
      .select('id, question, options, order_index')
      .eq('exam_id', req.params.examId)
      .order('order_index');

    const { data: attempt } = await supabase
      .from('exam_attempts')
      .insert({ exam_id: req.params.examId, fellow_id: fellowId, started_at: new Date() })
      .select().single();

    res.json({ questions: questions || [], attempt_id: attempt.id });
  } catch(err) {
    res.status(500).json({ error: 'Failed to start exam.' });
  }
});

// ── Submit exam ───────────────────────────────────────────────────────
router.post('/exam/attempt/:attemptId/submit', authMiddleware, async (req, res) => {
  try {
    const { answers } = req.body;
    const fellowId = req.user.id;

    const { data: attempt } = await supabase
      .from('exam_attempts').select('exam_id').eq('id', req.params.attemptId).single();

    const { data: exam } = await supabase
      .from('exams').select('pass_score, points_reward').eq('id', attempt.exam_id).single();

    const { data: questions } = await supabase
      .from('exam_questions').select('id, correct_answer, points').eq('exam_id', attempt.exam_id);

    let earned = 0, total = 0;
    (questions || []).forEach(q => {
      total += (q.points || 1);
      if (answers[q.id] === q.correct_answer) earned += (q.points || 1);
    });

    const score = total > 0 ? Math.round((earned / total) * 100) : 0;
    const passed = score >= (exam?.pass_score || 70);

    await supabase.from('exam_attempts').update({
      answers, score, passed, completed_at: new Date()
    }).eq('id', req.params.attemptId);

    if (passed && exam?.points_reward) {
      const { data: f } = await supabase.from('fellows').select('points').eq('id', fellowId).single();
      await supabase.from('fellows').update({ points: (f?.points || 0) + exam.points_reward }).eq('id', fellowId);
    }

    res.json({ success: true, score, passed, pass_score: exam?.pass_score || 70 });
  } catch(err) {
    res.status(500).json({ error: 'Failed to submit exam.' });
  }
});

// ── Wildcard /:moduleId — MUST be last ───────────────────────────────
router.get('/:moduleId', authMiddleware, async (req, res) => {
  try {
    const { data: module } = await supabase
      .from('modules')
      .select('*, lessons(*, fellow_lesson_progress(*))')
      .eq('id', req.params.moduleId)
      .single();
    res.json(module);
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch module.' });
  }
});

module.exports = router;
