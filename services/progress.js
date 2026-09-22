// services/progress.js — module locking, track access, progress & certificate eligibility.
// Everything that decides "what may this fellow see / do" lives here so routes stay thin.

const supabase = require('../config/supabase');
const { resolveRecipients } = require('./recipients');
const { sendBulk } = require('./email');

const CERT_MIN_SCORE = 80;
const UNLOCK_EMAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // don't blast an "unlocked" email for something opened long ago

// ─── LOCKING ─────────────────────────────────────────────────────────
// isLocked = manual_lock === true OR (unlock_at !== null AND unlock_at > now())
function lockInfo(m, now = new Date()) {
  const unlockAt = m.unlock_at ? new Date(m.unlock_at) : null;
  if (m.manual_lock === true) return { is_locked: true, lock_reason: 'admin', unlocks_at: unlockAt ? unlockAt.toISOString() : null };
  if (unlockAt && unlockAt.getTime() > now.getTime()) return { is_locked: true, lock_reason: 'scheduled', unlocks_at: unlockAt.toISOString() };
  return { is_locked: false, lock_reason: null, unlocks_at: null };
}

// Effective deadline for an assignment: module deadline wins; otherwise unlock_at + due_days.
function assignmentDeadline(module, assignment) {
  if (module.deadline_at) return new Date(module.deadline_at).toISOString();
  if (module.unlock_at && assignment?.due_days) {
    return new Date(new Date(module.unlock_at).getTime() + assignment.due_days * 86400000).toISOString();
  }
  return null;
}

// ─── ACCESS ──────────────────────────────────────────────────────────
// A fellow may read a track's content if it is their current track or one they were enrolled in before.
async function canAccessTrack(fellowId, trackId) {
  if (!trackId) return false;
  const { data: f } = await supabase.from('fellows').select('track_id').eq('id', fellowId).single();
  if (f?.track_id === trackId) return true;
  const { data: h } = await supabase.from('fellow_track_history').select('id')
    .eq('fellow_id', fellowId).eq('track_id', trackId).limit(1);
  return !!(h && h.length);
}

// Load a module (with lock state) and check the fellow may access it. Returns { module, error, status, locked }.
async function loadAccessibleModule(fellowId, moduleId) {
  const { data: module } = await supabase.from('modules').select('*').eq('id', moduleId).single();
  if (!module || module.is_active === false) return { error: 'Module not found.', status: 404 };
  if (!(await canAccessTrack(fellowId, module.track_id))) return { error: 'You do not have access to this track.', status: 403 };
  const info = lockInfo(module);
  if (info.is_locked) return { module, ...info, locked: true, error: 'This module is locked.', status: 423 };
  return { module, ...info, locked: false };
}

// ─── UNLOCK EMAIL (lazy, exactly once) ───────────────────────────────
// Called on fellow requests. Atomically claims unlock_email_sent so concurrent requests can't double-send.
async function processDueUnlocks(trackId) {
  try {
    const nowIso = new Date().toISOString();
    const { data: due } = await supabase.from('modules')
      .select('id, title, unlock_at, deadline_at, manual_lock')
      .eq('track_id', trackId).eq('is_active', true)
      .eq('unlock_email_sent', false).eq('manual_lock', false)
      .not('unlock_at', 'is', null).lte('unlock_at', nowIso);

    for (const m of due || []) {
      const { data: claimed } = await supabase.from('modules')
        .update({ unlock_email_sent: true })
        .eq('id', m.id).eq('unlock_email_sent', false).select('id');
      if (!claimed || !claimed.length) continue; // someone else claimed it

      const age = Date.now() - new Date(m.unlock_at).getTime();
      if (age > UNLOCK_EMAIL_MAX_AGE_MS) continue; // opened long ago — mark sent, don't email

      const recipients = await resolveRecipients({ actorType: 'admin', audience: 'track', trackId, respectPrefs: true });
      // fire and forget
      sendBulk('module_unlocked', recipients, { title: m.title, deadline: m.deadline_at })
        .catch(e => console.error('[unlock email]', e.message));
    }
  } catch (err) {
    console.error('[processDueUnlocks]', err.message);
  }
}

// ─── PROGRESS ────────────────────────────────────────────────────────
// Full picture of a fellow's track: modules (with lock state), lessons, assignments, my progress & submissions.
async function loadTrackState(fellowId, trackId) {
  const { data: modules } = await supabase.from('modules')
    .select('id, title, description, order_index, unlock_at, deadline_at, manual_lock, lessons(id, title, type, order_index, is_active), assignments(id, title, due_days, max_score, points_reward, is_active)')
    .eq('track_id', trackId).eq('is_active', true).order('order_index');

  const lessonIds = (modules || []).flatMap(m => (m.lessons || []).filter(l => l.is_active !== false).map(l => l.id));
  const assignmentIds = (modules || []).flatMap(m => (m.assignments || []).filter(a => a.is_active !== false).map(a => a.id));

  let doneSet = new Set();
  if (lessonIds.length) {
    const { data: prog } = await supabase.from('fellow_lesson_progress').select('lesson_id')
      .eq('fellow_id', fellowId).eq('completed', true).in('lesson_id', lessonIds);
    doneSet = new Set((prog || []).map(p => p.lesson_id));
  }
  const subs = {};
  if (assignmentIds.length) {
    const { data: rows } = await supabase.from('assignment_submissions')
      .select('id, assignment_id, status, grade, feedback, submitted_at, graded_at')
      .eq('fellow_id', fellowId).in('assignment_id', assignmentIds);
    (rows || []).forEach(r => { subs[r.assignment_id] = r; });
  }

  const now = new Date();
  const state = (modules || []).map(m => {
    const lessons = (m.lessons || []).filter(l => l.is_active !== false).sort((a, b) => (a.order_index || 0) - (b.order_index || 0));
    const assignments = (m.assignments || []).filter(a => a.is_active !== false);
    return {
      ...m, ...lockInfo(m, now),
      lessons: lessons.map(l => ({ ...l, done: doneSet.has(l.id) })),
      assignments: assignments.map(a => ({ ...a, deadline_at: assignmentDeadline(m, a), submission: subs[a.id] || null })),
    };
  });

  const total = lessonIds.length;
  const done = lessonIds.filter(id => doneSet.has(id)).length;
  return { modules: state, totalLessons: total, doneLessons: done, percent: total ? Math.round((done / total) * 100) : 0 };
}

// Active exam for a track (only counts if it has questions)
async function getExamState(fellowId, trackId) {
  const { data: exam } = await supabase.from('exams').select('id, title, is_active, exam_questions(id)')
    .eq('track_id', trackId).eq('is_active', true).maybeSingle();
  if (!exam || !(exam.exam_questions || []).length) return { required: false, passed: false, exam: null };
  const { data: passed } = await supabase.from('exam_attempts').select('id')
    .eq('exam_id', exam.id).eq('fellow_id', fellowId).eq('passed', true).limit(1);
  return { required: true, passed: !!(passed && passed.length), exam: { id: exam.id, title: exam.title } };
}

// Certificate eligibility: >= 80% lesson completion AND (if the track has an exam) the exam passed.
async function getEligibility(fellowId, precomputed = null) {
  const { data: fellow } = await supabase.from('fellows').select('track_id, tracks(name)').eq('id', fellowId).single();
  if (!fellow?.track_id) return { eligible: false, reason: 'No track assigned.' };

  const st = precomputed || await loadTrackState(fellowId, fellow.track_id);
  if (st.totalLessons === 0) return { eligible: false, reason: 'No lessons added to this track yet.' };

  const exam = await getExamState(fellowId, fellow.track_id);
  const { data: certs } = await supabase.from('certificates').select('id').eq('fellow_id', fellowId).eq('track_id', fellow.track_id).limit(1);
  const { data: reqs } = await supabase.from('certificate_requests').select('id, status')
    .eq('fellow_id', fellowId).eq('track_id', fellow.track_id).in('status', ['pending', 'approved']).limit(1);

  const hasCert = !!(certs && certs.length);
  const pending = reqs && reqs[0];
  const scoreOk = st.percent >= CERT_MIN_SCORE;
  const examOk = !exam.required || exam.passed;

  return {
    eligible: scoreOk && examOk && !hasCert && !pending,
    score: st.percent, completed: st.doneLessons, total: st.totalLessons,
    has_certificate: hasCert, has_pending_request: !!pending, pending_status: pending?.status || null,
    track_id: fellow.track_id, track_name: fellow.tracks?.name, minimum_score: CERT_MIN_SCORE,
    exam_required: exam.required, exam_passed: exam.passed,
    reason: !scoreOk ? `You need at least ${CERT_MIN_SCORE}% lesson completion.` : !examOk ? 'You need to pass the track exam.' : null,
  };
}

// ─── DO THIS NEXT ────────────────────────────────────────────────────
// First match wins:
// 1 ungraded assignment due in the next 7 days (or overdue)  2 next incomplete lesson in the current open module
// 3 returned assignment needing resubmission                 4 exam (all modules complete, not passed)
// 5 certificate request (eligible)                            6 caught up
async function computeNextAction(fellowId, trackId, now = new Date()) {
  const st = await loadTrackState(fellowId, trackId);
  const open = st.modules.filter(m => !m.is_locked);
  const horizon = now.getTime() + 7 * 86400000;

  // 1 — unsubmitted assignments with a deadline inside 7 days (overdue included), soonest first
  const urgent = [];
  open.forEach(m => m.assignments.forEach(a => {
    if (a.submission) return; // submitted / graded / returned handled elsewhere
    if (!a.deadline_at) return;
    const t = new Date(a.deadline_at).getTime();
    if (t <= horizon) urgent.push({ m, a, t });
  }));
  urgent.sort((x, y) => x.t - y.t);
  if (urgent.length) {
    const { m, a, t } = urgent[0];
    return {
      type: 'assignment', title: a.title, subtitle: m.title, deadline: a.deadline_at,
      overdue: t < now.getTime(),
      action_url: `/dashboard/courses?module=${m.id}&assignment=${a.id}`, action_label: 'View assignment',
    };
  }

  // 2 — next incomplete lesson in the first open module that still has one
  for (const m of open) {
    const next = m.lessons.find(l => !l.done);
    if (next) {
      return {
        type: 'lesson', title: next.title, subtitle: m.title, deadline: m.deadline_at || null,
        action_url: `/dashboard/courses?lesson=${next.id}`, action_label: 'Continue learning',
      };
    }
  }

  // 3 — returned assignment
  for (const m of open) {
    const a = m.assignments.find(x => x.submission?.status === 'returned');
    if (a) {
      return {
        type: 'resubmit', title: a.title, subtitle: m.title, deadline: a.deadline_at,
        action_url: `/dashboard/courses?module=${m.id}&assignment=${a.id}`, action_label: 'Revise and resubmit',
      };
    }
  }

  // 4 — exam, once every module (locked ones included) has all lessons complete
  const allComplete = st.modules.length > 0 && st.modules.every(m => m.lessons.every(l => l.done));
  const exam = await getExamState(fellowId, trackId);
  if (allComplete && exam.required && !exam.passed) {
    return { type: 'exam', title: exam.exam.title, subtitle: 'Track exam', deadline: null, action_url: '/dashboard/courses#exam', action_label: 'Take the exam' };
  }

  // 5 — certificate
  const elig = await getEligibility(fellowId, st);
  if (elig.eligible) {
    return { type: 'certificate', title: 'Request your certificate', subtitle: `${elig.score}% complete`, deadline: null, action_url: '/dashboard/certificates', action_label: 'Request certificate' };
  }

  // 6 — caught up (tell them what's coming next if a module is scheduled)
  const upcoming = st.modules.filter(m => m.is_locked && m.unlocks_at && m.lock_reason === 'scheduled')
    .sort((a, b) => new Date(a.unlocks_at) - new Date(b.unlocks_at))[0];
  return {
    type: 'caught_up', title: "You're all caught up",
    subtitle: upcoming ? `Next up: ${upcoming.title}` : 'Nothing is due right now. Nice work.',
    deadline: null, next_unlock_at: upcoming?.unlocks_at || null, action_url: null, action_label: null,
  };
}

module.exports = {
  CERT_MIN_SCORE, lockInfo, assignmentDeadline, canAccessTrack, loadAccessibleModule,
  processDueUnlocks, loadTrackState, getExamState, getEligibility, computeNextAction,
};
