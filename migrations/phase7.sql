-- Drix TalentHub — Phase 7 migration (Capstone Projects). Run ONCE in Supabase SQL editor.
-- Safe to re-run.

-- One row per track. Optional brief — if null, fellow sees a generic open-ended prompt.
CREATE TABLE IF NOT EXISTS capstones (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  track_id UUID REFERENCES tracks(id) UNIQUE,
  brief TEXT,
  points_reward INTEGER DEFAULT 100,
  -- 'code' -> repo link required; 'design' -> portfolio/design link required;
  -- 'document' -> report/case-study link required. Defaults to 'code' since most current
  -- tracks are code-based; admin can change per track.
  capstone_type TEXT DEFAULT 'code',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE capstones DISABLE ROW LEVEL SECURITY;

-- One row per fellow per track.
CREATE TABLE IF NOT EXISTS capstone_submissions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  track_id UUID REFERENCES tracks(id),
  fellow_id UUID REFERENCES fellows(id),
  title TEXT NOT NULL,
  description TEXT,
  repo_url TEXT,
  live_url TEXT,
  video_url TEXT,
  status TEXT DEFAULT 'submitted', -- submitted | graded | returned
  score_functionality INTEGER, -- 0-25 each
  score_technical INTEGER,
  score_presentation INTEGER,
  score_originality INTEGER,
  total_score INTEGER, -- sum of the four, 0-100
  grade TEXT, -- Pass | Merit | Distinction, computed from total_score
  feedback TEXT,
  points_awarded INTEGER DEFAULT 0,
  is_public BOOLEAN DEFAULT TRUE, -- auto-true on approval; admin can flip off to hide from showcase
  -- GitHub metadata (code-type tracks only) — fetched once on submission from GitHub's public API.
  -- Informational only: shown to the admin during review, never affects the score automatically.
  gh_commit_count INTEGER,
  gh_first_commit_at TIMESTAMPTZ,
  gh_last_commit_at TIMESTAMPTZ,
  gh_primary_language TEXT,
  gh_fetched_at TIMESTAMPTZ,
  graded_by UUID,
  graded_by_type TEXT DEFAULT 'admin',
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  graded_at TIMESTAMPTZ,
  UNIQUE(track_id, fellow_id)
);
ALTER TABLE capstone_submissions DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_capstone_status ON capstone_submissions(status);
