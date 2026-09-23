-- Drix TalentHub — Phase 3 migration (Check-ins, Badges, Portfolio). Run ONCE in Supabase SQL editor.
-- Safe to re-run.

-- WEEKLY CHECK-INS
CREATE TABLE IF NOT EXISTS weekly_checkins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fellow_id UUID NOT NULL REFERENCES fellows(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,                 -- Monday of the week, UTC
  confidence_rating SMALLINT NOT NULL CHECK (confidence_rating BETWEEN 1 AND 5),
  hours_studied NUMERIC(5,1) DEFAULT 0 CHECK (hours_studied >= 0 AND hours_studied <= 168),
  needs_help BOOLEAN DEFAULT FALSE,
  note TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fellow_id, week_start)
);
ALTER TABLE weekly_checkins DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_checkins_fellow ON weekly_checkins(fellow_id);
CREATE INDEX IF NOT EXISTS idx_checkins_week ON weekly_checkins(week_start);

-- BADGES (point-threshold badges auto-computed — no table needed for definitions,
-- but we store which ones a fellow has already been notified about, so we don't
-- spam a "badge earned" notification every time /me is loaded).
CREATE TABLE IF NOT EXISTS fellow_badges (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fellow_id UUID NOT NULL REFERENCES fellows(id) ON DELETE CASCADE,
  badge_key TEXT NOT NULL,                  -- e.g. 'points_100', 'points_500', 'streak_4wk'
  earned_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fellow_id, badge_key)
);
ALTER TABLE fellow_badges DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_badges_fellow ON fellow_badges(fellow_id);

-- PORTFOLIO
ALTER TABLE assignment_submissions ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_submissions_public ON assignment_submissions(is_public) WHERE is_public = TRUE;
-- A fellow needs a public-facing slug to share their portfolio without exposing their UUID.
ALTER TABLE fellows ADD COLUMN IF NOT EXISTS portfolio_slug TEXT UNIQUE;
ALTER TABLE fellows ADD COLUMN IF NOT EXISTS portfolio_public BOOLEAN DEFAULT FALSE;
