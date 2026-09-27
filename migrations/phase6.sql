-- Drix TalentHub — Phase 6 migration (3MTT integration fields). Run ONCE in Supabase SQL editor.
-- Safe to re-run.

ALTER TABLE fellows ADD COLUMN IF NOT EXISTS mtt_id TEXT;
CREATE INDEX IF NOT EXISTS idx_fellows_mtt_id ON fellows(mtt_id) WHERE mtt_id IS NOT NULL;

-- Pre-vetted 3MTT roster, loaded by admin from the ministry's official cohort list. A fellow's
-- typed 3MTT ID only links to their account if it matches a roster row AND their account email
-- matches the expected email too — that email check is what actually stops one fellow from
-- claiming someone else's government-issued ID.
CREATE TABLE IF NOT EXISTS mtt_roster (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  mtt_id TEXT UNIQUE NOT NULL,
  expected_name TEXT NOT NULL,
  expected_email TEXT NOT NULL,
  assigned_track TEXT,
  matched_fellow_id UUID REFERENCES fellows(id) ON DELETE SET NULL,
  matched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE mtt_roster DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_mtt_roster_email ON mtt_roster(expected_email);
